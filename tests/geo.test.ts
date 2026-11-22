import { describe, expect, it } from "vitest";
import { DEFAULT_RADIUS_KM, containsText, distanceKm, parseGeoQuery, pointOf, recordDistanceKm, withinRadius } from "../src/services/geo.service";

const KOCHI = { lat: 9.9312, lng: 76.2673 };
const PALAKKAD = { lat: 10.7867, lng: 76.6548 };

describe("geo service", () => {
  it("parses a discovery point with the default 25 km radius", () => {
    expect(parseGeoQuery({ lat: "9.9312", lng: "76.2673" })).toEqual({ point: KOCHI, radiusKm: DEFAULT_RADIUS_KM });
  });

  it("caps the radius at 200 km and ignores invalid points", () => {
    expect(parseGeoQuery({ lat: "9.9", lng: "76.2", radiusKm: "900" })?.radiusKm).toBe(200);
    expect(parseGeoQuery({ lat: "abc", lng: "76.2" })).toBeNull();
    expect(parseGeoQuery({ lat: "95", lng: "76.2" })).toBeNull();
    expect(parseGeoQuery({ lng: "76.2" })).toBeNull();
    expect(parseGeoQuery({ lat: "", lng: "" })).toBeNull();
  });

  it("measures Palakkad to Kochi as roughly 104 km", () => {
    const km = distanceKm(PALAKKAD, KOCHI);
    expect(km).toBeGreaterThan(100);
    expect(km).toBeLessThan(110);
  });

  it("builds a radius filter in [lng, lat] order with the radius in radians", () => {
    const filter = withinRadius({ point: KOCHI, radiusKm: 25 }) as { $geoWithin: { $centerSphere: [[number, number], number] } };
    expect(filter.$geoWithin.$centerSphere[0]).toEqual([KOCHI.lng, KOCHI.lat]);
    expect(filter.$geoWithin.$centerSphere[1]).toBeCloseTo(25 / 6378.1, 8);
  });

  it("reads stored GeoJSON points and rejects half-empty ones", () => {
    expect(pointOf({ type: "Point", coordinates: [76.2673, 9.9312] })).toEqual(KOCHI);
    expect(pointOf({ type: "Point", coordinates: [] })).toBeNull();
    expect(pointOf(undefined)).toBeNull();
  });

  it("rounds record distances (0.1 km under 10 km) and needs both points", () => {
    const geo = { point: KOCHI, radiusKm: 25 };
    expect(recordDistanceKm(geo, { coordinates: [76.2673, 9.9312] })).toBe(0);
    expect(recordDistanceKm(geo, { coordinates: [PALAKKAD.lng, PALAKKAD.lat] })).toBeGreaterThan(100);
    expect(recordDistanceKm(null, { coordinates: [76.2673, 9.9312] })).toBeUndefined();
    expect(recordDistanceKm(geo, undefined)).toBeUndefined();
  });

  it("escapes regex characters in free-text search", () => {
    expect(containsText("a.b*(c)").test("a.b*(c)")).toBe(true);
    expect(containsText("a.b").test("axb")).toBe(false);
  });
});
