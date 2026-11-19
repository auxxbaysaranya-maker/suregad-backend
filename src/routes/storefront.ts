import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { requireUser } from "../middleware/auth";
import { asyncHandler, sendData } from "../common/http";
import { AppError, forbidden, notFound } from "../common/errors";
import { Business, SellerProfile } from "../models/profiles.model";
import { Product } from "../models/catalog.model";
import { Review } from "../models/engagement.model";
import { User } from "../models/user.model";
import { mediaUrl } from "../integrations/storage";
import { presentProduct } from "../services/catalog.service";
import { audit } from "../services/audit.service";

export const storefront = Router();

type Social = { website?: string | null; instagram?: string | null; facebook?: string | null; youtube?: string | null; x?: string | null; whatsapp?: string | null } | null | undefined;

function cleanSocial(social: Social) {
  const out: Record<string, string> = {};
  for (const key of ["website", "instagram", "facebook", "youtube", "x", "whatsapp"] as const) {
    const value = social?.[key];
    if (value) out[key] = value;
  }
  return out;
}

function roundedPoint(location: unknown, exact: boolean) {
  const coordinates = (location as { coordinates?: number[] } | undefined)?.coordinates;
  if (!coordinates || coordinates.length !== 2) return null;
  const [lng, lat] = coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return exact ? { lat, lng, exact: true } : { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100, exact: false };
}

/** Reviews of the seller/store plus reviews of their listings, with an overall rating and star breakdown. */
async function reviewSummary(targetType: "seller" | "business", targetId: unknown, productIds: unknown[]) {
  const rows = await Review.find({
    status: "published",
    $or: [{ targetType, targetId }, { targetType: "product", targetId: { $in: productIds } }],
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const authors = await User.find({ _id: { $in: rows.map((row) => row.authorId) } }).select("displayName").lean();
  const authorName = new Map(authors.map((author) => [String(author._id), author.displayName?.split(" ")[0] || "Buyer"]));
  const breakdown: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let total = 0;
  for (const row of rows) {
    breakdown[row.rating] = (breakdown[row.rating] || 0) + 1;
    total += row.rating;
  }
  return {
    rating: rows.length ? Math.round((total / rows.length) * 10) / 10 : null,
    reviewCount: rows.length,
    breakdown,
    reviews: rows.slice(0, 30).map((row) => ({
      id: String(row._id),
      rating: row.rating,
      body: row.body,
      author: authorName.get(String(row.authorId)) || "Buyer",
      verifiedPurchase: row.verifiedPurchase,
      sellerReply: row.sellerReply || null,
      about: row.targetType === "product" ? "product" : "seller",
      createdAt: row.createdAt,
    })),
  };
}

async function listingsFor(filter: Record<string, unknown>) {
  const rows = await Product.find({ ...filter, deletedAt: null, published: { $ne: false }, businessHold: { $ne: true }, status: { $in: ["active", "reserved", "sold"] } })
    .sort({ status: 1, createdAt: -1 })
    .limit(120)
    .lean();
  const active = rows.filter((row) => row.status === "active");
  return {
    rows,
    stats: {
      activeListings: active.length,
      soldListings: rows.filter((row) => row.status === "sold").length,
      inspectedListings: active.filter((row) => row.inspection?.published).length,
    },
    listings: rows.map((row) => presentProduct(row as never)),
  };
}

storefront.get(
  "/sellers/:slug",
  asyncHandler(async (req, res) => {
    const seller = await SellerProfile.findOne({ slug: req.params.slug, deletedAt: null }).lean();
    if (!seller) throw notFound("Seller not found.");
    const user = await User.findById(seller.userId).select("displayName photoUrl phone sharePhone createdAt status").lean();
    if (!user || user.status !== "active") throw notFound("Seller not found.");
    const { rows, stats, listings } = await listingsFor({ sellerUserId: seller.userId, sellerType: "individual" });
    const reviews = await reviewSummary("seller", seller.userId, rows.map((row) => row._id));
    const social = cleanSocial(seller.social);
    sendData(res, {
      kind: "seller",
      id: String(seller._id),
      slug: seller.slug,
      name: seller.displayName,
      tagline: seller.tagline || "",
      about: seller.bio || "",
      verified: Boolean(seller.verified),
      memberSince: user.createdAt,
      logo: user.photoUrl || null,
      banner: null,
      city: seller.city,
      district: seller.district,
      state: seller.state,
      address: null,
      hours: null,
      location: roundedPoint(seller.location, false),
      contact: {
        phone: user.sharePhone && user.phone ? user.phone : null,
        email: null,
        whatsapp: social.whatsapp || null,
      },
      social,
      stats: { ...stats, rating: reviews.rating, reviewCount: reviews.reviewCount },
      ratingBreakdown: reviews.breakdown,
      reviews: reviews.reviews,
      listings,
    });
  }),
);

storefront.get(
  "/stores/:slug",
  asyncHandler(async (req, res) => {
    const store = await Business.findOne({ slug: req.params.slug, deletedAt: null }).lean();
    if (!store || store.verificationStatus !== "approved") throw notFound("Store not found.");
    const owner = await User.findById(store.ownerId).select("createdAt").lean();
    const { rows, stats, listings } = await listingsFor({ businessId: store._id });
    const reviews = await reviewSummary("business", store._id, rows.map((row) => row._id));
    const social = cleanSocial(store.social);
    const address = store.address
      ? { line1: store.address.line1, line2: store.address.line2, city: store.address.city, district: store.address.district, state: store.address.state, pincode: store.address.pincode }
      : null;
    sendData(res, {
      kind: "store",
      id: String(store._id),
      slug: store.slug,
      name: store.name,
      tagline: store.tagline || "",
      about: store.description || "",
      verified: true,
      sponsored: Boolean(store.sponsoredUntil && store.sponsoredUntil > new Date()),
      memberSince: store.createdAt || owner?.createdAt,
      logo: store.logoKey ? mediaUrl(store.logoKey) : null,
      banner: store.bannerKey ? mediaUrl(store.bannerKey) : null,
      city: store.address?.city,
      district: store.address?.district,
      state: store.address?.state,
      address,
      hours: store.hours || null,
      // A showroom's address is public, so its pin is exact.
      location: roundedPoint(store.location, true),
      contact: { phone: store.phone || null, email: store.email || null, whatsapp: social.whatsapp || null },
      social,
      stats: { ...stats, rating: reviews.rating, reviewCount: reviews.reviewCount },
      ratingBreakdown: reviews.breakdown,
      reviews: reviews.reviews,
      listings,
    });
  }),
);

const link = z
  .string()
  .trim()
  .max(300)
  .refine((value) => value === "" || /^https?:\/\/[^\s]+$/i.test(value), "Use a full link starting with https://");
const editSchema = z.object({
  businessId: z.string().optional(),
  tagline: z.string().trim().max(120).optional(),
  about: z.string().trim().max(4000).optional(),
  hours: z.string().trim().max(200).optional(),
  logoKey: z.string().max(300).optional(),
  bannerKey: z.string().max(300).optional(),
  social: z
    .object({
      website: link.optional(),
      instagram: link.optional(),
      facebook: link.optional(),
      youtube: link.optional(),
      x: link.optional(),
      whatsapp: z.string().trim().max(20).regex(/^\+?[\d\s-]*$/, "Use digits only, with country code").optional(),
    })
    .optional(),
});

async function ownedBusiness(userId: string, businessId: string) {
  if (!Types.ObjectId.isValid(businessId)) throw notFound("Business not found.");
  const business = await Business.findOne({ _id: businessId, deletedAt: null });
  if (!business) throw notFound("Business not found.");
  if (String(business.ownerId) !== userId) throw forbidden();
  return business;
}

/** What the owner can edit, plus the public page address. */
storefront.get(
  "/me/storefront",
  requireUser,
  asyncHandler(async (req, res) => {
    const userId = String(req.user!._id);
    if (req.query.businessId) {
      const business = await ownedBusiness(userId, String(req.query.businessId));
      sendData(res, {
        kind: "store",
        businessId: String(business._id),
        name: business.name,
        publicPath: business.verificationStatus === "approved" ? `/store/${business.slug}` : null,
        verificationStatus: business.verificationStatus,
        tagline: business.tagline || "",
        about: business.description || "",
        hours: business.hours || "",
        logo: business.logoKey ? mediaUrl(business.logoKey) : null,
        banner: business.bannerKey ? mediaUrl(business.bannerKey) : null,
        social: cleanSocial(business.social),
      });
      return;
    }
    const seller = await SellerProfile.findOne({ userId, deletedAt: null });
    if (!seller) throw new AppError(404, "NO_STOREFRONT", "Create a seller profile before editing a storefront.");
    sendData(res, {
      kind: "seller",
      name: seller.displayName,
      publicPath: `/seller/${seller.slug}`,
      tagline: seller.tagline || "",
      about: seller.bio || "",
      hours: "",
      logo: null,
      banner: null,
      social: cleanSocial(seller.social),
    });
  }),
);

storefront.patch(
  "/me/storefront",
  requireUser,
  asyncHandler(async (req, res) => {
    const userId = String(req.user!._id);
    const body = editSchema.parse(req.body);
    const social = body.social
      ? Object.fromEntries(Object.entries(body.social).map(([key, value]) => [key, value ? value : undefined]))
      : undefined;
    for (const key of [body.logoKey, body.bannerKey]) {
      if (key && (!key.startsWith("public/") || !key.includes(`/${userId}/`) || key.includes(".."))) {
        throw new AppError(400, "INVALID_IMAGE", "Upload the image again before saving.");
      }
    }
    if (body.businessId) {
      const business = await ownedBusiness(userId, body.businessId);
      if (body.tagline !== undefined) business.tagline = body.tagline;
      if (body.about !== undefined) business.description = body.about;
      if (body.hours !== undefined) business.hours = body.hours;
      if (body.logoKey) business.logoKey = body.logoKey;
      if (body.bannerKey) business.bannerKey = body.bannerKey;
      if (social) business.set("social", social);
      await business.save();
      await audit(req, "storefront.updated", "Business", String(business._id));
      sendData(res, { saved: true });
      return;
    }
    const seller = await SellerProfile.findOne({ userId, deletedAt: null });
    if (!seller) throw new AppError(404, "NO_STOREFRONT", "Create a seller profile before editing a storefront.");
    if (body.tagline !== undefined) seller.tagline = body.tagline;
    if (body.about !== undefined) seller.bio = body.about;
    if (social) seller.set("social", social);
    await seller.save();
    sendData(res, { saved: true });
  }),
);
