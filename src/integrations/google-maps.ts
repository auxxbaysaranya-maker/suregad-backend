import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../common/errors";

/**
 * Google Maps Platform, server side only. The key (GOOGLE_MAPS_API_KEY) never leaves the server.
 *  - Places API (New) Autocomplete:   POST https://places.googleapis.com/v1/places:autocomplete
 *  - Places API (New) Place Details:  GET  https://places.googleapis.com/v1/places/{id}   (ends the autocomplete session)
 *  - Geocoding API (reverse):         GET  https://maps.googleapis.com/maps/api/geocode/json?latlng=…
 * Only the fields the marketplace needs are requested (field masks) to keep billing at the Essentials tier.
 */

const PLACES = "https://places.googleapis.com/v1";
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const TIMEOUT_MS = 6000;

export function googleMapsConfigured() {
  return Boolean(env.googleMapsApiKey);
}

export interface Suggestion {
  placeId: string;
  /** e.g. "Mannarkkad" */
  primaryText: string;
  /** e.g. "Palakkad, Kerala, India" */
  secondaryText: string;
  types: string[];
  /** Straight-line distance from the bias point, when known. */
  distanceMeters?: number;
}

export interface ResolvedPlace {
  placeId: string | null;
  lat: number;
  lng: number;
  formattedAddress: string;
  /** Short name for headers, e.g. "Edappally, Kochi". */
  label: string;
  locality: string;
  city: string;
  district: string;
  state: string;
  country: string;
}

type Component = { types: string[]; longText?: string; long_name?: string };

/** Turns Google address components (Places New or Geocoding format) into marketplace fields. */
export function placeFromComponents(input: { placeId: string | null; lat: number; lng: number; formattedAddress?: string; shortAddress?: string; components: Component[] }): ResolvedPlace {
  const find = (...types: string[]) => {
    for (const type of types) {
      const hit = input.components.find((component) => component.types?.includes(type));
      const text = hit?.longText || hit?.long_name;
      if (text) return text;
    }
    return "";
  };
  const locality = find("sublocality_level_1", "sublocality", "neighborhood", "sublocality_level_2");
  const city = find("locality", "postal_town", "administrative_area_level_3") || locality;
  const district = find("administrative_area_level_2", "administrative_area_level_3") || city;
  const state = find("administrative_area_level_1");
  const country = find("country");
  const route = find("route", "premise");
  const first = locality || route;
  const label = [first && first !== city ? first : "", city].filter(Boolean).join(", ") || input.shortAddress || input.formattedAddress || "Selected place";
  return {
    placeId: input.placeId,
    lat: input.lat,
    lng: input.lng,
    formattedAddress: input.formattedAddress || label,
    label,
    locality,
    city: city || district || state,
    district,
    state,
    country,
  };
}

/** Small time-limited cache (Google allows caching place IDs and coordinates for a limited period). */
class Cache<T> {
  private store = new Map<string, { value: T; at: number }>();
  constructor(private ttlMs: number, private max: number) {}
  get(key: string) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T) {
    if (this.store.size >= this.max) this.store.delete(this.store.keys().next().value as string);
    this.store.set(key, { value, at: Date.now() });
  }
}

const placeCache = new Cache<ResolvedPlace>(24 * 60 * 60 * 1000, 5000);
const reverseCache = new Cache<ResolvedPlace>(24 * 60 * 60 * 1000, 5000);

function requireKey() {
  if (!env.googleMapsApiKey) throw new AppError(503, "GEO_NOT_CONFIGURED", "Location search is not configured yet.");
  return env.googleMapsApiKey;
}

/** Maps Google failures to safe API errors; the key and request URL are never included. */
function googleError(status: number, reason: string): AppError {
  if (status === 429 || /RESOURCE_EXHAUSTED|OVER_QUERY_LIMIT|OVER_DAILY_LIMIT/.test(reason)) {
    return new AppError(503, "GEO_QUOTA", "Location search is busy right now. Try again shortly or pick a city.");
  }
  if (status === 401 || status === 403 || /PERMISSION_DENIED|REQUEST_DENIED|API_KEY/.test(reason)) {
    return new AppError(503, "GEO_NOT_AUTHORIZED", "Location search is unavailable. Pick a city instead.");
  }
  if (status === 400 || /INVALID_ARGUMENT|INVALID_REQUEST/.test(reason)) return new AppError(400, "GEO_BAD_REQUEST", "That search could not be completed.");
  return new AppError(503, "GEO_UNAVAILABLE", "Location search is unavailable. Pick a city instead.");
}

async function call<T>(url: string, init: RequestInit, label: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    logger.warn({ api: label, reason: (error as Error).name }, "Google Maps request failed");
    throw new AppError(503, "GEO_UNAVAILABLE", "Location search is unavailable. Pick a city instead.");
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: { status?: string; message?: string }; status?: string; error_message?: string };
  if (!response.ok) {
    const reason = body.error?.status || "";
    logger.warn({ api: label, status: response.status, reason }, "Google Maps error");
    throw googleError(response.status, reason);
  }
  return body;
}

/** Places API (New) Autocomplete. India-first, any place type (localities, streets, addresses). */
export async function autocomplete(input: { text: string; sessionToken: string; near?: { lat: number; lng: number } | null }): Promise<Suggestion[]> {
  const key = requireKey();
  const body: Record<string, unknown> = {
    input: input.text,
    sessionToken: input.sessionToken,
    includedRegionCodes: ["in"],
    regionCode: "IN",
    languageCode: "en",
  };
  if (input.near) {
    const center = { latitude: input.near.lat, longitude: input.near.lng };
    body.locationBias = { circle: { center, radius: 50_000 } };
    body.origin = center;
  }
  const result = await call<{ suggestions?: { placePrediction?: { placeId: string; types?: string[]; distanceMeters?: number; text?: { text: string }; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }[] }>(
    `${PLACES}/places:autocomplete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types,suggestions.placePrediction.distanceMeters",
      },
      body: JSON.stringify(body),
    },
    "places.autocomplete",
  );
  return (result.suggestions || [])
    .map((suggestion) => suggestion.placePrediction)
    .filter((prediction): prediction is NonNullable<typeof prediction> => Boolean(prediction?.placeId))
    .map((prediction) => ({
      placeId: prediction.placeId,
      primaryText: prediction.structuredFormat?.mainText?.text || prediction.text?.text || "",
      secondaryText: prediction.structuredFormat?.secondaryText?.text || "",
      types: prediction.types || [],
      distanceMeters: prediction.distanceMeters,
    }));
}

/**
 * Places API (New) Place Details for the chosen suggestion. Passing the same session token closes the
 * autocomplete session (Google bills the session, not each keystroke). Essentials-tier fields only.
 */
export async function placeDetails(placeId: string, sessionToken?: string): Promise<ResolvedPlace> {
  const cached = placeCache.get(placeId);
  if (cached) return cached;
  const key = requireKey();
  const query = new URLSearchParams({ languageCode: "en", regionCode: "IN" });
  if (sessionToken) query.set("sessionToken", sessionToken);
  const place = await call<{ id: string; formattedAddress?: string; shortFormattedAddress?: string; location?: { latitude: number; longitude: number }; addressComponents?: Component[] }>(
    `${PLACES}/places/${encodeURIComponent(placeId)}?${query}`,
    { method: "GET", headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,formattedAddress,shortFormattedAddress,location,addressComponents" } },
    "places.details",
  );
  if (!place.location) throw new AppError(404, "GEO_NOT_FOUND", "That place has no map position.");
  const resolved = placeFromComponents({
    placeId: place.id,
    lat: place.location.latitude,
    lng: place.location.longitude,
    formattedAddress: place.formattedAddress,
    shortAddress: place.shortFormattedAddress,
    components: place.addressComponents || [],
  });
  placeCache.set(placeId, resolved);
  return resolved;
}

/** Geocoding API reverse lookup for a device position (cached on a ~110 m grid). */
export async function reverseGeocode(point: { lat: number; lng: number }): Promise<ResolvedPlace> {
  const cacheKey = `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
  const cached = reverseCache.get(cacheKey);
  if (cached) return { ...cached, lat: point.lat, lng: point.lng };
  const key = requireKey();
  const query = new URLSearchParams({ latlng: `${point.lat},${point.lng}`, language: "en", region: "in", key });
  const result = await call<{ status: string; results?: { place_id: string; formatted_address: string; address_components: Component[] }[] }>(`${GEOCODE}?${query}`, { method: "GET" }, "geocode.reverse");
  // Check the status first: quota and key errors also come back with no results.
  if (result.status !== "OK" && result.status !== "ZERO_RESULTS") {
    logger.warn({ api: "geocode.reverse", status: result.status }, "Google Maps error");
    throw googleError(200, result.status);
  }
  if (!result.results?.length) throw new AppError(404, "GEO_NOT_FOUND", "No address found for this position.");
  const best = result.results[0]!;
  const resolved = placeFromComponents({ placeId: best.place_id, lat: point.lat, lng: point.lng, formattedAddress: best.formatted_address, components: best.address_components });
  reverseCache.set(cacheKey, resolved);
  return resolved;
}
