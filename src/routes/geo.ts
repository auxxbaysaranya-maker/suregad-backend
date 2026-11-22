import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncHandler, sendData } from "../common/http";
import { env } from "../config/env";
import { autocomplete, googleMapsConfigured, placeDetails, reverseGeocode } from "../integrations/google-maps";

/**
 * Location search proxy. Browsers call these endpoints; only the server talks to Google with the key.
 * Responses contain place data only — never the key or Google request URLs.
 */
export const geo = Router();

/** Typing produces bursts; 90 calls a minute per visitor is plenty and protects the Google quota. */
const geoLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: env.isTest ? 10_000 : 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "GEO_RATE_LIMITED", message: "Too many location searches. Wait a moment and try again." } },
});
geo.use("/geo", geoLimiter);

/** RFC 4122 v4 UUID — the autocomplete session token format Google expects. */
const sessionToken = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Invalid session token.");
const point = { lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) };

geo.get("/geo/status", (_req, res) => sendData(res, { configured: googleMapsConfigured(), provider: googleMapsConfigured() ? "google" : null }));

geo.post(
  "/geo/autocomplete",
  asyncHandler(async (req, res) => {
    const body = z
      .object({ input: z.string().trim().min(2).max(120), sessionToken, lat: point.lat.optional(), lng: point.lng.optional() })
      .parse(req.body);
    const near = body.lat !== undefined && body.lng !== undefined ? { lat: body.lat, lng: body.lng } : null;
    sendData(res, await autocomplete({ text: body.input, sessionToken: body.sessionToken, near }));
  }),
);

geo.get(
  "/geo/place/:placeId",
  asyncHandler(async (req, res) => {
    const placeId = z.string().regex(/^[A-Za-z0-9_-]{10,400}$/, "Invalid place.").parse(req.params.placeId);
    const token = req.query.sessionToken ? sessionToken.parse(req.query.sessionToken) : undefined;
    sendData(res, await placeDetails(placeId, token));
  }),
);

geo.get(
  "/geo/reverse",
  asyncHandler(async (req, res) => {
    const position = z.object(point).parse(req.query);
    sendData(res, await reverseGeocode(position));
  }),
);
