import { describe, expect, it } from "vitest";
import { MANUAL_TRANSITIONS } from "../src/services/inventory.service";
import { DELIVERY_TRANSITIONS, ORDER_TRANSITIONS, RETURN_TRANSITIONS } from "../src/services/showroom-orders.service";
import { REVIEW_ACTIONS, applicationSchema, showroomStatus } from "../src/services/showroom.service";

describe("inventory rules", () => {
  it("never lets a seller set RESERVED or SOLD by hand", () => {
    for (const targets of Object.values(MANUAL_TRANSITIONS)) {
      expect(targets).not.toContain("RESERVED");
      expect(targets).not.toContain("SOLD");
    }
    expect(MANUAL_TRANSITIONS.SOLD).toEqual([]);
    expect(MANUAL_TRANSITIONS.RESERVED).toEqual([]);
  });
});

describe("order and delivery state machines", () => {
  it("only lets a paid order be accepted or rejected", () => {
    expect(ORDER_TRANSITIONS.paid).toEqual(["accepted", "rejected"]);
  });
  it("has no seller transitions out of delivered", () => {
    expect(ORDER_TRANSITIONS.delivered).toEqual([]);
  });
  it("never reaches DELIVERED through a plain status change (proof is required)", () => {
    for (const targets of Object.values(DELIVERY_TRANSITIONS)) expect(targets).not.toContain("DELIVERED");
  });
  it("requests a refund only after the device is received", () => {
    expect(RETURN_TRANSITIONS.received).toEqual(["refund_requested"]);
    expect(RETURN_TRANSITIONS.requested).not.toContain("refund_requested");
  });
});

describe("showroom verification", () => {
  it("treats legacy pending applications as submitted", () => {
    expect(showroomStatus({ verificationStatus: "pending" })).toBe("submitted");
    expect(showroomStatus(null)).toBe("none");
  });
  it("cannot approve a draft or restore a revoked showroom", () => {
    expect(REVIEW_ACTIONS.approve!.from).not.toContain("draft");
    expect(REVIEW_ACTIONS.restore!.from).toEqual(["suspended"]);
  });
  it("requires a note to reject, suspend or revoke", () => {
    for (const action of ["reject", "suspend", "revoke", "request_info"]) expect(REVIEW_ACTIONS[action]!.needsNote).toBe(true);
  });
  it("validates GSTIN and PAN formats", () => {
    expect(applicationSchema.safeParse({ gstin: "32AAKCT4821M1Z5", pan: "AAKCT4821M" }).success).toBe(true);
    expect(applicationSchema.safeParse({ gstin: "12345" }).success).toBe(false);
    expect(applicationSchema.safeParse({ pan: "ABC" }).success).toBe(false);
  });
});
