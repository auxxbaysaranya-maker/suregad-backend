import type { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { Business, SellerProfile, type ShowroomStatus } from "../models/profiles.model";
import { User } from "../models/user.model";
import { Subscription, SubscriptionPlan } from "../models/commerce.model";
import { Product } from "../models/catalog.model";
import { nextCode } from "../models/showroom.model";
import { AppError, forbidden, notFound, unauthenticated } from "../common/errors";
import { encryptSecret, lastDigits, randomId, slugify } from "../common/crypto";
import { addDays } from "../common/time";
import { mediaUrl } from "../integrations/storage";
import { notify } from "./notification.service";
import { audit } from "./audit.service";

export type ShowroomDoc = InstanceType<typeof Business>;

declare module "express-serve-static-core" {
  interface Request {
    showroom?: ShowroomDoc;
  }
}

/** Legacy records used "pending" for a submitted application. */
export function showroomStatus(business: { verificationStatus?: string | null } | null | undefined): ShowroomStatus | "none" {
  if (!business) return "none";
  const status = business.verificationStatus || "draft";
  return (status === "pending" ? "submitted" : status) as ShowroomStatus;
}

export const EDITABLE_STATUSES: ShowroomStatus[] = ["draft", "info_required", "rejected"];

/** The signed-in owner's showroom. The id always comes from the session, never from the request. */
export async function findOwnShowroom(userId: unknown) {
  return Business.findOne({ ownerId: userId, deletedAt: null }).sort({ createdAt: 1 });
}

/** Loads the caller's showroom into req.showroom (any status). */
export async function requireShowroom(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.user) throw unauthenticated();
    const business = await findOwnShowroom(req.user._id);
    if (!business) throw new AppError(404, "NO_SHOWROOM", "Start your showroom application first.");
    req.showroom = business;
    next();
  } catch (error) {
    next(error);
  }
}

/** Checked on every request: suspended, revoked or unapproved showrooms can't use seller operations. */
export async function requireApprovedShowroom(req: Request, res: Response, next: NextFunction) {
  await requireShowroom(req, res, (error?: unknown) => {
    if (error) return next(error);
    const status = showroomStatus(req.showroom);
    if (status === "approved") return next();
    const messages: Record<string, string> = {
      suspended: "Your showroom is suspended. Contact SureGad support.",
      revoked: "Your showroom's seller access was revoked.",
      rejected: "Your showroom application was rejected. Update it and submit again.",
      info_required: "SureGad needs more information before approving your showroom.",
    };
    next(new AppError(403, "SHOWROOM_NOT_APPROVED", messages[status] || "Your showroom is waiting for SureGad approval.", { status }));
  });
}

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal("").transform(() => undefined));

export const applicationSchema = z.object({
  owner: z
    .object({
      name: optionalText(80),
      email: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
      mobile: optionalText(20),
      alternatePhone: optionalText(20),
    })
    .partial()
    .optional(),
  name: optionalText(120),
  businessType: z.enum(["proprietorship", "partnership", "llp", "private_limited", "public_limited", "other"]).optional(),
  description: optionalText(4000),
  yearEstablished: z.number().int().min(1950).max(new Date().getFullYear()).optional(),
  email: z.string().trim().email().optional().or(z.literal("").transform(() => undefined)),
  phone: optionalText(20),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Enter a valid 10-character PAN.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  registrationNumber: optionalText(60),
  address: z
    .object({
      line1: optionalText(160),
      line2: optionalText(160),
      city: optionalText(80),
      district: optionalText(80),
      state: optionalText(80),
      pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, "Enter a 6-digit PIN code.").optional().or(z.literal("").transform(() => undefined)),
      coordinates: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
    })
    .partial()
    .optional(),
  hours: optionalText(200),
  profile: z
    .object({
      categories: z.array(z.enum(["smartphones", "laptops", "tablets", "accessories", "smartwatches"])).max(10),
      brands: z.array(z.string().trim().min(1).max(40)).max(40),
      conditions: z.array(z.enum(["new", "used", "refurbished"])).max(3),
      physicalShowroom: z.boolean(),
    })
    .partial()
    .optional(),
  social: z
    .object({
      website: optionalText(200),
      instagram: optionalText(200),
      facebook: optionalText(200),
      youtube: optionalText(200),
      x: optionalText(200),
      whatsapp: optionalText(20),
    })
    .partial()
    .optional(),
  logoKey: optionalText(300),
  bannerKey: optionalText(300),
  onboardingStep: z.number().int().min(0).max(10).optional(),
});

export const DOCUMENT_KINDS = ["gst_certificate", "pan_card", "trade_license", "owner_id", "address_proof", "shop_photo", "bank_proof", "other"] as const;
const REQUIRED_DOCUMENTS: (typeof DOCUMENT_KINDS)[number][] = ["owner_id", "address_proof"];

/** Fields and documents that must be present before an application can be submitted. */
export function missingForSubmission(business: ShowroomDoc): string[] {
  const missing: string[] = [];
  const need = (ok: unknown, label: string) => {
    if (!ok) missing.push(label);
  };
  need(business.owner?.name, "Owner name");
  need(business.owner?.email, "Owner email");
  need(business.owner?.mobile, "Owner mobile");
  need(business.name, "Business name");
  need(business.businessType, "Business type");
  need(business.phone, "Business phone");
  need(business.email, "Business email");
  need(business.gstin || business.pan, "GSTIN or PAN");
  need(business.address?.line1, "Address line");
  need(business.address?.city, "City");
  need(business.address?.district, "District");
  need(business.address?.pincode, "PIN code");
  need(business.location?.coordinates?.length === 2, "Map location");
  need(business.profile?.categories?.length, "Product categories");
  need(business.profile?.conditions?.length, "Device conditions you sell");
  const kinds = new Set((business.documents || []).map((doc) => doc.kind));
  for (const kind of REQUIRED_DOCUMENTS) need(kinds.has(kind), `Document: ${kind.replace(/_/g, " ")}`);
  need(kinds.has("gst_certificate") || kinds.has("trade_license") || kinds.has("pan_card"), "Document: GST certificate, trade licence or PAN card");
  return missing;
}

export async function saveApplication(req: Request, body: unknown) {
  const input = applicationSchema.parse(body);
  const user = req.user!;
  let business = await findOwnShowroom(user._id);
  if (business && !EDITABLE_STATUSES.includes(showroomStatus(business) as ShowroomStatus)) {
    throw new AppError(409, "APPLICATION_LOCKED", "Your application is with SureGad for review. Use Business profile to request changes.");
  }
  for (const key of [input.logoKey, input.bannerKey]) {
    if (key && (key.includes("..") || !key.startsWith("public/business_") || !key.includes(`/${String(user._id)}/`))) {
      throw new AppError(400, "INVALID_IMAGE", "Upload the image again from this account.");
    }
  }
  if (!business) {
    const name = input.name || user.displayName || "My showroom";
    business = new Business({
      ownerId: user._id,
      name,
      slug: `${slugify(name) || "showroom"}-${randomId(3).toLowerCase()}`,
      verificationStatus: "draft",
      owner: { name: user.displayName, email: user.email || undefined },
      statusHistory: [{ status: "draft", note: "Application started", by: user._id }],
    });
    const account = await User.findById(user._id);
    if (account && !account.roles.includes("business_seller")) {
      account.roles.push("business_seller");
      await account.save();
    }
  }
  const { address, owner, profile, social, ...rest } = input;
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) business.set(key, value);
  if (owner) for (const [key, value] of Object.entries(owner)) business.set(`owner.${key}`, value);
  if (profile) for (const [key, value] of Object.entries(profile)) if (value !== undefined) business.set(`profile.${key}`, value);
  if (social) for (const [key, value] of Object.entries(social)) business.set(`social.${key}`, value);
  if (address) {
    const { coordinates, ...lines } = address;
    for (const [key, value] of Object.entries(lines)) business.set(`address.${key}`, value);
    if (!business.address?.state) business.set("address.state", "Kerala");
    if (coordinates) {
      business.set("address.coordinates", coordinates);
      business.set("location", { type: "Point", coordinates: [coordinates.lng, coordinates.lat] });
    }
  }
  if (input.name && showroomStatus(business) === "draft") business.slug = `${slugify(input.name) || "showroom"}-${String(business._id).slice(-4)}`;
  await business.save();
  return business;
}

export async function submitApplication(req: Request) {
  if (req.emailVerified === false) throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address before submitting. Check your inbox for the link.");
  const business = await findOwnShowroom(req.user!._id);
  if (!business) throw notFound("Start your application first.");
  const status = showroomStatus(business);
  if (!EDITABLE_STATUSES.includes(status as ShowroomStatus)) throw new AppError(409, "ALREADY_SUBMITTED", "This application is already with SureGad.");
  const missing = missingForSubmission(business);
  if (missing.length) throw new AppError(400, "APPLICATION_INCOMPLETE", `Complete these before submitting: ${missing.join(", ")}.`, { missing });
  if (!business.code) business.code = await nextCode("SH");
  business.verificationStatus = "submitted";
  business.submittedAt = new Date();
  business.statusHistory.push({ status: "submitted", note: status === "draft" ? "Application submitted" : "Application resubmitted", by: req.user!._id as never, at: new Date() });
  await business.save();
  await audit(req, "showroom.submitted", "Business", String(business._id), { code: business.code });
  const admins = await User.find({ roles: "super_admin", status: "active" }).select("_id");
  await Promise.all(
    admins.map((admin) =>
      notify({
        userId: String(admin._id),
        event: "showroom.submitted",
        title: "Showroom application",
        body: `${business.name} (${business.code}) is waiting for review.`,
        data: { businessId: String(business._id) },
      }),
    ),
  );
  return business;
}

/** Review actions and the statuses each one may start from. */
export const REVIEW_ACTIONS: Record<string, { from: ShowroomStatus[]; to: ShowroomStatus; needsNote?: boolean }> = {
  start_review: { from: ["submitted"], to: "under_review" },
  request_info: { from: ["submitted", "under_review"], to: "info_required", needsNote: true },
  approve: { from: ["submitted", "under_review"], to: "approved" },
  reject: { from: ["submitted", "under_review", "info_required"], to: "rejected", needsNote: true },
  suspend: { from: ["approved"], to: "suspended", needsNote: true },
  restore: { from: ["suspended"], to: "approved" },
  revoke: { from: ["approved", "suspended"], to: "revoked", needsNote: true },
};

export async function reviewShowroom(req: Request, businessId: string, action: string, note?: string) {
  const rule = REVIEW_ACTIONS[action];
  if (!rule) throw new AppError(400, "UNKNOWN_ACTION", "Unknown review action.");
  if (rule.needsNote && !note?.trim()) throw new AppError(400, "NOTE_REQUIRED", "Add a note the showroom will see.");
  if (!Types.ObjectId.isValid(businessId)) throw notFound("Showroom not found.");
  const business = await Business.findOne({ _id: businessId, deletedAt: null });
  if (!business) throw notFound("Showroom not found.");
  const status = showroomStatus(business);
  if (!rule.from.includes(status as ShowroomStatus)) {
    throw new AppError(409, "INVALID_TRANSITION", `A ${status.replace(/_/g, " ")} showroom can't be moved to ${rule.to.replace(/_/g, " ")}.`);
  }
  business.verificationStatus = rule.to;
  business.reviewNote = note;
  business.rejectionReason = rule.to === "rejected" ? note : undefined;
  business.reviewedAt = new Date();
  business.reviewedBy = req.user!._id as never;
  business.statusHistory.push({ status: rule.to, note, by: req.user!._id as never, at: new Date() });
  if (!business.code) business.code = await nextCode("SH");
  await business.save();
  if (rule.to === "approved") {
    await ensureBusinessSubscription(business._id);
    await SellerProfile.updateOne({ userId: business.ownerId }, { $set: { verified: true } });
    await Product.updateMany({ businessId: business._id, businessHold: true }, { $set: { businessHold: false } });
  }
  if (rule.to === "suspended" || rule.to === "revoked") {
    // Hide the showroom's listings from buyers while it can't trade.
    await Product.updateMany({ businessId: business._id, deletedAt: null }, { $set: { businessHold: true } });
  }
  await audit(req, `showroom.${action}`, "Business", String(business._id), { from: status, to: rule.to, note });
  const titles: Record<string, string> = {
    under_review: "Application under review",
    info_required: "More information needed",
    approved: "Showroom approved",
    rejected: "Application rejected",
    suspended: "Showroom suspended",
    revoked: "Seller access revoked",
  };
  await notify({
    userId: String(business.ownerId),
    event: `showroom.${rule.to}`,
    title: titles[rule.to] || "Showroom status updated",
    body: note || (rule.to === "approved" ? "Your showroom can now list devices and take orders on SureGad." : `Your showroom is now ${rule.to.replace(/_/g, " ")}.`),
    data: { businessId: String(business._id), status: rule.to },
  });
  return business;
}

/** Approved showrooms start on the free business plan if they have no subscription yet. */
export async function ensureBusinessSubscription(businessId: unknown) {
  const existing = await Subscription.findOne({ subjectType: "business", subjectId: businessId, status: { $in: ["active", "grace", "trialing", "past_due"] } });
  if (existing) return existing;
  const plan =
    (await SubscriptionPlan.findOne({ audience: "business", active: true, monthlyPricePaise: 0 })) ||
    (await SubscriptionPlan.findOne({ audience: "business", active: true }).sort({ monthlyPricePaise: 1 }));
  if (!plan) return null;
  const free = plan.monthlyPricePaise === 0;
  return Subscription.create({
    subjectType: "business",
    subjectId: businessId,
    planId: plan._id,
    status: free ? "active" : "trialing",
    interval: free ? "free" : "monthly",
    currentPeriodStart: new Date(),
    currentPeriodEnd: addDays(new Date(), free ? 3650 : 14),
  });
}

/** Sensitive fields: changing them after approval needs SureGad to verify again. */
export const sensitiveChangeSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    businessType: z.enum(["proprietorship", "partnership", "llp", "private_limited", "public_limited", "other"]),
    gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid GSTIN."),
    pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "Enter a valid PAN."),
    registrationNumber: z.string().trim().min(2).max(60),
    ownerName: z.string().trim().min(2).max(80),
    bank: z.object({ accountName: z.string().trim().min(2).max(120), accountNumber: z.string().trim().regex(/^[0-9]{6,20}$/), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC.") }),
  })
  .partial();

export async function requestSensitiveChange(req: Request, business: ShowroomDoc, body: unknown) {
  const input = sensitiveChangeSchema.parse(body);
  if (!Object.keys(input).length) throw new AppError(400, "NOTHING_TO_CHANGE", "Nothing to change.");
  if (business.pendingChanges?.status === "pending") throw new AppError(409, "CHANGE_PENDING", "A change request is already waiting for SureGad.");
  const fields: Record<string, unknown> = { ...input };
  if (input.bank) {
    fields.bank = {
      accountName: input.bank.accountName,
      accountNumberLast4: lastDigits(input.bank.accountNumber),
      ifsc: input.bank.ifsc,
      cipher: encryptSecret(input.bank.accountNumber),
    };
  }
  business.pendingChanges = { fields, requestedAt: new Date(), status: "pending", note: undefined } as never;
  await business.save();
  await audit(req, "showroom.change_requested", "Business", String(business._id), { fields: Object.keys(input) });
  return business;
}

export async function decideSensitiveChange(req: Request, businessId: string, approve: boolean, note?: string) {
  const business = await Business.findById(businessId);
  if (!business || business.pendingChanges?.status !== "pending") throw notFound("No pending change request.");
  const fields = (business.pendingChanges.fields || {}) as Record<string, unknown>;
  if (approve) {
    for (const [key, value] of Object.entries(fields)) {
      if (key === "ownerName") business.set("owner.name", value);
      else business.set(key, value);
    }
  }
  business.pendingChanges = { fields: approve ? undefined : fields, requestedAt: business.pendingChanges.requestedAt, status: approve ? "approved" : "rejected", note } as never;
  business.statusHistory.push({ status: approve ? "change_approved" : "change_rejected", note, by: req.user!._id as never, at: new Date() });
  await business.save();
  await audit(req, approve ? "showroom.change_approved" : "showroom.change_rejected", "Business", String(business._id), { fields: Object.keys(fields) });
  await notify({
    userId: String(business.ownerId),
    event: "showroom.change_decided",
    title: approve ? "Profile change approved" : "Profile change declined",
    body: note || (approve ? "Your business details were updated." : "Your requested business details were not changed."),
    data: { businessId: String(business._id) },
  });
  return business;
}

/** What the owner sees about their own showroom. Encrypted bank data never leaves the server. */
export function presentShowroom(business: ShowroomDoc | Record<string, any>, forAdmin = false) {
  const raw = (typeof (business as ShowroomDoc).toObject === "function" ? (business as ShowroomDoc).toObject() : business) as Record<string, any>;
  const status = showroomStatus(raw);
  const pending = raw.pendingChanges?.fields ? { ...raw.pendingChanges.fields } : undefined;
  if (pending?.bank) pending.bank = { accountName: pending.bank.accountName, accountNumberLast4: pending.bank.accountNumberLast4, ifsc: pending.bank.ifsc };
  return {
    id: String(raw._id),
    code: raw.code || null,
    status,
    name: raw.name,
    slug: raw.slug,
    owner: raw.owner || {},
    businessType: raw.businessType || null,
    description: raw.description || "",
    tagline: raw.tagline || "",
    yearEstablished: raw.yearEstablished || null,
    email: raw.email || "",
    phone: raw.phone || "",
    gstin: raw.gstin || "",
    pan: raw.pan || "",
    registrationNumber: raw.registrationNumber || "",
    address: raw.address || {},
    location: raw.location?.coordinates?.length === 2 ? { lat: raw.location.coordinates[1], lng: raw.location.coordinates[0] } : null,
    hours: raw.hours || "",
    profile: raw.profile || { categories: [], brands: [], conditions: [], physicalShowroom: true },
    social: raw.social || {},
    policies: raw.policies || {},
    settings: raw.settings || {},
    logoUrl: raw.logoKey ? mediaUrl(raw.logoKey) : null,
    bannerUrl: raw.bannerKey ? mediaUrl(raw.bannerKey) : null,
    logoKey: raw.logoKey || null,
    bannerKey: raw.bannerKey || null,
    documents: (raw.documents || []).map((doc: Record<string, any>) => ({
      id: String(doc._id),
      kind: doc.kind || "other",
      name: doc.name,
      status: doc.status,
      note: doc.note || null,
      uploadedAt: doc.uploadedAt || null,
      ...(forAdmin ? { key: doc.key } : {}),
    })),
    bank: raw.bank?.accountNumberLast4 ? { accountName: raw.bank.accountName, accountNumberLast4: raw.bank.accountNumberLast4, ifsc: raw.bank.ifsc } : null,
    onboardingStep: raw.onboardingStep || 0,
    submittedAt: raw.submittedAt || null,
    reviewedAt: raw.reviewedAt || null,
    reviewNote: raw.reviewNote || null,
    rejectionReason: raw.rejectionReason || null,
    statusHistory: (raw.statusHistory || []).map((row: Record<string, any>) => ({ status: row.status, note: row.note || null, at: row.at })),
    pendingChanges: raw.pendingChanges?.status && raw.pendingChanges.status !== "none" ? { status: raw.pendingChanges.status, fields: pending || null, requestedAt: raw.pendingChanges.requestedAt, note: raw.pendingChanges.note || null } : null,
    missing: status === "draft" || status === "info_required" || status === "rejected" ? missingForSubmission(business as ShowroomDoc) : [],
    createdAt: raw.createdAt,
    ...(forAdmin ? { ownerId: String(raw.ownerId) } : {}),
  };
}

export function assertOwnPrivateKey(key: string, userId: string, purpose: string) {
  if (key.includes("..") || !key.startsWith(`private/${purpose}/${userId}/`)) {
    throw new AppError(400, "INVALID_FILE", "Upload the file again from this account.");
  }
}

export function assertOwnPublicKey(key: string, userId: string, purposes: string[]) {
  if (key.includes("..") || !purposes.some((purpose) => key.startsWith(`public/${purpose}/${userId}/`))) {
    throw new AppError(400, "INVALID_FILE", "Upload the file again from this account.");
  }
}

export { forbidden };
