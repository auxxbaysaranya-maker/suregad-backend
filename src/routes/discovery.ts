import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { asyncHandler, sendData } from "../common/http";
import { Business, PartnerProfile, SellerProfile } from "../models/profiles.model";
import { Product } from "../models/catalog.model";
import { Review } from "../models/engagement.model";
import { activePublic } from "../services/catalog.service";
import { containsText, nearestPage, parseGeoQuery, recordDistanceKm, type GeoQuery } from "../services/geo.service";
import { mediaUrl } from "../integrations/storage";

/**
 * Public "near me" discovery for sellers, showrooms and inspection partners (service providers).
 * Uses the shared geo service; distances are from the shopper's discovery point to each record's
 * own registered location. Exact coordinates, phone numbers and emails are never returned.
 */
export const discovery = Router();

const pageSchema = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.enum(["smartphones", "laptops"]).optional(),
  sort: z.enum(["distance", "rating", "name"]).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  limit: z.coerce.number().int().min(1).max(24).default(12),
});

type SellerCard = {
  id: string;
  kind: "showroom" | "seller";
  name: string;
  path: string;
  city: string | null;
  district: string | null;
  verified: boolean;
  tagline: string | null;
  logoUrl: string | null;
  categories: string[];
  liveListings: number;
  rating: number | null;
  reviews: number;
  distanceKm?: number;
  distanceMeters?: number;
};

async function nearOrAll<T>(model: Parameters<typeof nearestPage>[0], geo: GeoQuery | null, filter: Record<string, unknown>, take: number, fallbackSort: Record<string, 1 | -1>) {
  if (geo) return (await nearestPage<T & { location?: unknown }>(model, geo, filter, { skip: 0, limit: take })).items;
  return (await model.find(filter).sort(fallbackSort).limit(take).lean()) as unknown as (T & { distanceMeters?: number; location?: unknown })[];
}

discovery.get(
  "/discovery/sellers",
  asyncHandler(async (req, res) => {
    const input = pageSchema.extend({ type: z.enum(["all", "showroom", "seller"]).default("all") }).parse(req.query);
    const geo = parseGeoQuery(req.query as Record<string, unknown>);
    // One extra record per source tells us whether another page exists.
    const take = input.page * input.limit + 1;
    const text = input.q ? containsText(input.q) : null;

    const showroomFilter: Record<string, unknown> = { verificationStatus: "approved", deletedAt: null };
    if (text) showroomFilter.$or = [{ name: text }, { "address.city": text }, { "address.district": text }, { "profile.brands": text }];
    if (input.category) showroomFilter["profile.categories"] = input.category;
    const sellerFilter: Record<string, unknown> = { deletedAt: null };
    if (text) sellerFilter.$or = [{ displayName: text }, { city: text }, { district: text }];

    const [showrooms, sellers] = await Promise.all([
      input.type === "seller" ? [] : nearOrAll<Record<string, any>>(Business, geo, showroomFilter, take, { sponsoredUntil: -1, name: 1 }),
      input.type === "showroom" ? [] : nearOrAll<Record<string, any>>(SellerProfile, geo, sellerFilter, take, { verified: -1, displayName: 1 }),
    ]);

    // Live listing counts (and category filter for individual sellers, who have no profile categories).
    const businessIds = showrooms.map((row) => row._id as Types.ObjectId);
    const sellerIds = sellers.map((row) => row.userId as Types.ObjectId);
    const [businessCounts, sellerCounts, ratings] = await Promise.all([
      Product.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { ...activePublic, businessId: { $in: businessIds } } }, { $group: { _id: "$businessId", n: { $sum: 1 } } }]),
      Product.aggregate<{ _id: Types.ObjectId; n: number; categories: string[] }>([
        { $match: { ...activePublic, sellerType: "individual", sellerUserId: { $in: sellerIds }, ...(input.category ? { categorySlug: input.category } : {}) } },
        { $group: { _id: "$sellerUserId", n: { $sum: 1 }, categories: { $addToSet: "$categorySlug" } } },
      ]),
      Review.aggregate<{ _id: Types.ObjectId; avg: number; n: number }>([{ $match: { status: "published", businessId: { $in: businessIds } } }, { $group: { _id: "$businessId", avg: { $avg: "$rating" }, n: { $sum: 1 } } }]),
    ]);
    const count = (rows: { _id: Types.ObjectId; n: number }[], id: unknown) => rows.find((row) => String(row._id) === String(id))?.n || 0;

    let cards: SellerCard[] = [
      ...showrooms.map((row): SellerCard => {
        const rating = ratings.find((entry) => String(entry._id) === String(row._id));
        return {
          id: String(row._id),
          kind: "showroom",
          name: row.name,
          path: `/store/${row.slug}`,
          city: row.address?.city || null,
          district: row.address?.district || null,
          verified: true,
          tagline: row.tagline || null,
          logoUrl: row.logoKey ? mediaUrl(row.logoKey) || null : null,
          categories: row.profile?.categories || [],
          liveListings: count(businessCounts, row._id),
          rating: rating ? Math.round(rating.avg * 10) / 10 : null,
          reviews: rating?.n || 0,
          distanceKm: recordDistanceKm(geo, row.location),
          distanceMeters: row.distanceMeters,
        };
      }),
      ...sellers
        .map((row): SellerCard => {
          const stats = sellerCounts.find((entry) => String(entry._id) === String(row.userId));
          return {
            id: String(row._id),
            kind: "seller",
            name: row.displayName,
            path: `/seller/${row.slug}`,
            city: row.city || null,
            district: row.district || null,
            verified: Boolean(row.verified),
            tagline: row.tagline || null,
            logoUrl: null,
            categories: stats?.categories || [],
            liveListings: stats?.n || 0,
            rating: null,
            reviews: 0,
            distanceKm: recordDistanceKm(geo, row.location),
            distanceMeters: row.distanceMeters,
          };
        })
        // Individual sellers only appear while they have something live (in the chosen category).
        .filter((card) => card.liveListings > 0),
    ];

    const sort = input.sort || (geo ? "distance" : "rating");
    cards.sort((a, b) => {
      if (sort === "distance" && geo) return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
      if (sort === "name") return a.name.localeCompare(b.name);
      return (b.rating ?? 0) - (a.rating ?? 0) || b.liveListings - a.liveListings || a.name.localeCompare(b.name);
    });
    const total = cards.length;
    cards = cards.slice((input.page - 1) * input.limit, input.page * input.limit);
    sendData(
      res,
      cards.map(({ distanceMeters: _distance, ...card }) => card),
      { page: input.page, limit: input.limit, total, hasMore: total > input.page * input.limit, ...(geo ? { radiusKm: geo.radiusKm } : {}) } as never,
    );
  }),
);

discovery.get(
  "/discovery/partners",
  asyncHandler(async (req, res) => {
    const input = pageSchema.parse(req.query);
    const geo = parseGeoQuery(req.query as Record<string, unknown>);
    const filter: Record<string, unknown> = { verificationStatus: "approved", deletedAt: null, "availability.paused": { $ne: true } };
    if (input.category) filter.categories = input.category;
    if (input.q) {
      const text = containsText(input.q);
      filter.$or = [{ name: text }, { "address.city": text }, { "address.district": text }];
    }
    const skip = (input.page - 1) * input.limit;
    const sort = input.sort || (geo ? "distance" : "rating");
    let rows: (Record<string, any> & { distanceMeters?: number })[];
    let total: number;
    if (geo && sort === "distance") {
      const result = await nearestPage<Record<string, any>>(PartnerProfile, geo, filter, { skip, limit: input.limit });
      rows = result.items;
      total = result.total;
    } else {
      const where = geo ? { ...filter, location: { $geoWithin: { $centerSphere: [[geo.point.lng, geo.point.lat], geo.radiusKm / 6378.1] } } } : filter;
      const order: Record<string, 1 | -1> = sort === "name" ? { name: 1 } : { "stats.completed": -1, name: 1 };
      [rows, total] = await Promise.all([PartnerProfile.find(where).sort(order).skip(skip).limit(input.limit).lean(), PartnerProfile.countDocuments(where)]);
    }
    sendData(
      res,
      rows.map((row) => {
        const distanceKm = recordDistanceKm(geo, row.location);
        const stats = row.stats || {};
        return {
          id: String(row._id),
          name: row.name,
          city: row.address?.city || null,
          district: row.address?.district || null,
          categories: row.categories || [],
          experienceYears: row.experienceYears || 0,
          completed: stats.completed || 0,
          rating: stats.ratingCount ? Math.round((stats.ratingSum / stats.ratingCount) * 10) / 10 : null,
          serviceRadiusKm: row.serviceRadiusKm || 0,
          distanceKm,
          /** Whether the shopper is inside the partner's own service area. */
          coversYou: distanceKm !== undefined ? distanceKm <= (row.serviceRadiusKm || 0) : null,
        };
      }),
      { page: input.page, limit: input.limit, total, hasMore: skip + rows.length < total, ...(geo ? { radiusKm: geo.radiusKm } : {}) } as never,
    );
  }),
);
