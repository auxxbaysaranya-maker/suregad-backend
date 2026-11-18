import { describe, expect, it } from "vitest";
import { alertIsDue } from "../src/services/growth.service";

describe("price alerts", () => {
  it("notifies only when the price is at or below the target and has not already fired", () => {
    expect(alertIsDue(10000, 12000, false)).toBe(true);
    expect(alertIsDue(12000, 12000, false)).toBe(true);
    expect(alertIsDue(13000, 12000, false)).toBe(false);
    expect(alertIsDue(10000, 12000, true)).toBe(false);
  });
});
