import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWith(origins: string) {
  vi.resetModules();
  process.env.CORS_ORIGINS = origins;
  return import("../src/config/env");
}

describe("CORS_ORIGINS", () => {
  const previous = process.env.CORS_ORIGINS;
  afterEach(() => {
    process.env.CORS_ORIGINS = previous;
    vi.resetModules();
  });

  it("allows exactly the configured origins (trailing slashes and case ignored)", async () => {
    const { isAllowedOrigin, env } = await loadWith("https://suregad.in/, https://dashboard.suregad.in,http://localhost:5174");
    expect(env.clientOrigins).toEqual(["https://suregad.in", "https://dashboard.suregad.in", "http://localhost:5174"]);
    expect(isAllowedOrigin("https://suregad.in")).toBe(true);
    expect(isAllowedOrigin("https://DASHBOARD.suregad.in")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5174")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(false);
    expect(isAllowedOrigin("https://suregad.in.evil.com")).toBe(false);
  });

  it("supports subdomain wildcards without matching look-alike domains", async () => {
    const { isAllowedOrigin } = await loadWith("https://*.suregad.in");
    expect(isAllowedOrigin("https://dashboard.suregad.in")).toBe(true);
    expect(isAllowedOrigin("https://a.b.suregad.in")).toBe(true);
    expect(isAllowedOrigin("https://suregad.in")).toBe(false);
    expect(isAllowedOrigin("https://evilsuregad.in")).toBe(false);
    expect(isAllowedOrigin("http://dashboard.suregad.in")).toBe(false);
  });
});
