import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "AIzaTESTKEY0123456789abcdefghijklmnopq"; // fake, 39 chars

async function load(key: string | undefined = KEY) {
  vi.resetModules();
  if (key === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = key;
  return import("../src/integrations/google-maps");
}

function respond(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const SESSION = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

describe("Google Maps integration", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("autocomplete: India-first request, key in a header, minimal field mask", async () => {
    const maps = await load();
    fetchMock.mockReturnValueOnce(
      respond(200, {
        suggestions: [
          { placePrediction: { placeId: "ChIJmannarkkad000001", types: ["locality"], distanceMeters: 41000, structuredFormat: { mainText: { text: "Mannarkkad" }, secondaryText: { text: "Palakkad, Kerala, India" } } } },
          { placePrediction: { placeId: "ChIJmannarkkadRoad01", types: ["route"], text: { text: "Mannarkkad Road, Kerala" } } },
        ],
      }),
    );
    const suggestions = await maps.autocomplete({ text: "Mannarkkad", sessionToken: SESSION, near: { lat: 10.78, lng: 76.65 } });
    expect(suggestions).toEqual([
      { placeId: "ChIJmannarkkad000001", primaryText: "Mannarkkad", secondaryText: "Palakkad, Kerala, India", types: ["locality"], distanceMeters: 41000 },
      { placeId: "ChIJmannarkkadRoad01", primaryText: "Mannarkkad Road, Kerala", secondaryText: "", types: ["route"], distanceMeters: undefined },
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect(String(url)).not.toContain(KEY);
    expect(init.headers["X-Goog-Api-Key"]).toBe(KEY);
    expect(init.headers["X-Goog-FieldMask"]).toContain("suggestions.placePrediction.placeId");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ input: "Mannarkkad", sessionToken: SESSION, includedRegionCodes: ["in"], regionCode: "IN", languageCode: "en", origin: { latitude: 10.78, longitude: 76.65 } });
    expect(body.locationBias.circle.radius).toBe(50000);
    // Any place type is allowed (no includedPrimaryTypes restriction).
    expect(body.includedPrimaryTypes).toBeUndefined();
  });

  it("place details: ends the session, Essentials fields only, parses Indian address parts, then caches", async () => {
    const maps = await load();
    fetchMock.mockReturnValueOnce(
      respond(200, {
        id: "ChIJedappally0000001",
        formattedAddress: "Edappally, Kochi, Kerala 682024, India",
        shortFormattedAddress: "Edappally, Kochi",
        location: { latitude: 10.0261, longitude: 76.3125 },
        addressComponents: [
          { longText: "Edappally", types: ["sublocality_level_1", "sublocality", "political"] },
          { longText: "Kochi", types: ["locality", "political"] },
          { longText: "Ernakulam", types: ["administrative_area_level_2", "political"] },
          { longText: "Kerala", types: ["administrative_area_level_1", "political"] },
          { longText: "India", types: ["country", "political"] },
        ],
      }),
    );
    const place = await maps.placeDetails("ChIJedappally0000001", SESSION);
    expect(place).toEqual({
      placeId: "ChIJedappally0000001",
      lat: 10.0261,
      lng: 76.3125,
      formattedAddress: "Edappally, Kochi, Kerala 682024, India",
      label: "Edappally, Kochi",
      locality: "Edappally",
      city: "Kochi",
      district: "Ernakulam",
      state: "Kerala",
      country: "India",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/v1/places/ChIJedappally0000001?");
    expect(url).toContain(`sessionToken=${SESSION}`);
    expect(init.headers["X-Goog-FieldMask"]).toBe("id,formattedAddress,shortFormattedAddress,location,addressComponents");
    await maps.placeDetails("ChIJedappally0000001", SESSION);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reverse geocoding: readable address from a GPS position, cached on a ~110 m grid", async () => {
    const maps = await load();
    fetchMock.mockReturnValueOnce(
      respond(200, {
        status: "OK",
        results: [
          {
            place_id: "ChIJpalakkadAddress1",
            formatted_address: "Stadium Bypass Rd, Palakkad, Kerala 678001, India",
            address_components: [
              { long_name: "Stadium Bypass Road", types: ["route"] },
              { long_name: "Palakkad", types: ["locality", "political"] },
              { long_name: "Palakkad", types: ["administrative_area_level_2", "political"] },
              { long_name: "Kerala", types: ["administrative_area_level_1", "political"] },
              { long_name: "India", types: ["country", "political"] },
            ],
          },
        ],
      }),
    );
    const place = await maps.reverseGeocode({ lat: 10.78671, lng: 76.65481 });
    expect(place).toMatchObject({ city: "Palakkad", district: "Palakkad", state: "Kerala", label: "Stadium Bypass Road, Palakkad", lat: 10.78671 });
    await maps.reverseGeocode({ lat: 10.78678, lng: 76.65484 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps quota, key and outage errors without leaking the key", async () => {
    const maps = await load();
    fetchMock.mockReturnValueOnce(respond(429, { error: { status: "RESOURCE_EXHAUSTED", message: `quota for key ${KEY}` } }));
    const quota = await maps.autocomplete({ text: "Kochi", sessionToken: SESSION }).catch((error) => error);
    expect(quota.code).toBe("GEO_QUOTA");
    expect(quota.message).not.toContain(KEY);
    fetchMock.mockReturnValueOnce(respond(403, { error: { status: "PERMISSION_DENIED" } }));
    expect((await maps.autocomplete({ text: "Kochi", sessionToken: SESSION }).catch((error) => error)).code).toBe("GEO_NOT_AUTHORIZED");
    fetchMock.mockReturnValueOnce(respond(200, { status: "OVER_QUERY_LIMIT" }));
    expect((await maps.reverseGeocode({ lat: 9.1, lng: 76.1 }).catch((error) => error)).code).toBe("GEO_QUOTA");
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const down = await maps.reverseGeocode({ lat: 9.2, lng: 76.2 }).catch((error) => error);
    expect(down.code).toBe("GEO_UNAVAILABLE");
    expect(JSON.stringify(down)).not.toContain(KEY);
  });

  it("without a key it reports not configured and never calls Google", async () => {
    const maps = await load("");
    expect(maps.googleMapsConfigured()).toBe(false);
    const error = await maps.autocomplete({ text: "Kochi", sessionToken: SESSION }).catch((reason) => reason);
    expect(error.code).toBe("GEO_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
