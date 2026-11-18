import { Router } from "express";
import express from "express";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import mongoose from "mongoose";
import { addressSchema } from "../shared/validation";
import { integrationStatus } from "../config/env";
import { env } from "../config/env";
import { asyncHandler, sendData } from "../common/http";
import { AppError, forbidden, notFound } from "../common/errors";
import { requirePermission, requireUser, ensureBuyerProfile, clearPermissionCache } from "../middleware/auth";
import { signDevToken, verifyIdentity } from "../integrations/firebase";
import { hashPassword, verifyPassword } from "../common/crypto";
import { claimReferral, deviceHistory, ensureReferralCode, notifyPriceAlerts } from "../services/growth.service";
import { NewsletterSignup, PriceAlert, Referral, SellerSettlement } from "../models/engagement.model";
import { getPaymentProvider, mockPaymentSignature } from "../integrations/payments";
import { readLocalUpload, saveLocalUpload, signUpload, signedDownload } from "../integrations/storage";
import { User } from "../models/user.model";
import { Business, BusinessEmployee, BuyerProfile, PartnerProfile, SellerProfile } from "../models/profiles.model";
import { Brand, Category, Product, ProductModel } from "../models/catalog.model";
import { Coupon, Order, Payment, Refund, Subscription, SubscriptionPlan } from "../models/commerce.model";
import {
  InspectionAssignment,
  InspectionEvidence,
  InspectionPlan,
  InspectionReport,
  InspectionRequest,
} from "../models/inspection.model";
import {
  AuditLog,
  Conversation,
  Dispute,
  Enquiry,
  Message,
  Notification,
  PlatformSetting,
  Review,
  SupportTicket,
} from "../models/engagement.model";
import { PartnerPayout } from "../models/engagement.model";
import { createListing, presentProduct, searchProducts, setListingStatus } from "../services/catalog.service";
import { assertCanAddEmployee } from "../services/entitlement.service";
import {
  addCartItem,
  capturePayment,
  checkout,
  getCart,
  handleWebhook,
  processRefund,
  removeCartItem,
  requestRefund,
  startInspectionCheckout,
  startSubscriptionCheckout,
} from "../services/commerce.service";
import { addEvidence, allocatePartner, publicReport, sanitizeReport, submitReport } from "../services/inspection.service";
import { buyerAssistant, listingAssistant, pricingAssistant, recordRiskSignal, reportSummary } from "../services/ai.service";
import { notify } from "../services/notification.service";
import { audit } from "../services/audit.service";
import { emitToUser } from "../realtime/io";
import { decryptSecret, encryptSecret, hashIdentifier, lastDigits, slugify } from "../common/crypto";
import { addDays } from "../common/time";
import { AIJob } from "../models/engagement.model";
import { devAuth } from "./dev-auth";
import { chat } from "./chat";
import { storefront } from "./storefront";

export const api = Router();

function dbGuard(req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (req.path === "/auth/session") {
    next();
    return;
  }
  if (mongoose.connection.readyState !== 1) {
    next(new AppError(503, "DATABASE_UNAVAILABLE", "MongoDB is not connected. Set MONGODB_URI and restart the API."));
    return;
  }
  next();
}

api.use(devAuth);

api.get("/health", (_req, res) => {
  sendData(res, { service: "suregad-api", ok: true, time: new Date().toISOString() });
});

api.get("/system/status", (_req, res) => {
  sendData(res, { ...integrationStatus(), databaseConnected: mongoose.connection.readyState === 1 });
});

api.get(
  "/push/public-key",
  asyncHandler(async (_req, res) => {
    if (!env.vapid.publicKey) {
      throw new AppError(503, "PUSH_NOT_CONFIGURED", "Web push is not configured.");
    }
    sendData(res, { publicKey: env.vapid.publicKey });
  }),
);

api.use(dbGuard);

api.post(
  "/auth/panel-login",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        panel: z.enum(["admin", "partner", "showroom"]),
        email: z.string().email(),
        password: z.string().min(6).max(80),
      })
      .parse(req.body);
    const email = body.email.toLowerCase();
    const user = await User.findOne({ email, status: "active" });
    const role = body.panel === "admin" ? "super_admin" : body.panel === "partner" ? "service_partner" : "business_seller";
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash) || !user.roles.includes(role)) {
      throw new AppError(401, "INVALID_LOGIN", "Email or password does not match this panel.");
    }
    const token = signDevToken({ uid: user.firebaseUid, email, name: user.displayName });
    sendData(res, { token });
  }),
);

api.post(
  "/auth/panel-signup",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        panel: z.enum(["partner", "showroom"]),
        name: z.string().trim().min(2).max(80),
        email: z.string().email(),
        password: z.string().min(6).max(80),
        city: z.string().trim().min(2).max(80).default("Kochi"),
        district: z.string().trim().min(2).max(80).default("Ernakulam"),
      })
      .parse(req.body);
    const email = body.email.toLowerCase();
    if (await User.exists({ email })) throw new AppError(409, "EMAIL_IN_USE", "An account with this email already exists.");
    const role = body.panel === "partner" ? "service_partner" : "business_seller";
    const user = await User.create({
      firebaseUid: `dev:${email}`,
      email,
      displayName: body.name,
      roles: ["buyer", role],
      passwordHash: hashPassword(body.password),
      status: "active",
    });
    await ensureBuyerProfile(String(user._id));
    const location = { type: "Point" as const, coordinates: [76.2673, 9.9312] };
    if (body.panel === "partner") {
      await PartnerProfile.create({
        userId: user._id,
        name: body.name,
        email,
        categories: ["smartphones", "laptops"],
        verificationStatus: "pending",
        serviceRadiusKm: 20,
        location,
        address: { city: body.city, district: body.district, state: "Kerala" },
      });
    } else {
      const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "showroom";
      await Business.create({
        ownerId: user._id,
        name: body.name,
        slug: `${slug}-${String(user._id).slice(-4)}`,
        email,
        verificationStatus: "pending",
        location,
        address: { city: body.city, district: body.district, state: "Kerala" },
      });
      await SellerProfile.create({
        userId: user._id,
        slug: `seller-${String(user._id).slice(-6)}`,
        displayName: body.name,
        city: body.city,
        district: body.district,
        location,
      });
    }
    const token = signDevToken({ uid: user.firebaseUid, email, name: body.name });
    sendData(res, { token }, undefined, 201);
  }),
);

api.post(
  "/auth/session",
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || req.header("authorization")?.replace("Bearer ", "") || "");
    if (!token) throw new AppError(400, "TOKEN_REQUIRED", "Send the Firebase ID token.");
    const identity = await verifyIdentity(token);
    if (mongoose.connection.readyState !== 1) {
      throw new AppError(503, "DATABASE_UNAVAILABLE", "MongoDB is not connected. Set MONGODB_URI and restart the API.");
    }
    let user = await User.findOne({ firebaseUid: identity.uid });
    const email = identity.email?.toLowerCase();
    if (!user && email && !token.startsWith("dev.")) {
      const seeded = await User.findOne({ email, firebaseUid: `dev:${email}` });
      if (seeded) {
        seeded.firebaseUid = identity.uid;
        await seeded.save();
        user = seeded;
      }
    }
    if (!user) {
      const roles = ["buyer"];
      if (email && env.adminBootstrapEmails.includes(email)) {
        const existingAdmin = await User.exists({ roles: "super_admin", status: "active" });
        if (!existingAdmin) roles.push("super_admin");
      }
      user = await User.create({
        firebaseUid: identity.uid,
        email,
        phone: identity.phone,
        displayName: identity.name || email || identity.phone || "SureGad user",
        photoUrl: identity.picture,
        roles,
      });
      await ensureBuyerProfile(String(user._id));
      await notify({
        userId: String(user._id),
        event: "account.created",
        title: "Welcome to SureGad",
        body: "Your account is ready. Buyers can enquire, request inspections and check out when a device is available.",
      });
    } else {
      if (email && !user.email) user.email = email;
      if (identity.phone && !user.phone) user.phone = identity.phone;
      if (identity.name && user.displayName === "SureGad user") user.displayName = identity.name;
      if (identity.picture) user.photoUrl = identity.picture;
      await user.save();
    }
    if (email && env.adminBootstrapEmails.includes(email) && !user.roles.includes("super_admin")) {
      const existingAdmin = await User.exists({ roles: "super_admin", status: "active" });
      if (!existingAdmin) {
        user.roles.push("super_admin");
        await user.save();
      }
    }
    const { linkEmployeeInvites } = await import("../middleware/auth");
    await linkEmployeeInvites(user);
    await ensureBuyerProfile(String(user._id));
    sendData(res, await publicUser(String(user._id)));
  }),
);

api.post(
  "/auth/logout",
  requireUser,
  asyncHandler(async (req, res) => {
    await User.updateOne({ _id: req.user!._id }, { tokenValidAfter: new Date() });
    sendData(res, { revoked: true });
  }),
);

api.get(
  "/auth/me",
  requireUser,
  asyncHandler(async (req, res) => {
    sendData(res, await publicUser(String(req.user!._id)));
  }),
);

api.patch(
  "/auth/me",
  requireUser,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        displayName: z.string().trim().min(2).max(80).optional(),
        locale: z.enum(["en", "ml", "hi"]).optional(),
        sharePhone: z.boolean().optional(),
        notificationPreferences: z
          .object({
            inApp: z.boolean().optional(),
            email: z.boolean().optional(),
            sms: z.boolean().optional(),
            whatsapp: z.boolean().optional(),
            push: z.boolean().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    await User.updateOne({ _id: req.user!._id }, body);
    sendData(res, await publicUser(String(req.user!._id)));
  }),
);

api.post(
  "/auth/seller",
  requireUser,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        displayName: z.string().trim().min(2).max(80),
        bio: z.string().max(1000).optional(),
        city: z.string().min(2),
        district: z.string().min(2),
        state: z.string().default("Kerala"),
      })
      .parse(req.body);
    const user = await User.findById(req.user!._id);
    if (!user) throw notFound();
    if (!user.roles.includes("individual_seller")) user.roles.push("individual_seller");
    await user.save();
    const profile = await SellerProfile.findOneAndUpdate(
      { userId: user._id },
      { $set: body, $setOnInsert: { userId: user._id, slug: slugify(body.displayName), verified: false } },
      { upsert: true, new: true },
    );
    const plan = await SubscriptionPlan.findOne({ code: "individual_free" });
    if (!plan) throw new AppError(500, "PLAN_MISSING", "Individual free plan is not seeded.");
    await Subscription.updateOne(
      { subjectType: "user", subjectId: user._id, status: { $in: ["active", "grace"] } },
      {
        $setOnInsert: {
          subjectType: "user",
          subjectId: user._id,
          planId: plan._id,
          status: "active",
          interval: "free",
          currentPeriodStart: new Date(),
          currentPeriodEnd: addDays(new Date(), 3650),
        },
      },
      { upsert: true },
    );
    sendData(res, profile);
  }),
);

api.post(
  "/auth/business",
  requireUser,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2),
        phone: z.string().min(8),
        email: z.string().email(),
        gstin: z.string().optional(),
        description: z.string().max(4000).optional(),
        hours: z.string().max(200).optional(),
        address: addressSchema,
        logoKey: z.string().optional(),
        bannerKey: z.string().optional(),
        documentKeys: z.array(z.string()).default([]),
      })
      .parse(req.body);
    const user = await User.findById(req.user!._id);
    if (!user) throw notFound();
    if (!user.roles.includes("business_seller")) user.roles.push("business_seller");
    await user.save();
    const coordinates = body.address.coordinates
      ? { type: "Point", coordinates: [body.address.coordinates.lng, body.address.coordinates.lat] }
      : undefined;
    const business = await Business.create({
      ownerId: user._id,
      name: body.name,
      slug: slugify(body.name),
      phone: body.phone,
      email: body.email.toLowerCase(),
      address: body.address,
      gstin: body.gstin,
      description: body.description || "",
      hours: body.hours || "",
      logoKey: body.logoKey,
      bannerKey: body.bannerKey,
      documents: body.documentKeys.map((key) => ({ key, name: "registration", status: "pending" })),
      verificationStatus: "pending",
      location: coordinates,
    });
    await audit(req, "business.submitted", "Business", String(business._id));
    sendData(res, business, undefined, 201);
  }),
);

api.post(
  "/auth/partner",
  requireUser,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2),
        phone: z.string().min(8),
        email: z.string().email(),
        categories: z.array(z.enum(["smartphones", "laptops"])).min(1),
        experienceYears: z.number().min(0).max(60),
        serviceRadiusKm: z.number().min(1).max(100),
        address: addressSchema,
        documentKeys: z.array(z.object({ key: z.string(), name: z.string(), kind: z.string() })).default([]),
        bank: z.object({ accountName: z.string(), accountNumber: z.string().min(6), ifsc: z.string().min(8) }).optional(),
        agreementAccepted: z.literal(true),
      })
      .parse(req.body);
    const user = await User.findById(req.user!._id);
    if (!user) throw notFound();
    if (!user.roles.includes("service_partner")) user.roles.push("service_partner");
    await user.save();
    const coordinates = body.address.coordinates
      ? { type: "Point", coordinates: [body.address.coordinates.lng, body.address.coordinates.lat] }
      : undefined;
    const partner = await PartnerProfile.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          name: body.name,
          phone: body.phone,
          email: body.email.toLowerCase(),
          categories: body.categories,
          experienceYears: body.experienceYears,
          serviceRadiusKm: body.serviceRadiusKm,
          address: body.address,
          documents: body.documentKeys,
          location: coordinates,
          agreementAcceptedAt: new Date(),
          verificationStatus: "pending",
          bank: body.bank
            ? {
                accountName: body.bank.accountName,
                accountNumberLast4: lastDigits(body.bank.accountNumber),
                ifsc: body.bank.ifsc,
                cipher: encryptSecret(body.bank.accountNumber),
              }
            : undefined,
        },
        $setOnInsert: { userId: user._id },
      },
      { upsert: true, new: true },
    );
    await audit(req, "partner.submitted", "PartnerProfile", String(partner._id));
    sendData(res, { id: partner._id, verificationStatus: partner.verificationStatus });
  }),
);

api.delete(
  "/auth/account",
  requireUser,
  asyncHandler(async (req, res) => {
    await User.updateOne(
      { _id: req.user!._id },
      { status: "deleted", deletedAt: new Date(), displayName: "Deleted user", email: undefined, phone: undefined },
    );
    await audit(req, "account.deleted", "User", String(req.user!._id));
    sendData(res, { deleted: true });
  }),
);

api.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    sendData(res, await Category.find({ active: true }).sort({ sort: 1 }).lean());
  }),
);

api.get(
  "/brands",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { active: true };
    if (req.query.category) filter.categories = String(req.query.category);
    if (req.query.popular === "true") filter.popular = true;
    sendData(res, await Brand.find(filter).sort({ name: 1 }).lean());
  }),
);

api.get(
  "/models",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { active: true };
    if (req.query.category) filter.categorySlug = String(req.query.category);
    if (req.query.brand) {
      const brand = await Brand.findOne({ slug: String(req.query.brand) });
      filter.brandId = brand?._id || null;
    }
    sendData(res, await ProductModel.find(filter).sort({ name: 1 }).limit(200).lean());
  }),
);

api.get(
  "/products",
  asyncHandler(async (req, res) => {
    if (req.query.ids) {
      const ids = String(req.query.ids).split(",").filter(Boolean).slice(0, 4);
      const items = await Product.find({ _id: { $in: ids }, deletedAt: null }).lean();
      sendData(res, items.map((item) => presentProduct(item as never)));
      return;
    }
    const result = await searchProducts(req.query as Record<string, unknown>);
    sendData(res, result.items, result.meta);
  }),
);

api.get(
  "/products/:slug",
  asyncHandler(async (req, res) => {
    const product = await Product.findOne({ slug: req.params.slug, deletedAt: null, status: { $in: ["active", "reserved", "sold"] } }).lean();
    if (!product) throw notFound("Listing not found.");
    const seller = await SellerProfile.findOne({ userId: product.sellerUserId }).lean();
    const business = product.businessId ? await Business.findById(product.businessId).lean() : null;
    const reviews = await Review.find({ targetType: "product", targetId: product._id, status: "published" }).sort({ createdAt: -1 }).limit(20).lean();
    const similar = await Product.find({
      _id: { $ne: product._id },
      categorySlug: product.categorySlug,
      status: "active",
      deletedAt: null,
    }).sort({ createdAt: -1 }).limit(4).lean();
    sendData(res, {
      product: presentProduct(product as never, true),
      seller: seller
        ? { slug: seller.slug, displayName: seller.displayName, city: seller.city, verified: seller.verified, memberSince: seller.createdAt }
        : null,
      business: business
        ? { slug: business.slug, name: business.name, verified: business.verificationStatus === "approved", city: business.address?.city, hours: business.hours }
        : null,
      reviews,
      similar: similar.map((item) => presentProduct(item as never)),
      history: await deviceHistory(String(product._id)),
    });
  }),
);

api.get(
  "/delivery/quote",
  asyncHandler(async (_req, res) => {
    throw new AppError(503, "DELIVERY_NOT_CONFIGURED", "No delivery carrier is connected. Pickup is available. Choosing delivery records the request for the seller. It does not book a courier.");
  }),
);

api.post(
  "/products/:slug/view",
  asyncHandler(async (req, res) => {
    await Product.updateOne({ slug: req.params.slug, status: "active" }, { $inc: { "stats.views": 1 } });
    sendData(res, { recorded: true });
  }),
);

api.post(
  "/newsletter",
  asyncHandler(async (req, res) => {
    const body = z.object({
      email: z.string().email(),
      emailConsent: z.boolean(),
      whatsappConsent: z.boolean(),
      phone: z.string().optional(),
    }).parse(req.body);
    if (!body.emailConsent && !body.whatsappConsent) {
      throw new AppError(400, "CONSENT_REQUIRED", "Choose email or WhatsApp before subscribing.");
    }
    await NewsletterSignup.create(body);
    sendData(res, { recorded: true }, undefined, 201);
  }),
);

api.get(
  "/marketplace/home",
  asyncHandler(async (_req, res) => {
    const live = { status: "active", deletedAt: null, "inventory.state": { $ne: "sold" } };
    const settings = await PlatformSetting.findOne({ key: "platform" }).lean();
    const [featured, recent, inspected, refurbished, laptops, categories, brands, showrooms, sellers, reviews] = await Promise.all([
      Product.find({ ...live, featuredUntil: { $gt: new Date() } }).sort({ featuredUntil: -1 }).limit(8).lean(),
      Product.find(live).sort({ createdAt: -1 }).limit(8).lean(),
      Product.find({ ...live, "inspection.published": true }).sort({ updatedAt: -1 }).limit(8).lean(),
      Product.find({ ...live, sellerType: "business" }).sort({ createdAt: -1 }).limit(8).lean(),
      Product.find({ ...live, categorySlug: "laptops" }).sort({ createdAt: -1 }).limit(4).lean(),
      Category.find({ active: true }).sort({ sort: 1 }).select("slug name").lean(),
      Brand.find({ active: true, popular: true }).select("slug name").lean(),
      Business.find({ verificationStatus: "approved", deletedAt: null }).sort({ sponsoredUntil: -1, createdAt: -1 }).limit(6).lean(),
      SellerProfile.find({ deletedAt: null }).sort({ verified: -1 }).limit(6).select("slug displayName city verified").lean(),
      Review.find({ status: "published", targetType: "product" }).sort({ createdAt: -1 }).limit(4).lean(),
    ]);
    const reviewProducts = await Product.find({ _id: { $in: reviews.map((review) => review.targetId) } }).select("title slug").lean();
    const reviewAuthors = await User.find({ _id: { $in: reviews.map((review) => review.authorId) } }).select("displayName").lean();
    sendData(res, {
      cms: settings?.value?.homepage || {},
      categories,
      brands,
      trending: (featured.length ? featured : recent).map((item) => presentProduct(item as never)),
      fresh: recent.map((item) => presentProduct(item as never)),
      inspected: inspected.map((item) => presentProduct(item as never)),
      refurbished: refurbished.map((item) => presentProduct(item as never)),
      laptops: laptops.map((item) => presentProduct(item as never)),
      featured: featured.map((item) => presentProduct(item as never)),
      recent: recent.map((item) => presentProduct(item as never)),
      showrooms: showrooms.map((store) => ({
        id: store._id,
        slug: store.slug,
        name: store.name,
        city: store.address?.city,
        description: store.description,
        verified: store.verificationStatus === "approved",
        sponsored: Boolean(store.sponsoredUntil && store.sponsoredUntil > new Date()),
      })),
      sellers: sellers.map((seller) => ({
        slug: seller.slug,
        name: seller.displayName,
        city: seller.city,
        verified: seller.verified,
        type: "individual",
      })),
      reviews: reviews.map((review) => ({
        rating: review.rating,
        body: review.body,
        verifiedPurchase: review.verifiedPurchase,
        product: reviewProducts.find((product) => String(product._id) === String(review.targetId))?.title,
        author: reviewAuthors.find((user) => String(user._id) === String(review.authorId))?.displayName?.split(" ")[0] || "Buyer",
      })),
      phoneBrands: brands,
      laptopBrands: brands,
    });
  }),
);

api.get(
  "/inspection-plans",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { active: true };
    if (req.query.category) filter.categorySlug = String(req.query.category);
    const plans = await InspectionPlan.find(filter).lean();
    sendData(res, plans.map((plan) => ({ ...plan, checklist: plan.checklist.map((item) => ({ key: item.key, label: item.label, critical: item.critical })) })));
  }),
);

api.get(
  "/inspection-reports/:id",
  asyncHandler(async (req, res) => {
    sendData(res, await publicReport(req.params.id));
  }),
);

const authed = Router();
authed.use(requireUser);

authed.post(
  "/notifications/fcm-token",
  asyncHandler(async (req, res) => {
    const body = z.object({ token: z.string().min(20) }).parse(req.body);
    await User.updateOne({ _id: req.user!._id }, { $addToSet: { fcmTokens: body.token }, $set: { "notificationPreferences.push": true } });
    sendData(res, { subscribed: true });
  }),
);

authed.post(
  "/notifications/push-subscription",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        endpoint: z.string().url(),
        keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
      })
      .parse(req.body);
    await User.updateOne({ _id: req.user!._id }, { $pull: { pushSubscriptions: { endpoint: body.endpoint } } });
    await User.updateOne(
      { _id: req.user!._id },
      { $push: { pushSubscriptions: body }, $set: { "notificationPreferences.push": true } },
    );
    sendData(res, { subscribed: true });
  }),
);

authed.post(
  "/uploads/sign",
  asyncHandler(async (req, res) => {
    const body = z.object({ purpose: z.string(), contentType: z.string(), size: z.number().int().positive() }).parse(req.body);
    sendData(res, await signUpload({ ...body, userId: String(req.user!._id) }));
  }),
);

authed.post(
  "/uploads/local",
  express.raw({ type: "*/*", limit: "80mb" }),
  asyncHandler(async (req, res) => {
    const key = String(req.query.key || "");
    if (!key.includes(`/${String(req.user!._id)}/`)) throw forbidden("Upload key does not belong to this account.");
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
    await saveLocalUpload(key, bytes);
    sendData(res, { key, url: key.startsWith("public/") ? `/media/${key}` : undefined });
  }),
);

authed.get(
  "/files",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key || "");
    if (!key.startsWith("private/")) throw new AppError(400, "NOT_PRIVATE", "Use the public media URL for this file.");
    const allowed = req.permissions?.has("*") || key.includes(`/${String(req.user!._id)}/`);
    if (!allowed) throw forbidden();
    const downloadUrl = await signedDownload(key);
    if (downloadUrl) {
      sendData(res, { url: downloadUrl });
      return;
    }
    const bytes = await readLocalUpload(key);
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(bytes);
  }),
);

authed.post(
  "/products",
  requirePermission("products.create"),
  asyncHandler(async (req, res) => {
    const listing = await createListing(req, req.body);
    sendData(res, listing, undefined, 201);
  }),
);

authed.get(
  "/me/listings",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (req.query.businessId) filter.businessId = String(req.query.businessId);
    else filter.sellerUserId = req.user!._id;
    const items = await Product.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    sendData(res, items.map((item) => presentProduct(item as never, true)));
  }),
);

authed.patch(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, deletedAt: null });
    if (!product) throw notFound();
    const owns = String(product.sellerUserId) === String(req.user!._id) || req.permissions?.has("*");
    if (!owns) throw forbidden();
    const body = z
      .object({
        title: z.string().min(4).max(140).optional(),
        description: z.string().min(10).max(8000).optional(),
        pricePaise: z.number().int().positive().optional(),
        condition: z.enum(["like_new", "excellent", "good", "fair"]).optional(),
      })
      .parse(req.body);
    if (product.inventory?.state === "sold") throw new AppError(409, "SOLD", "Sold listings cannot be edited.");
    Object.assign(product, body);
    if (product.status === "active") product.status = "pending_review";
    await product.save();
    if (body.pricePaise) await notifyPriceAlerts(String(product._id), product.pricePaise);
    sendData(res, presentProduct(product.toObject() as never, true));
  }),
);

authed.post(
  "/products/:id/archive",
  asyncHandler(async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!product) throw notFound();
    if (String(product.sellerUserId) !== String(req.user!._id) && !req.permissions?.has("*")) throw forbidden();
    sendData(res, await setListingStatus(req.params.id, "archived"));
  }),
);

authed.post(
  "/businesses/:id/import",
  asyncHandler(async (req, res) => {
    const business = await Business.findById(req.params.id);
    if (!business || String(business.ownerId) !== String(req.user!._id)) throw forbidden();
    const csv = String(req.body?.csv || "");
    const rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
    const created = [];
    const errors: { row: number; message: string }[] = [];
    for (const [index, row] of rows.entries()) {
      try {
        const listing = await createListing(req, {
          categorySlug: row.categorySlug,
          sellerType: "business",
          businessId: String(business._id),
          title: row.title,
          description: row.description,
          condition: row.condition,
          pricePaise: Number(row.pricePaise || Number(row.price) * 100),
          specs: {
            brand: row.brand,
            model: row.model,
            storageGb: Number(row.storageGb),
            ramGb: Number(row.ramGb),
            colour: row.colour || "Unknown",
            processor: row.processor,
            displayInches: row.displayInches ? Number(row.displayInches) : undefined,
          },
          imageKeys: [],
          location: {
            city: row.city,
            district: row.district,
            state: row.state || "Kerala",
            pincode: row.pincode,
          },
          submit: true,
        });
        created.push(listing);
      } catch (error) {
        errors.push({ row: index + 2, message: error instanceof Error ? error.message : "Invalid row" });
      }
    }
    sendData(res, { created: created.length, errors });
  }),
);

authed.post(
  "/businesses/:id/employees",
  asyncHandler(async (req, res) => {
    const business = await Business.findById(req.params.id);
    if (!business || String(business.ownerId) !== String(req.user!._id)) throw forbidden();
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().min(2),
        permissions: z.array(z.string()).default(["enquiries.read", "orders.read"]),
      })
      .parse(req.body);
    const permissions = body.permissions.filter((permission) => !permission.startsWith("admin.") && permission !== "*");
    await assertCanAddEmployee(String(business._id));
    const employee = await BusinessEmployee.create({
      businessId: business._id,
      email: body.email.toLowerCase(),
      name: body.name,
      permissions,
      status: "invited",
    });
    sendData(res, employee, undefined, 201);
  }),
);

authed.get("/cart", asyncHandler(async (req, res) => sendData(res, await getCart(String(req.user!._id)))));
authed.post(
  "/cart/items",
  asyncHandler(async (req, res) => {
    const body = z.object({ productId: z.string() }).parse(req.body);
    sendData(res, await addCartItem(String(req.user!._id), body.productId));
  }),
);
authed.delete(
  "/cart/items/:productId",
  asyncHandler(async (req, res) => sendData(res, await removeCartItem(String(req.user!._id), req.params.productId))),
);

authed.post("/checkout", asyncHandler(async (req, res) => sendData(res, await checkout(req, req.body))));
authed.post(
  "/payments/mock-complete",
  asyncHandler(async (req, res) => {
    const provider = getPaymentProvider();
    if (provider.name !== "mock") throw new AppError(404, "NOT_FOUND", "Mock completion is disabled.");
    const body = z.object({ gatewayOrderId: z.string() }).parse(req.body);
    const payment = await Payment.findOne({ gatewayOrderId: body.gatewayOrderId, userId: req.user!._id, status: "created" });
    if (!payment) throw notFound("Payment order not found.");
    const gatewayPaymentId = `mock_pay_${String(payment._id)}`;
    const signature = mockPaymentSignature(body.gatewayOrderId, gatewayPaymentId);
    sendData(res, await capturePayment({ gatewayOrderId: body.gatewayOrderId, gatewayPaymentId, signature }));
  }),
);
authed.post(
  "/payments/verify",
  asyncHandler(async (req, res) => {
    const body = z.object({ gatewayOrderId: z.string(), gatewayPaymentId: z.string(), signature: z.string() }).parse(req.body);
    sendData(res, await capturePayment(body));
  }),
);

authed.post(
  "/inspections/checkout",
  asyncHandler(async (req, res) => {
    const body = z.object({ productId: z.string(), planCode: z.string(), publishOnListing: z.boolean().default(false) }).parse(req.body);
    sendData(res, await startInspectionCheckout(req, body));
  }),
);
authed.post(
  "/subscriptions/checkout",
  asyncHandler(async (req, res) => {
    const body = z.object({ planCode: z.string(), interval: z.enum(["monthly", "annual"]), businessId: z.string().optional() }).parse(req.body);
    sendData(res, await startSubscriptionCheckout(req, body));
  }),
);
authed.get(
  "/subscriptions/plans",
  asyncHandler(async (_req, res) => sendData(res, await SubscriptionPlan.find({ active: true }).lean())),
);
authed.get(
  "/me/subscription",
  asyncHandler(async (req, res) => {
    const businessId = req.query.businessId ? String(req.query.businessId) : undefined;
    const subscription = await Subscription.findOne(businessId ? { subjectType: "business", subjectId: businessId } : { subjectType: "user", subjectId: req.user!._id }).sort({ createdAt: -1 }).lean();
    sendData(res, subscription);
  }),
);

authed.post(
  "/enquiries",
  asyncHandler(async (req, res) => {
    const body = z.object({ productId: z.string(), subject: z.string().min(3), message: z.string().min(2).max(4000) }).parse(req.body);
    const product = await Product.findById(body.productId);
    if (!product) throw notFound();
    const conversation = await Conversation.create({
      participantIds: [req.user!._id, product.sellerUserId],
      productId: product._id,
      lastMessageAt: new Date(),
      lastPreview: body.message.slice(0, 140),
    });
    const enquiry = await Enquiry.create({
      buyerId: req.user!._id,
      sellerUserId: product.sellerUserId,
      businessId: product.businessId,
      productId: product._id,
      subject: body.subject,
      conversationId: conversation._id,
    });
    conversation.enquiryId = enquiry._id;
    await conversation.save();
    await Message.create({ conversationId: conversation._id, senderId: req.user!._id, body: body.message, readBy: [req.user!._id] });
    await notify({ userId: String(product.sellerUserId), event: "enquiry.created", title: "New enquiry", body: body.subject, data: { conversationId: String(conversation._id) } });
    emitToUser(String(product.sellerUserId), "enquiry", { conversationId: conversation._id });
    sendData(res, { enquiryId: enquiry._id, conversationId: conversation._id }, undefined, 201);
  }),
);

authed.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const items = await Conversation.find({ participantIds: req.user!._id }).sort({ lastMessageAt: -1 }).limit(50).lean();
    sendData(res, items);
  }),
);
authed.get(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOne({ _id: req.params.id, participantIds: req.user!._id });
    if (!conversation && !req.permissions?.has("*")) throw forbidden();
    const messages = await Message.find({ conversationId: req.params.id }).sort({ createdAt: 1 }).limit(200).lean();
    await Message.updateMany({ conversationId: req.params.id }, { $addToSet: { readBy: req.user!._id } });
    sendData(res, messages);
  }),
);
authed.post(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const body = z.object({ body: z.string().min(1).max(4000) }).parse(req.body);
    const conversation = await Conversation.findOne({ _id: req.params.id, participantIds: req.user!._id });
    if (!conversation) throw forbidden();
    const message = await Message.create({ conversationId: conversation._id, senderId: req.user!._id, body: body.body, readBy: [req.user!._id] });
    conversation.lastMessageAt = new Date();
    conversation.lastPreview = body.body.slice(0, 140);
    await conversation.save();
    for (const participant of conversation.participantIds) {
      if (String(participant) !== String(req.user!._id)) {
        emitToUser(String(participant), "message", { conversationId: conversation._id, body: body.body });
        await notify({ userId: String(participant), event: "message.created", title: "New message", body: body.body.slice(0, 140), data: { conversationId: String(conversation._id) } });
      }
    }
    sendData(res, message, undefined, 201);
  }),
);
authed.post(
  "/messages/:id/report",
  asyncHandler(async (req, res) => {
    const message = await Message.findById(req.params.id);
    if (!message) throw notFound();
    message.reported = true;
    message.reportReason = String(req.body?.reason || "spam");
    await message.save();
    sendData(res, { reported: true });
  }),
);

authed.post(
  "/reviews",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        targetType: z.enum(["product", "seller", "business", "partner", "inspection"]),
        targetId: z.string(),
        rating: z.number().int().min(1).max(5),
        body: z.string().max(4000).default(""),
        orderId: z.string().optional(),
        inspectionRequestId: z.string().optional(),
      })
      .parse(req.body);
    let verifiedPurchase = false;
    let inspectionOnly = false;
    if (body.targetType === "product" || body.targetType === "seller" || body.targetType === "business") {
      const order = await Order.findOne({
        _id: body.orderId,
        buyerId: req.user!._id,
        status: "delivered",
        ...(body.targetType === "product" ? { "items.productId": body.targetId } : {}),
      });
      if (!order) throw new AppError(403, "REVIEW_NOT_ALLOWED", "Verified purchase reviews require a delivered order.");
      verifiedPurchase = true;
    }
    if (body.targetType === "inspection" || body.targetType === "partner") {
      const request = await InspectionRequest.findOne({
        _id: body.inspectionRequestId || body.targetId,
        buyerId: req.user!._id,
        status: "completed",
      });
      if (!request) throw new AppError(403, "REVIEW_NOT_ALLOWED", "Inspection reviews require a completed inspection you requested.");
      inspectionOnly = body.targetType !== "partner";
    }
    const signals: string[] = [];
    if (!body.body.trim()) signals.push("empty_text");
    const review = await Review.create({
      authorId: req.user!._id,
      targetType: body.targetType,
      targetId: body.targetId,
      orderId: body.orderId,
      inspectionRequestId: body.inspectionRequestId,
      rating: body.rating,
      body: body.body,
      verifiedPurchase,
      inspectionOnly,
      fraudSignals: signals,
      status: signals.length ? "flagged" : "published",
    });
    if (body.targetType === "partner") {
      await PartnerProfile.updateOne({ _id: body.targetId }, { $inc: { "stats.ratingSum": body.rating, "stats.ratingCount": 1 } });
    }
    sendData(res, review, undefined, 201);
  }),
);

authed.get("/me/referral", asyncHandler(async (req, res) => {
  const code = await ensureReferralCode(String(req.user!._id));
  const invited = await Referral.find({ referrerId: req.user!._id }).select("status createdAt").lean();
  sendData(res, { code, invited });
}));

authed.post("/me/referral", asyncHandler(async (req, res) => {
  const body = z.object({ code: z.string().trim().min(4).max(20) }).parse(req.body);
  await claimReferral(String(req.user!._id), body.code);
  sendData(res, { recorded: true });
}));

authed.get("/me/price-alerts", asyncHandler(async (req, res) => {
  sendData(res, await PriceAlert.find({ userId: req.user!._id }).sort({ createdAt: -1 }).limit(50).lean());
}));

authed.post("/me/price-alerts", asyncHandler(async (req, res) => {
  const body = z.object({ productId: z.string().min(8), targetPaise: z.number().int().positive() }).parse(req.body);
  const alert = await PriceAlert.findOneAndUpdate(
    { userId: req.user!._id, productId: body.productId },
    { $set: { targetPaise: body.targetPaise, active: true }, $unset: { notifiedAt: 1 } },
    { upsert: true, new: true },
  );
  sendData(res, alert, undefined, 201);
}));

authed.post("/reviews/:id/reply", asyncHandler(async (req, res) => {
  const body = z.object({ reply: z.string().trim().min(2).max(1000) }).parse(req.body);
  const review = await Review.findById(req.params.id);
  if (!review || review.targetType !== "product") throw notFound("Review not found.");
  const product = await Product.findById(review.targetId);
  if (!product || String(product.sellerUserId) !== String(req.user!._id)) throw forbidden();
  review.sellerReply = body.reply;
  await review.save();
  sendData(res, { id: review._id, sellerReply: review.sellerReply });
}));

authed.get(
  "/me/orders",
  asyncHandler(async (req, res) => sendData(res, await Order.find({ buyerId: req.user!._id }).sort({ createdAt: -1 }).limit(50).lean())),
);
authed.get(
  "/seller/orders",
  asyncHandler(async (req, res) => sendData(res, await Order.find({ "subOrders.sellerUserId": req.user!._id }).sort({ createdAt: -1 }).limit(50).lean())),
);
authed.post(
  "/orders/:id/refunds",
  asyncHandler(async (req, res) => sendData(res, await requestRefund(req, req.params.id, String(req.body?.reason || "Requested by buyer")))),
);
authed.patch(
  "/seller/orders/:orderId/suborders/:subId",
  asyncHandler(async (req, res) => {
    const status = z.enum(["confirmed", "shipped", "delivered", "cancelled"]).parse(req.body?.status);
    const order = await Order.findOne({ _id: req.params.orderId, "subOrders._id": req.params.subId, "subOrders.sellerUserId": req.user!._id });
    if (!order && !req.permissions?.has("*")) throw forbidden();
    const target = await Order.findOneAndUpdate(
      { _id: req.params.orderId, "subOrders._id": req.params.subId },
      { $set: { "subOrders.$.status": status } },
      { new: true },
    );
    if (!target) throw notFound();
    if (target.subOrders.every((sub) => sub.status === status)) target.status = status;
    await target.save();
    await notify({ userId: String(target.buyerId), event: `order.${status}`, title: `Order ${status}`, body: `Order ${target.number} is ${status}.`, data: { orderId: String(target._id) } });
    sendData(res, target);
  }),
);

authed.get("/me/notifications", asyncHandler(async (req, res) => sendData(res, await Notification.find({ userId: req.user!._id }).sort({ createdAt: -1 }).limit(50).lean())));
authed.post(
  "/me/notifications/:id/read",
  asyncHandler(async (req, res) => {
    await Notification.updateOne({ _id: req.params.id, userId: req.user!._id }, { readAt: new Date() });
    sendData(res, { read: true });
  }),
);

authed.post(
  "/me/addresses",
  asyncHandler(async (req, res) => {
    const address = addressSchema.parse(req.body);
    const profile = await BuyerProfile.findOneAndUpdate({ userId: req.user!._id }, { $setOnInsert: { userId: req.user!._id } }, { upsert: true, new: true });
    profile.addresses.push(address);
    await profile.save();
    sendData(res, profile.addresses);
  }),
);
authed.get(
  "/me/addresses",
  asyncHandler(async (req, res) => {
    const profile = await BuyerProfile.findOne({ userId: req.user!._id }).lean();
    sendData(res, profile?.addresses || []);
  }),
);
authed.post(
  "/me/wishlist/:productId",
  asyncHandler(async (req, res) => {
    await BuyerProfile.updateOne({ userId: req.user!._id }, { $addToSet: { wishlist: req.params.productId } }, { upsert: true });
    sendData(res, { saved: true });
  }),
);
authed.delete(
  "/me/wishlist/:productId",
  asyncHandler(async (req, res) => {
    await BuyerProfile.updateOne({ userId: req.user!._id }, { $pull: { wishlist: req.params.productId } });
    sendData(res, { removed: true });
  }),
);
authed.get(
  "/me/wishlist",
  asyncHandler(async (req, res) => {
    const profile = await BuyerProfile.findOne({ userId: req.user!._id }).lean();
    const items = await Product.find({ _id: { $in: profile?.wishlist || [] }, deletedAt: null }).lean();
    sendData(res, items.map((item) => presentProduct(item as never)));
  }),
);
authed.post(
  "/me/saved-searches",
  asyncHandler(async (req, res) => {
    const body = z.object({ name: z.string().min(2), query: z.record(z.unknown()) }).parse(req.body);
    await BuyerProfile.updateOne({ userId: req.user!._id }, { $push: { savedSearches: body } }, { upsert: true });
    sendData(res, { saved: true });
  }),
);
authed.post(
  "/support",
  asyncHandler(async (req, res) => {
    const body = z.object({ subject: z.string().min(3), body: z.string().min(3) }).parse(req.body);
    sendData(res, await SupportTicket.create({ userId: req.user!._id, ...body }), undefined, 201);
  }),
);
authed.post(
  "/disputes",
  asyncHandler(async (req, res) => {
    const body = z.object({ type: z.enum(["order", "inspection", "review"]), referenceId: z.string(), reason: z.string().min(5) }).parse(req.body);
    sendData(res, await Dispute.create({ openedBy: req.user!._id, ...body }), undefined, 201);
  }),
);

authed.get(
  "/partner/jobs",
  asyncHandler(async (req, res) => {
    const partner = await PartnerProfile.findOne({ userId: req.user!._id });
    if (!partner) throw forbidden();
    const jobs = await InspectionRequest.find({ assignedPartnerId: partner._id }).sort({ createdAt: -1 }).limit(50).lean();
    const products = await Product.find({ _id: { $in: jobs.map((job) => job.productId) } }).select("title city").lean();
    const titles = new Map(products.map((product) => [String(product._id), product]));
    sendData(res, {
      partner: { id: partner._id, verificationStatus: partner.verificationStatus, paused: partner.availability?.paused, serviceRadiusKm: partner.serviceRadiusKm },
      jobs: jobs.map((job) => ({ ...job, productTitle: titles.get(String(job.productId))?.title, city: titles.get(String(job.productId))?.city })),
    });
  }),
);
authed.get(
  "/partner/jobs/:id",
  asyncHandler(async (req, res) => {
    const partner = await PartnerProfile.findOne({ userId: req.user!._id });
    if (!partner) throw forbidden();
    const job = await InspectionRequest.findOne({ _id: req.params.id, assignedPartnerId: partner._id }).lean();
    if (!job) throw notFound("Inspection job not found.");
    const [product, plan, evidence] = await Promise.all([
      Product.findById(job.productId).select("title slug city district categorySlug").lean(),
      InspectionPlan.findById(job.planId).lean(),
      InspectionEvidence.find({ requestId: job._id }).sort({ createdAt: -1 }).lean(),
    ]);
    sendData(res, {
      job,
      product,
      evidence,
      plan: plan
        ? {
            code: plan.code,
            name: plan.name,
            disclaimer: plan.disclaimer,
            checklist: plan.checklist.map((item) => ({ key: item.key, label: item.label, group: item.group, critical: item.critical })),
          }
        : null,
    });
  }),
);
authed.post(
  "/partner/jobs/:id/accept",
  asyncHandler(async (req, res) => {
    const partner = await requireApprovedPartner(String(req.user!._id));
    const request = await InspectionRequest.findOneAndUpdate(
      { _id: req.params.id, assignedPartnerId: partner._id, status: "offered", offerExpiresAt: { $gt: new Date() } },
      { status: "accepted" },
      { new: true },
    );
    if (!request) throw new AppError(409, "OFFER_UNAVAILABLE", "This offer is no longer available.");
    await InspectionAssignment.updateOne({ requestId: request._id, partnerId: partner._id, status: "offered" }, { status: "accepted" });
    partner.stats!.accepted += 1;
    partner.stats!.openJobs += 1;
    await partner.save();
    await notify({ userId: String(request.buyerId), event: "inspection.accepted", title: "Inspection accepted", body: "A partner accepted your inspection request.", data: { requestId: String(request._id) } });
    sendData(res, request);
  }),
);
authed.post(
  "/partner/jobs/:id/reject",
  asyncHandler(async (req, res) => {
    const partner = await requireApprovedPartner(String(req.user!._id));
    const request = await InspectionRequest.findOne({ _id: req.params.id, assignedPartnerId: partner._id, status: "offered" });
    if (!request) throw notFound();
    await InspectionAssignment.updateOne({ requestId: request._id, partnerId: partner._id, status: "offered" }, { status: "rejected", reason: String(req.body?.reason || "") });
    request.excludedPartnerIds.push(partner._id);
    request.assignedPartnerId = undefined;
    request.status = "matching";
    await request.save();
    partner.stats!.rejected += 1;
    await partner.save();
    await allocatePartner(String(request._id));
    sendData(res, { rejected: true });
  }),
);
authed.post(
  "/partner/jobs/:id/schedule",
  asyncHandler(async (req, res) => {
    const partner = await requireApprovedPartner(String(req.user!._id));
    const when = z.string().min(8).parse(req.body?.appointmentAt);
    const request = await InspectionRequest.findOneAndUpdate(
      { _id: req.params.id, assignedPartnerId: partner._id, status: { $in: ["accepted", "scheduled"] } },
      { status: "scheduled", appointmentAt: new Date(when) },
      { new: true },
    );
    if (!request) throw notFound();
    await notify({ userId: String(request.buyerId), event: "inspection.scheduled", title: "Inspection scheduled", body: "The partner set an appointment.", data: { requestId: String(request._id) } });
    await notify({ userId: String(request.sellerUserId), event: "inspection.scheduled", title: "Inspection scheduled", body: "A partner scheduled a visit for your listing.", data: { requestId: String(request._id) } });
    sendData(res, request);
  }),
);
authed.post(
  "/partner/jobs/:id/evidence",
  asyncHandler(async (req, res) => {
    const body = z.object({ key: z.string(), caption: z.string().optional(), checklistKey: z.string().optional() }).parse(req.body);
    sendData(res, await addEvidence(req, req.params.id, body), undefined, 201);
  }),
);
authed.post(
  "/partner/jobs/:id/report",
  asyncHandler(async (req, res) => sendData(res, await submitReport(req, req.params.id, req.body), undefined, 201)),
);
authed.patch(
  "/partner/availability",
  asyncHandler(async (req, res) => {
    const body = z.object({ paused: z.boolean().optional(), hours: z.string().optional(), serviceRadiusKm: z.number().min(1).max(100).optional(), categories: z.array(z.string()).optional() }).parse(req.body);
    const partner = await PartnerProfile.findOneAndUpdate({ userId: req.user!._id }, { $set: { ...(body.paused !== undefined ? { "availability.paused": body.paused } : {}), ...(body.hours ? { "availability.hours": body.hours } : {}), ...(body.serviceRadiusKm ? { serviceRadiusKm: body.serviceRadiusKm } : {}), ...(body.categories ? { categories: body.categories } : {}) } }, { new: true });
    if (!partner) throw notFound();
    sendData(res, { paused: partner.availability?.paused, serviceRadiusKm: partner.serviceRadiusKm });
  }),
);
authed.get(
  "/partner/earnings",
  asyncHandler(async (req, res) => {
    const partner = await PartnerProfile.findOne({ userId: req.user!._id });
    if (!partner) throw forbidden();
    sendData(res, await PartnerPayout.find({ partnerId: partner._id }).sort({ createdAt: -1 }).lean());
  }),
);
authed.get(
  "/me/inspections",
  asyncHandler(async (req, res) => {
    const requests = await InspectionRequest.find({ buyerId: req.user!._id }).sort({ createdAt: -1 }).lean();
    const reports = await InspectionReport.find({ requestId: { $in: requests.map((item) => item._id) } }).sort({ version: -1 }).select("requestId").lean();
    const latest = new Map<string, string>();
    for (const report of reports) {
      const key = String(report.requestId);
      if (!latest.has(key)) latest.set(key, String(report._id));
    }
    sendData(res, requests.map((item) => ({ ...item, reportId: latest.get(String(item._id)) })));
  }),
);
authed.get(
  "/inspection-reports/:id/full",
  asyncHandler(async (req, res) => {
    const report = await InspectionReport.findById(req.params.id);
    if (!report) throw notFound();
    const request = await InspectionRequest.findById(report.requestId);
    const partner = await PartnerProfile.findOne({ userId: req.user!._id });
    const allowed =
      req.permissions?.has("*") ||
      String(request?.buyerId) === String(req.user!._id) ||
      String(request?.sellerUserId) === String(req.user!._id) ||
      String(partner?._id) === String(report.partnerId);
    if (!allowed) throw forbidden();
    sendData(res, sanitizeReport(report.toObject()));
  }),
);

authed.post(
  "/ai/listing",
  requirePermission("ai.use"),
  asyncHandler(async (req, res) => sendData(res, await listingAssistant(String(req.user!._id), req.body?.specs || {}, req.body?.notes))),
);
authed.post(
  "/ai/pricing",
  requirePermission("ai.use"),
  asyncHandler(async (req, res) => {
    const specs = req.body?.specs || {};
    const comparables = await Product.find({ status: "active", "specs.model": specs.model, categorySlug: req.body?.categorySlug }).limit(8).select("title pricePaise condition city inspection.published").lean();
    sendData(res, await pricingAssistant(String(req.user!._id), { specs, comparables }));
  }),
);
authed.post(
  "/ai/buyer",
  requirePermission("ai.use"),
  asyncHandler(async (req, res) => {
    const question = z.string().min(3).max(1000).parse(req.body?.question);
    const listings = await searchProducts({ q: question, limit: 6 });
    sendData(res, await buyerAssistant(String(req.user!._id), question, listings.items));
  }),
);
authed.post(
  "/ai/reports/:id/summary",
  requirePermission("ai.use"),
  asyncHandler(async (req, res) => {
    const report = await InspectionReport.findById(req.params.id).lean();
    if (!report) throw notFound();
    sendData(res, await reportSummary(String(req.user!._id), sanitizeReport(report)));
  }),
);

const admin = Router();
admin.use(requireUser, requirePermission("admin.access"));

admin.get(
  "/metrics",
  asyncHandler(async (req, res) => {
    const range: Record<string, Date> = {};
    if (req.query.from) range.$gte = new Date(String(req.query.from));
    if (req.query.to) range.$lte = new Date(String(req.query.to));
    const created = Object.keys(range).length ? { createdAt: range } : {};
    const [users, listings, orders, inspections, reports, payments, refunds, disputes, partners] = await Promise.all([
      User.countDocuments({ ...created, status: "active" }),
      Product.countDocuments({ ...created, deletedAt: null }),
      Order.countDocuments(created),
      InspectionRequest.countDocuments(created),
      InspectionReport.countDocuments(created),
      Payment.aggregate([{ $match: { ...created, status: "captured" } }, { $group: { _id: "$type", amount: { $sum: "$amountPaise" }, count: { $sum: 1 } } }]),
      Refund.countDocuments(created),
      Dispute.countDocuments({ ...created, status: "open" }),
      PartnerProfile.countDocuments({ verificationStatus: "approved" }),
    ]);
    sendData(res, { users, listings, orders, inspections, reports, payments, refunds, openDisputes: disputes, approvedPartners: partners });
  }),
);
admin.get("/users", asyncHandler(async (_req, res) => sendData(res, await User.find().sort({ createdAt: -1 }).limit(100).select("-notificationPreferences").lean())));
admin.get("/listings", asyncHandler(async (req, res) => {
  const filter: Record<string, unknown> = { deletedAt: null };
  if (req.query.status) filter.status = String(req.query.status);
  const items = await Product.find(filter).sort({ createdAt: -1 }).limit(50).lean();
  sendData(res, items.map((item) => presentProduct(item as never, true)));
}));
admin.get("/businesses", asyncHandler(async (_req, res) => sendData(res, await Business.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(50).select("-documents").lean())));
admin.get("/partners", asyncHandler(async (_req, res) => sendData(res, await PartnerProfile.find({ deletedAt: null }).sort({ createdAt: -1 }).limit(50).select("-bank.cipher").lean())));
admin.get("/plans", asyncHandler(async (_req, res) => sendData(res, await SubscriptionPlan.find().sort({ monthlyPricePaise: 1 }).lean())));
admin.get("/inspection-plans", asyncHandler(async (_req, res) => sendData(res, await InspectionPlan.find().sort({ categorySlug: 1, pricePaise: 1 }).lean())));
admin.get("/coupons", asyncHandler(async (_req, res) => sendData(res, await Coupon.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.get("/payouts", asyncHandler(async (_req, res) => sendData(res, await PartnerPayout.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.patch(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["active", "suspended"]).optional(), suspendedReason: z.string().optional(), roles: z.array(z.string()).optional() }).parse(req.body);
    if (body.roles?.includes("super_admin") && !req.user?.roles.includes("super_admin")) throw forbidden("Only a super admin can grant super admin.");
    const user = await User.findById(req.params.id);
    if (!user) throw notFound();
    if (body.roles && user.roles.includes("super_admin") && !body.roles.includes("super_admin")) {
      const others = await User.countDocuments({ _id: { $ne: user._id }, roles: "super_admin", status: "active" });
      if (!others) throw new AppError(409, "LAST_ADMIN", "The last super admin cannot be removed.");
    }
    if (body.status) user.status = body.status;
    if (body.suspendedReason) user.suspendedReason = body.suspendedReason;
    if (body.roles) user.roles = body.roles;
    if (body.status === "suspended") user.tokenValidAfter = new Date();
    await user.save();
    clearPermissionCache();
    await audit(req, "admin.user_updated", "User", String(user._id), body);
    sendData(res, { id: user._id, status: user.status, roles: user.roles });
  }),
);
admin.patch(
  "/businesses/:id/verification",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["approved", "rejected"]), reason: z.string().optional() }).parse(req.body);
    const business = await Business.findByIdAndUpdate(req.params.id, { verificationStatus: body.status, rejectionReason: body.reason }, { new: true });
    if (!business) throw notFound();
    await audit(req, "business.verification", "Business", String(business._id), body);
    await notify({ userId: String(business.ownerId), event: "business.verification", title: `Business ${body.status}`, body: body.reason || `Your business is ${body.status}.` });
    sendData(res, business);
  }),
);
admin.patch(
  "/businesses/:id/sponsor",
  asyncHandler(async (req, res) => {
    const body = z.object({ days: z.number().int().min(0).max(90) }).parse(req.body);
    const business = await Business.findById(req.params.id);
    if (!business) throw notFound();
    business.sponsoredUntil = body.days ? addDays(new Date(), body.days) : undefined;
    await business.save();
    await audit(req, "business.sponsored", "Business", String(business._id), body);
    sendData(res, { id: business._id, sponsoredUntil: business.sponsoredUntil });
  }),
);
admin.get("/settlements", asyncHandler(async (_req, res) => sendData(res, await SellerSettlement.find().sort({ createdAt: -1 }).limit(50).lean())));
admin.post(
  "/settlements",
  asyncHandler(async (req, res) => {
    const body = z.object({
      sellerUserId: z.string().min(8),
      amountPaise: z.number().int().positive(),
      reference: z.string().trim().min(3).max(80),
      note: z.string().max(500).optional(),
    }).parse(req.body);
    const row = await SellerSettlement.create({ ...body, recordedBy: req.user!._id, status: "recorded" });
    await audit(req, "settlement.recorded", "SellerSettlement", String(row._id), { reference: body.reference });
    sendData(res, row, undefined, 201);
  }),
);
admin.patch(
  "/partners/:id/verification",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["approved", "rejected"]), reason: z.string().optional() }).parse(req.body);
    const partner = await PartnerProfile.findByIdAndUpdate(req.params.id, { verificationStatus: body.status, rejectionReason: body.reason }, { new: true });
    if (!partner) throw notFound();
    await audit(req, "partner.verification", "PartnerProfile", String(partner._id), body);
    await notify({ userId: String(partner.userId), event: "partner.verification", title: `Partner application ${body.status}`, body: body.reason || `Your partner profile is ${body.status}.` });
    sendData(res, { id: partner._id, verificationStatus: partner.verificationStatus });
  }),
);
admin.patch(
  "/listings/:id",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["active", "rejected", "archived"]), reason: z.string().optional(), featuredDays: z.number().int().min(0).max(90).optional() }).parse(req.body);
    const listing = await setListingStatus(req.params.id, body.status, body.reason);
    if (body.featuredDays) {
      await Product.updateOne({ _id: req.params.id }, { featuredUntil: addDays(new Date(), body.featuredDays) });
    }
    await audit(req, "listing.moderated", "Product", req.params.id, body);
    const product = await Product.findById(req.params.id);
    if (product) {
      await notify({ userId: String(product.sellerUserId), event: body.status === "active" ? "listing.approved" : "listing.rejected", title: `Listing ${body.status}`, body: body.reason || `Your listing is ${body.status}.` });
    }
    sendData(res, listing);
  }),
);
admin.patch(
  "/plans/:code",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).optional(),
        monthlyPricePaise: z.number().int().nonnegative().optional(),
        annualPricePaise: z.number().int().nonnegative().optional(),
        gracePeriodDays: z.number().int().nonnegative().optional(),
        active: z.boolean().optional(),
        limits: z
          .object({
            activeListings: z.number().int().nonnegative(),
            monthlyListings: z.number().int().nonnegative(),
            photosPerListing: z.number().int().nonnegative(),
            employees: z.number().int().nonnegative(),
          })
          .optional(),
      })
      .parse(req.body);
    const plan = await SubscriptionPlan.findOneAndUpdate({ code: req.params.code }, body, { new: true });
    if (!plan) throw notFound();
    await audit(req, "plan.updated", "SubscriptionPlan", plan.code, body);
    sendData(res, plan);
  }),
);
admin.patch(
  "/inspection-plans/:code",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(2).optional(),
        pricePaise: z.number().int().positive().optional(),
        partnerPayoutPaise: z.number().int().nonnegative().optional(),
        active: z.boolean().optional(),
        checklist: z
          .array(
            z.object({
              key: z.string().min(1),
              label: z.string().min(1),
              group: z.string().optional(),
              critical: z.boolean(),
              weight: z.number().positive(),
            }),
          )
          .optional(),
      })
      .parse(req.body);
    const plan = await InspectionPlan.findOneAndUpdate({ code: req.params.code }, body, { new: true });
    if (!plan) throw notFound();
    await audit(req, "inspection_plan.updated", "InspectionPlan", plan.code, { fields: Object.keys(body) });
    sendData(res, plan);
  }),
);
admin.get("/settings", asyncHandler(async (_req, res) => sendData(res, await PlatformSetting.findOne({ key: "platform" }).lean())));
admin.patch(
  "/settings",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        assignmentTimeoutMinutes: z.number().int().positive().max(24 * 60).optional(),
        maxPartnerDistanceKm: z.number().positive().max(500).optional(),
        refundWindowDays: z.number().int().nonnegative().max(30).optional(),
        cancellationPolicy: z.string().max(2000).optional(),
        homepage: z
          .object({
            hero: z.object({ eyebrow: z.string().max(120), title: z.string().max(160), subtitle: z.string().max(400) }).optional(),
            howItWorks: z.array(z.object({ title: z.string().max(80), body: z.string().max(400) })).max(6).optional(),
            testimonials: z.array(z.object({ name: z.string().max(80), quote: z.string().max(500), city: z.string().max(80).optional() })).max(12).optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const current = await PlatformSetting.findOne({ key: "platform" });
    const previous = (current?.value || {}) as Record<string, unknown>;
    const value = {
      ...previous,
      ...body,
      homepage: body.homepage ? { ...((previous.homepage as object) || {}), ...body.homepage } : previous.homepage,
    };
    const saved = await PlatformSetting.findOneAndUpdate({ key: "platform" }, { value }, { upsert: true, new: true });
    await audit(req, "settings.updated", "PlatformSetting", "platform", { fields: Object.keys(body) });
    sendData(res, saved);
  }),
);
admin.get("/audit", asyncHandler(async (_req, res) => sendData(res, await AuditLog.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.get("/payments", asyncHandler(async (_req, res) => sendData(res, await Payment.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.get("/orders", asyncHandler(async (_req, res) => sendData(res, await Order.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.get("/refunds", asyncHandler(async (_req, res) => sendData(res, await Refund.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.post(
  "/refunds/:id",
  asyncHandler(async (req, res) => sendData(res, await processRefund(req, req.params.id, Boolean(req.body?.approve)))),
);
admin.post(
  "/coupons",
  asyncHandler(async (req, res) => {
    const body = z.object({ code: z.string().min(3), percentOff: z.number().optional(), amountOffPaise: z.number().optional(), minOrderPaise: z.number().default(0), maxUses: z.number().default(100), expiresAt: z.string().optional() }).parse(req.body);
    const coupon = await Coupon.create({ ...body, code: body.code.toUpperCase(), expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined });
    await audit(req, "coupon.created", "Coupon", coupon.code);
    sendData(res, coupon, undefined, 201);
  }),
);
admin.get("/disputes", asyncHandler(async (_req, res) => sendData(res, await Dispute.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.patch(
  "/disputes/:id",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["under_review", "resolved", "rejected"]), resolution: z.string().optional() }).parse(req.body);
    const dispute = await Dispute.findByIdAndUpdate(req.params.id, body, { new: true });
    await audit(req, "dispute.updated", "Dispute", req.params.id, body);
    sendData(res, dispute);
  }),
);
admin.get("/ai/usage", asyncHandler(async (_req, res) => sendData(res, await AIJob.find().sort({ createdAt: -1 }).limit(100).lean())));
admin.post(
  "/ai/risks",
  asyncHandler(async (req, res) => {
    const body = z.object({ subjectType: z.string(), subjectId: z.string(), signals: z.array(z.string()), summary: z.string() }).parse(req.body);
    sendData(res, await recordRiskSignal(body), undefined, 201);
  }),
);
admin.get(
  "/devices/history",
  asyncHandler(async (req, res) => {
    const imei = String(req.query.imei || "");
    if (imei.length < 14) throw new AppError(400, "IMEI_REQUIRED", "Provide an IMEI to search device history.");
    const hash = hashIdentifier(imei);
    const items = await Product.find({ "identifier.imeiHash": hash }).select("title slug status identifier.imeiLast4 createdAt sellerUserId").lean();
    await audit(req, "device.history_viewed", "Product", hash.slice(0, 12));
    sendData(res, items);
  }),
);
admin.post(
  "/payouts/:id/process",
  asyncHandler(async (req, res) => {
    const payout = await PartnerPayout.findById(req.params.id);
    if (!payout) throw notFound();
    payout.status = "processed";
    payout.note = "Marked processed by admin. Transfer the payout through your approved settlement provider.";
    await payout.save();
    const partner = await PartnerProfile.findById(payout.partnerId);
    if (partner) {
      await notify({ userId: String(partner.userId), event: "payout.processed", title: "Payout marked processed", body: "Admin recorded your inspection payout as processed." });
    }
    await audit(req, "payout.processed", "PartnerPayout", String(payout._id));
    sendData(res, payout);
  }),
);

api.post(
  "/payments/webhooks/razorpay",
  asyncHandler(async (req, res) => {
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    sendData(res, await handleWebhook(raw, req.header("x-razorpay-signature")));
  }),
);

api.use("/chat", chat);
api.use(storefront);
api.use(authed);
api.use("/admin", admin);

async function publicUser(id: string) {
  const user = await User.findById(id).lean();
  if (!user) throw notFound();
  const [seller, buyer, businesses, partner, subscription] = await Promise.all([
    SellerProfile.findOne({ userId: id }).lean(),
    BuyerProfile.findOne({ userId: id }).lean(),
    Business.find({ ownerId: id, deletedAt: null }).lean(),
    PartnerProfile.findOne({ userId: id }).select("-bank.cipher -documents").lean(),
    Subscription.findOne({ subjectType: "user", subjectId: id }).sort({ createdAt: -1 }).lean(),
  ]);
  return {
    id: user._id,
    displayName: user.displayName,
    email: user.email,
    phone: user.sharePhone ? user.phone : undefined,
    phoneOnFile: Boolean(user.phone),
    photoUrl: user.photoUrl,
    roles: user.roles,
    status: user.status,
    locale: user.locale,
    referralCode: user.referralCode,
    notificationPreferences: user.notificationPreferences,
    seller,
    buyer: buyer ? { addresses: buyer.addresses, wishlistCount: buyer.wishlist.length, savedSearches: buyer.savedSearches } : null,
    businesses: businesses.map((business) => ({ ...business, documents: business.documents?.map((doc) => ({ name: doc.name, status: doc.status })) })),
    partner,
    subscription,
  };
}

async function requireApprovedPartner(userId: string) {
  const partner = await PartnerProfile.findOne({ userId });
  if (!partner) throw forbidden("Create a partner profile first.");
  if (partner.verificationStatus !== "approved") {
    throw new AppError(403, "PARTNER_NOT_VERIFIED", "Admin verification is required before accepting jobs.");
  }
  return partner;
}

export { publicUser };
