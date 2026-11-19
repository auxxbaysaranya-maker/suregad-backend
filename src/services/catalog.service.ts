import { z } from "zod";
import { laptopSpecsSchema, productWriteSchema, smartphoneSpecsSchema } from "../shared/validation";
import { Brand, Category, Product, ProductModel } from "../models/catalog.model";
import { Business, SellerProfile } from "../models/profiles.model";
import { AppError, forbidden, notFound } from "../common/errors";
import { encryptSecret, hashIdentifier, lastDigits, slugify } from "../common/crypto";
import { mediaUrl } from "../integrations/storage";
import { assertCanCreateListing, getEntitlements, recordUsage } from "./entitlement.service";
import type { Request } from "express";

export const activePublic = { status: "active", deletedAt: null, "inventory.state": { $ne: "sold" }, published: { $ne: false }, businessHold: { $ne: true } };

export function presentProduct(product: Record<string, unknown>, detailed = false) {
  const images = ((product.images as { key?: string; url?: string; sort?: number }[]) || []).map((image) => ({
    key: image.key,
    url: image.url || mediaUrl(image.key),
    sort: image.sort,
  }));
  const inspection = (product.inspection || {}) as {
    inspected?: boolean;
    published?: boolean;
    score?: number;
    critical?: boolean;
    reportId?: unknown;
  };
  return {
    id: String(product._id),
    title: product.title,
    slug: product.slug,
    description: detailed ? product.description : undefined,
    condition: product.condition,
    pricePaise: product.pricePaise,
    specs: product.specs,
    categorySlug: product.categorySlug,
    sellerType: product.sellerType,
    sellerUserId: product.sellerUserId ? String(product.sellerUserId) : undefined,
    businessId: product.businessId ? String(product.businessId) : undefined,
    city: product.city,
    district: product.district,
    state: product.state,
    images,
    status: publicStatus(product),
    stats: product.stats,
    featured: Boolean(product.featuredUntil && new Date(String(product.featuredUntil)) > new Date()),
    inspection: inspection.published
      ? {
          inspected: true,
          score: inspection.score,
          critical: inspection.critical,
          reportId: inspection.reportId ? String(inspection.reportId) : undefined,
        }
      : { inspected: false },
    geo: approximateGeo(product.location),
    createdAt: product.createdAt,
    listingCode: product.listingCode || undefined,
    itemType: product.itemType || "used",
    stock: product.stockTracked ? { available: Number((product.stock as { available?: number } | undefined)?.available || 0) } : undefined,
    warrantyMonths: product.warrantyMonths || 0,
    returnWindowDays: product.returnWindowDays || 0,
    deliveryAvailable: product.deliveryAvailable !== false,
    pickupAvailable: product.pickupAvailable !== false,
  };
}

/** Buyers see a stock-tracked listing as reserved/sold only when no unit is left to buy. */
function publicStatus(product: Record<string, unknown>) {
  if (product.status !== "active") return product.status;
  if (product.published === false || product.businessHold === true) return "archived";
  if (!product.stockTracked) return product.status;
  const state = (product.inventory as { state?: string } | undefined)?.state;
  return state === "available" ? "active" : state === "reserved" ? "reserved" : "sold";
}

/** Listing position rounded to two decimals (about 1 km) so the map shows the area, not the doorstep. */
function approximateGeo(location: unknown): { lat: number; lng: number } | undefined {
  const coordinates = (location as { coordinates?: number[] } | undefined)?.coordinates;
  if (!coordinates || coordinates.length !== 2) return undefined;
  const [lng, lat] = coordinates;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
}

export async function createListing(req: Request, body: unknown) {
  const input = productWriteSchema.parse(body);
  const user = req.user;
  if (!user) throw forbidden();
  if (input.sellerType === "individual" && !user.roles.includes("individual_seller") && !req.permissions?.has("*")) {
    throw forbidden("Create an individual seller profile before listing a device.");
  }
  let businessId: string | undefined;
  if (input.sellerType === "business") {
    if (!input.businessId) throw new AppError(400, "BUSINESS_REQUIRED", "Choose a business for this listing.");
    const business = await Business.findOne({ _id: input.businessId, deletedAt: null });
    if (!business) throw notFound("Business not found.");
    const isOwner = String(business.ownerId) === String(user._id);
    const grant = user.employeeGrants?.find((item) => String(item.businessId) === String(business._id));
    if (!isOwner && !(grant?.permissions || []).includes("products.create") && !req.permissions?.has("*")) {
      throw forbidden();
    }
    if (business.verificationStatus !== "approved" && !req.permissions?.has("*")) {
      throw new AppError(403, "BUSINESS_NOT_VERIFIED", "This business is waiting for admin verification.");
    }
    businessId = String(business._id);
  }
  const category = await Category.findOne({ slug: input.categorySlug, active: true });
  if (!category) throw new AppError(400, "UNKNOWN_CATEGORY", "That category is not available.");
  const specs =
    input.categorySlug === "smartphones"
      ? smartphoneSpecsSchema.parse(input.specs)
      : laptopSpecsSchema.parse(input.specs);
  assertOwnImageKeys(input.imageKeys, String(user._id));
  const entitlements = await assertCanCreateListing({
    userId: String(user._id),
    businessId,
    imageCount: input.imageKeys.length,
  });
  const brand = await Brand.findOne({
    name: new RegExp(`^${specs.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  });
  const identifier: Record<string, string> = {};
  if (input.imei) {
    identifier.imeiHash = hashIdentifier(input.imei);
    identifier.imeiLast4 = lastDigits(input.imei);
    identifier.imeiCipher = encryptSecret(input.imei);
    const existing = await Product.findOne({ "identifier.imeiHash": identifier.imeiHash, deletedAt: null });
    if (existing) throw new AppError(409, "DUPLICATE_DEVICE", "A listing already exists for this IMEI.");
  }
  if (input.serialNumber) {
    identifier.serialHash = hashIdentifier(input.serialNumber);
    identifier.serialLast4 = lastDigits(input.serialNumber);
    identifier.serialCipher = encryptSecret(input.serialNumber);
    const existing = await Product.findOne({ "identifier.serialHash": identifier.serialHash, deletedAt: null });
    if (existing) throw new AppError(409, "DUPLICATE_DEVICE", "A listing already exists for this serial number.");
  }
  const duplicate = await Product.findOne({
    sellerUserId: user._id,
    categorySlug: input.categorySlug,
    title: input.title,
    deletedAt: null,
    status: { $nin: ["archived", "sold"] },
    "specs.model": specs.model,
    "specs.storageGb": specs.storageGb,
  });
  if (duplicate) {
    throw new AppError(409, "DUPLICATE_LISTING", "You already have an open listing for this device.");
  }
  const coordinates = input.location.coordinates
    ? [input.location.coordinates.lng, input.location.coordinates.lat]
    : undefined;
  const product = await Product.create({
    sellerUserId: user._id,
    sellerType: input.sellerType,
    businessId,
    categoryId: category._id,
    categorySlug: category.slug,
    brandId: brand?._id,
    title: input.title,
    slug: slugify(input.title),
    description: input.description,
    condition: input.condition,
    pricePaise: input.pricePaise,
    specs,
    images: input.imageKeys.map((key, sort) => ({ key, url: mediaUrl(key), sort })),
    city: input.location.city,
    district: input.location.district,
    state: input.location.state,
    pincode: input.location.pincode,
    location: coordinates ? { type: "Point", coordinates } : undefined,
    status: input.submit ? "pending_review" : "draft",
    identifier,
    inventory: { state: "available" },
  });
  await recordUsage(entitlements.subscriptionId, "listing_created", { productId: product._id });
  return presentProduct(product.toObject(), true);
}

export async function searchProducts(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(48, Math.max(1, Number(query.limit) || 12));
  const filter: Record<string, unknown> = { ...activePublic };
  if (query.q) filter.$text = { $search: String(query.q) };
  if (query.category) filter.categorySlug = String(query.category);
  if (query.condition) filter.condition = String(query.condition);
  if (query.sellerType) filter.sellerType = String(query.sellerType);
  if (query.city) filter.city = new RegExp(`^${String(query.city).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  if (query.district) filter.district = new RegExp(String(query.district), "i");
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  if (query.lat !== undefined && query.lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    const radiusKm = Math.min(500, Math.max(1, Number(query.radiusKm) || 50));
    filter.location = { $geoWithin: { $centerSphere: [[lng, lat], radiusKm / 6378.1] } };
  }
  if (query.minPrice || query.maxPrice) {
    filter.pricePaise = {
      ...(query.minPrice ? { $gte: Number(query.minPrice) * 100 } : {}),
      ...(query.maxPrice ? { $lte: Number(query.maxPrice) * 100 } : {}),
    };
  }
  if (query.ram) filter["specs.ramGb"] = Number(query.ram);
  if (query.storage) filter["specs.storageGb"] = Number(query.storage);
  if (query.processor) filter["specs.processor"] = new RegExp(String(query.processor), "i");
  if (query.screenSize) filter["specs.displayInches"] = Number(query.screenSize);
  if (query.brand) {
    const brand = await Brand.findOne({ slug: String(query.brand) });
    if (brand) filter.brandId = brand._id;
    else filter["specs.brand"] = new RegExp(`^${String(query.brand)}$`, "i");
  }
  if (query.model) filter["specs.model"] = new RegExp(String(query.model), "i");
  if (query.warranty === "true") filter["specs.warranty.available"] = true;
  if (query.inspected === "true") {
    filter["inspection.published"] = true;
    filter["inspection.inspected"] = true;
  }
  if (query.verifiedSeller === "true") {
    const sellers = await SellerProfile.find({ verified: true }).select("userId");
    filter.sellerUserId = { $in: sellers.map((seller) => seller.userId) };
  }
  const sortMap: Record<string, Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    price_asc: { pricePaise: 1 },
    price_desc: { pricePaise: -1 },
    views: { "stats.views": -1 },
    recommended: { featuredUntil: -1, createdAt: -1 },
  };
  const sort = sortMap[String(query.sort || "recommended")] || sortMap.recommended;
  const [items, total] = await Promise.all([
    Product.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);
  return {
    items: items.map((item) => presentProduct(item as Record<string, unknown>)),
    meta: { page, limit, total, hasMore: page * limit < total },
  };
}

export const reviewModerationSchema = z.object({
  status: z.enum(["active", "rejected", "archived"]),
  reason: z.string().max(500).optional(),
});

export async function setListingStatus(productId: string, status: string, reason?: string) {
  const product = await Product.findOne({ _id: productId, deletedAt: null });
  if (!product) throw notFound("Listing not found.");
  if (status === "active" && product.inventory?.state === "sold") {
    throw new AppError(409, "ALREADY_SOLD", "A sold device cannot be republished.");
  }
  product.status = status as never;
  if (status === "rejected") product.rejectionReason = reason || "Rejected by moderation.";
  if (status === "archived") {
    product.deletedAt = new Date();
    if (product.identifier?.imeiHash) product.identifier.imeiHash = `archived:${product.id}:${product.identifier.imeiHash}`;
    if (product.identifier?.serialHash) {
      product.identifier.serialHash = `archived:${product.id}:${product.identifier.serialHash}`;
    }
  }
  await product.save();
  return presentProduct(product.toObject(), true);
}

export async function listModels(categorySlug?: string, brandSlug?: string) {
  const filter: Record<string, unknown> = { active: true };
  if (categorySlug) filter.categorySlug = categorySlug;
  if (brandSlug) {
    const brand = await Brand.findOne({ slug: brandSlug });
    if (!brand) return [];
    filter.brandId = brand._id;
  }
  return ProductModel.find(filter).sort({ name: 1 }).limit(200).lean();
}

/** Photo keys must come from this user's own product_image uploads. */
function assertOwnImageKeys(keys: string[], userId: string, alreadyOnListing: Set<string> = new Set()) {
  for (const key of keys) {
    if (alreadyOnListing.has(key)) continue;
    if (key.includes("..") || !key.startsWith(`public/product_image/${userId}/`)) {
      throw new AppError(400, "INVALID_IMAGE", "One of the photos was not uploaded from this account. Upload it again.");
    }
  }
}

export const listingImagesSchema = z.object({
  imageKeys: z.array(z.string().min(3).max(300)).min(1, "Keep at least one photo.").max(20),
});

/**
 * Replace a listing's photos (add, remove or reorder; the first photo is the cover).
 * Photos already on the listing may be kept; new ones must be the owner's uploads.
 * The plan's photo limit applies, and an active listing goes back to review.
 */
export async function updateListingImages(req: Request, productId: string, body: unknown) {
  const { imageKeys } = listingImagesSchema.parse(body);
  const product = await Product.findOne({ _id: productId, deletedAt: null });
  if (!product) throw notFound("Listing not found.");
  const userId = String(req.user!._id);
  const admin = Boolean(req.permissions?.has("*"));
  if (String(product.sellerUserId) !== userId && !admin) throw forbidden();
  if (product.inventory?.state === "sold") throw new AppError(409, "SOLD", "Sold listings cannot be edited.");
  const unique = [...new Set(imageKeys)];
  const existing = new Map((product.images || []).map((image) => [image.key || "", image.url || mediaUrl(image.key) || ""]));
  if (!admin) assertOwnImageKeys(unique, userId, new Set(existing.keys()));
  const entitlements = await getEntitlements({
    userId: String(product.sellerUserId),
    businessId: product.businessId ? String(product.businessId) : undefined,
  });
  const limit = entitlements.active ? entitlements.limits.photosPerListing : Math.max(existing.size, 1);
  if (!admin && unique.length > limit) {
    throw new AppError(403, "PHOTO_LIMIT", `Your plan allows up to ${limit} photos per listing.`);
  }
  product.set(
    "images",
    unique.map((key, sort) => ({ key, url: existing.get(key) || mediaUrl(key), sort })),
  );
  if (product.status === "active" && !admin) product.status = "pending_review";
  await product.save();
  return presentProduct(product.toObject(), true);
}
