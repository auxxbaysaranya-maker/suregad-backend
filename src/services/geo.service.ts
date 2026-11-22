import type { Model } from "mongoose";
import { z } from "zod";

/**
 * Shared geospatial helpers for every "near me" query (products, showrooms, sellers, partners).
 * Distances are always measured from the caller's discovery point to each record's OWN stored
 * coordinates (GeoJSON `location`, [lng, lat]); the caller's position is never written to records.
 */

export const RADIUS_OPTIONS_KM = [5, 10, 25, 50, 100, 200] as const;
export const DEFAULT_RADIUS_KM = 25;
const EARTH_RADIUS_KM = 6378.1;

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GeoQuery {
  point: GeoPoint;
  radiusKm: number;
}

const geoSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  // Out-of-range radii are clamped below rather than rejected.
  radiusKm: z.coerce.number().finite().optional(),
});

/** Reads lat/lng/radiusKm from a query string. Returns null when no (valid) point was sent. */
export function parseGeoQuery(query: Record<string, unknown>): GeoQuery | null {
  if (query.lat === undefined || query.lng === undefined || query.lat === "" || query.lng === "") return null;
  const parsed = geoSchema.safeParse({ lat: query.lat, lng: query.lng, radiusKm: query.radiusKm || undefined });
  if (!parsed.success) return null;
  const radiusKm = Math.min(200, Math.max(1, parsed.data.radiusKm ?? DEFAULT_RADIUS_KM));
  return { point: { lat: parsed.data.lat, lng: parsed.data.lng }, radiusKm };
}

/** Mongo filter: records whose `field` lies within the radius (usable with other filters, $text and sort). */
export function withinRadius({ point, radiusKm }: GeoQuery) {
  return { $geoWithin: { $centerSphere: [[point.lng, point.lat], radiusKm / EARTH_RADIUS_KM] } };
}

/** Great-circle distance in km. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = (value: number) => (value * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Coordinates of a stored GeoJSON point, or null. */
export function pointOf(location: unknown): GeoPoint | null {
  const coordinates = (location as { coordinates?: number[] } | undefined)?.coordinates;
  if (!coordinates || coordinates.length !== 2 || !coordinates.every(Number.isFinite)) return null;
  return { lng: coordinates[0]!, lat: coordinates[1]! };
}

/** Distance from the discovery point to a record, rounded for display (0.1 km under 10 km). */
export function recordDistanceKm(geo: GeoQuery | null, location: unknown): number | undefined {
  const point = geo ? pointOf(location) : null;
  if (!geo || !point) return undefined;
  const km = distanceKm(geo.point, point);
  return km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
}

/**
 * Nearest-first page of records within the radius, using $geoNear on the 2dsphere-indexed
 * `location` field. `filter` must not use $text (Mongo does not allow it with $geoNear).
 */
export async function nearestPage<T>(
  model: Model<any>,
  geo: GeoQuery,
  filter: Record<string, unknown>,
  page: { skip: number; limit: number },
): Promise<{ items: (T & { distanceMeters: number })[]; total: number }> {
  const [result] = await model.aggregate<{ items: (T & { distanceMeters: number })[]; total: { n: number }[] }>([
    {
      $geoNear: {
        near: { type: "Point", coordinates: [geo.point.lng, geo.point.lat] },
        distanceField: "distanceMeters",
        maxDistance: geo.radiusKm * 1000,
        spherical: true,
        key: "location",
        query: filter,
      },
    },
    { $facet: { items: [{ $skip: page.skip }, { $limit: page.limit }], total: [{ $count: "n" }] } },
  ]);
  return { items: result?.items || [], total: result?.total[0]?.n || 0 };
}

/** Case-insensitive "contains" match for free text, safe for user input. */
export function containsText(value: string) {
  return new RegExp(value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 80), "i");
}
