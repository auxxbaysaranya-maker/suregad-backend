import mongoose, { Types } from "mongoose";
import { z } from "zod";
import type { Request } from "express";
import { Product } from "../models/catalog.model";
import { Subscription, SubscriptionPlan } from "../models/commerce.model";
import { Conversation, Offer } from "../models/engagement.model";
import { SellerProfile } from "../models/profiles.model";
import { InventoryUnit } from "../models/showroom.model";
import { User } from "../models/user.model";
import { AppError, forbidden, notFound } from "../common/errors";
import { slugify } from "../common/crypto";
import { addDays, kolkataMonthRange } from "../common/time";
import { logger } from "../config/logger";
import { assertCanCreateListing, getEntitlements, monthlyListingCount, recordUsage } from "./entitlement.service";
import { createListing, presentProduct } from "./catalog.service";
import { syncListingStock } from "./inventory.service";
import { postMessage } from "./chat.service";
import { notify } from "./notification.service";
import { audit } from "./audit.service";

type ProductDoc = InstanceType<typeof Product>;

/* ---------------- individual sellers (ordinary marketplace accounts) ---------------- */

const FREE_PLAN = "individual_free";

/** Anyone signed in can sell: the seller role, profile and free plan are created on first listing. */
export async function ensureIndividualSeller(userId: string, place: { city: string; district: string; state: string }) {
  const user = await User.findById(userId);
  if (!user) throw forbidden();
  if (user.roles.includes("business_seller")) {
    throw new AppError(403, "USE_SELLER_HUB", "Showroom accounts list devices from SureGad Hub.");
  }
  const plan = await SubscriptionPlan.findOne({ code: FREE_PLAN });
  if (!plan) throw new AppError(500, "PLAN_MISSING", "Individual free plan is not seeded.");
  if (!user.roles.includes("individual_seller")) {
    user.roles.push("individual_seller");
    await user.save();
  }
  const name = user.displayName || "Seller";
  await SellerProfile.updateOne(
    { userId: user._id },
    { $setOnInsert: { displayName: name, slug: slugify(name), verified: false, ...place } },
    { upsert: true },
  );
  const current = await Subscription.exists({ subjectType: "user", subjectId: user._id, status: { $in: ["active", "grace", "trialing"] } });
  if (!current) {
    await Subscription.create({
      subjectType: "user",
      subjectId: user._id,
      planId: plan._id,
      status: "active",
      interval: "free",
      currentPeriodStart: new Date(),
      currentPeriodEnd: addDays(new Date(), 3650),
    });
  }
  return user;
}

/** A listing as its owner sees it (real status, validity, sold details). */
export function presentOwnListing(product: Record<string, any>) {
  return {
    ...presentProduct(product, true),
    status: product.status as string,
    rejectionReason: product.rejectionReason || null,
    expiresAt: product.expiresAt || null,
    soldOut: product.soldOut?.at ? { at: product.soldOut.at, reason: product.soldOut.reason, note: product.soldOut.note || "", pricePaise: product.soldOut.pricePaise ?? null } : null,
    views: product.stats?.views || 0,
  };
}

/** Plan, this month's allowance and the user's own listings for the selling pages. */
export async function sellingOverview(userId: string) {
  const subscribed = await getEntitlements({ userId });
  let limits = subscribed.limits;
  if (!subscribed.active) {
    // Not a seller yet: show what the free plan will give them.
    const raw = (await SubscriptionPlan.findOne({ code: FREE_PLAN, active: true }).lean())?.limits;
    limits = { ...limits, activeListings: raw?.activeListings || 0, monthlyListings: raw?.monthlyListings || 0, photosPerListing: raw?.photosPerListing || 0, listingValidityDays: raw?.listingValidityDays ?? limits.listingValidityDays };
  }
  const owner = { sellerUserId: new Types.ObjectId(userId), sellerType: "individual" };
  const [used, rows, user] = await Promise.all([
    monthlyListingCount(owner),
    Product.find({ ...owner, deletedAt: null }).sort({ createdAt: -1 }).limit(100).lean(),
    User.findById(userId).select("roles").lean(),
  ]);
  const chats = await Conversation.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { productId: { $in: rows.map((row) => row._id) }, kind: { $ne: "inspection" } } },
    { $group: { _id: "$productId", n: { $sum: 1 } } },
  ]);
  const active = rows.filter((row) => ["draft", "pending_review", "active", "reserved"].includes(row.status)).length;
  return {
    canSell: !user?.roles.includes("business_seller"),
    limits,
    usage: { monthly: used, active, monthlyLeft: Math.max(0, limits.monthlyListings - used), activeLeft: Math.max(0, limits.activeListings - active) },
    resetsAt: kolkataMonthRange().end,
    listings: rows.map((row) => ({ ...presentOwnListing(row), chats: chats.find((entry) => String(entry._id) === String(row._id))?.n || 0 })),
  };
}

const createSchema = z
  .object({
    imageKeys: z.array(z.string()).min(1, "Add at least one photo."),
    location: z.object({ city: z.string().trim().min(2), district: z.string().trim().min(2), state: z.string().trim().min(2) }).passthrough(),
  })
  .passthrough();

export async function createIndividualListing(req: Request, body: unknown) {
  const input = createSchema.parse(body);
  const { city, district, state } = input.location;
  const seller = await ensureIndividualSeller(String(req.user!._id), { city, district, state });
  req.user!.roles = seller.roles;
  return createListing(req, { ...input, sellerType: "individual", businessId: undefined, submit: true });
}

/* ---------------- listing validity ---------------- */

/** Takes listings off the marketplace when their validity ends and tells the seller. */
export async function expireListings(): Promise<number> {
  if (mongoose.connection.readyState !== 1) return 0;
  const due = { status: "active", deletedAt: null, expiresAt: { $ne: null, $lte: new Date() } };
  const rows = await Product.find(due).select("title sellerUserId").limit(200).lean();
  let count = 0;
  for (const row of rows) {
    const changed = await Product.updateOne({ ...due, _id: row._id }, { $set: { status: "expired" } });
    if (!changed.modifiedCount) continue;
    count += 1;
    await Offer.updateMany({ productId: row._id, status: "pending" }, { status: "expired", respondedAt: new Date() });
    await notify({
      userId: String(row.sellerUserId),
      event: "listing.expired",
      title: "Listing expired",
      body: `${row.title} reached the end of its validity. Renew it to show it to buyers again.`,
      data: { productId: String(row._id) },
    }).catch((error) => logger.warn({ err: error }, "Listing expiry notice failed"));
  }
  return count;
}

/** Puts an expired listing back online. Counts as one of the month's listings. */
export async function renewListing(req: Request, product: ProductDoc) {
  if (product.status !== "expired") throw new AppError(409, "NOT_EXPIRED", "Only an expired listing can be renewed.");
  const entitlements = await assertCanCreateListing({
    userId: String(product.sellerUserId),
    businessId: product.businessId ? String(product.businessId) : undefined,
    imageCount: 0,
  });
  const now = new Date();
  const days = entitlements.limits.listingValidityDays;
  const renewed = await Product.findOneAndUpdate(
    { _id: product._id, status: "expired" },
    { $set: { status: "active", expiresAt: days > 0 ? addDays(now, days) : null }, $push: { renewals: now } },
    { new: true },
  );
  if (!renewed) throw new AppError(409, "NOT_EXPIRED", "This listing was already renewed.");
  await recordUsage(entitlements.subscriptionId, "listing_renewed", { productId: product._id });
  await audit(req, "listing.renewed", "Product", String(product._id));
  return renewed;
}

/* ---------------- sold out ---------------- */

export const SOLD_REASONS = ["sold_on_suregad", "sold_elsewhere", "no_longer_selling", "damaged_or_lost", "other"] as const;

export const soldSchema = z
  .object({
    reason: z.enum(SOLD_REASONS),
    note: z.string().trim().max(500).optional(),
    /** The chat the sale was agreed in (records the buyer). */
    conversationId: z.string().optional(),
    pricePaise: z.number().int().positive().max(50_000_000).optional(),
  })
  .refine((value) => value.reason !== "other" || (value.note || "").length >= 3, { message: "Tell us the reason.", path: ["note"] });

/** The seller takes a live (or in-review) listing down before its validity ends, with a reason. */
export async function markSold(req: Request, product: ProductDoc, body: unknown) {
  const input = soldSchema.parse(body);
  const sellerId = String(product.sellerUserId);
  let buyerId: string | undefined;
  if (input.conversationId) {
    const conversation = Types.ObjectId.isValid(input.conversationId)
      ? await Conversation.findOne({ _id: input.conversationId, productId: product._id, kind: { $ne: "inspection" }, participantIds: product.sellerUserId }).lean()
      : null;
    if (!conversation) throw notFound("Conversation not found.");
    buyerId = conversation.participantIds.map(String).find((id) => id !== sellerId);
  }
  if (product.stockTracked && (await InventoryUnit.exists({ productId: product._id, status: "RESERVED" }))) {
    throw new AppError(409, "UNITS_RESERVED", "A buyer is paying for a unit of this listing. Try again after the order settles.");
  }
  const updated = await Product.findOneAndUpdate(
    { _id: product._id, deletedAt: null, status: { $in: ["active", "pending_review"] }, "inventory.state": { $ne: "reserved" } },
    {
      $set: {
        status: "sold",
        soldOut: { at: new Date(), reason: input.reason, note: input.note, buyerUserId: buyerId, pricePaise: input.pricePaise, by: req.user!._id },
        ...(product.stockTracked ? {} : { "inventory.state": "sold" }),
      },
    },
    { new: true },
  );
  if (!updated) throw new AppError(409, "NOT_LIVE", "Only a live listing that nobody is paying for can be marked sold.");
  if (updated.stockTracked) {
    await InventoryUnit.updateMany({ productId: updated._id, status: "AVAILABLE", deletedAt: null }, { $set: { status: "UNLISTED" }, $inc: { rev: 1 } });
    await syncListingStock(updated._id);
  } else {
    // Frees the IMEI/serial so the new owner can list the device later; device history still finds it.
    for (const field of ["imeiHash", "serialHash"] as const) {
      const value = updated.identifier?.[field];
      if (value && !value.includes(":")) await Product.updateOne({ _id: updated._id }, { $set: { [`identifier.${field}`]: `sold:${updated.id}:${value}` } });
    }
  }
  if (buyerId) await Offer.updateMany({ productId: updated._id, buyerId, status: "accepted" }, { status: "purchased" });
  await Offer.updateMany({ productId: updated._id, status: "pending" }, { status: "superseded", respondedAt: new Date() });
  await Offer.updateMany({ productId: updated._id, status: "accepted" }, { status: "expired" });
  const chats = await Conversation.find({ productId: updated._id, kind: { $ne: "inspection" } }).limit(200);
  for (const conversation of chats) {
    const toBuyer = buyerId && conversation.participantIds.some((id) => String(id) === buyerId);
    await postMessage(conversation, sellerId, {
      kind: "system",
      body: toBuyer ? "The seller marked this device as sold to this buyer." : input.reason.startsWith("sold") ? "This device has been sold." : "The seller is no longer offering this device.",
    }).catch((error) => logger.warn({ err: error }, "Sold notice failed"));
  }
  await audit(req, "listing.marked_sold", "Product", updated.id, { reason: input.reason });
  return (await Product.findById(updated._id))!;
}
