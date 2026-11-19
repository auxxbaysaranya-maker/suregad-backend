import { Schema, model } from "mongoose";

/** Monotonic sequences for human-readable codes (SG-SH-000001, SG-LIST-000001, SG-UNIT-000001). */
const counterSchema = new Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

export const UNIT_STATUSES = [
  "AVAILABLE",
  "RESERVED",
  "SOLD",
  "UNDER_INSPECTION",
  "DAMAGED",
  "RETURNED",
  "REPAIR",
  "UNLISTED",
] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

const warrantyClaimSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    issue: { type: String, required: true, maxlength: 2000 },
    imageKeys: { type: [String], default: [] },
    status: { type: String, enum: ["open", "accepted", "in_repair", "resolved", "rejected"], default: "open" },
    sellerNote: String,
    resolvedAt: Date,
  },
  { timestamps: true },
);

/**
 * One physical device in a showroom's stock. A listing (Product) can have many units;
 * buying reserves exactly one unit, so the same IMEI can never be sold twice.
 */
const inventoryUnitSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", index: true },
    status: { type: String, enum: UNIT_STATUSES, default: "AVAILABLE", index: true },
    condition: { type: String, enum: ["new", "like_new", "excellent", "good", "fair"], default: "good" },
    imeiHash: String,
    imeiLast4: String,
    imeiCipher: String,
    serialHash: String,
    serialLast4: String,
    serialCipher: String,
    colour: String,
    storageGb: Number,
    ramGb: Number,
    batteryHealth: Number,
    costPaise: { type: Number, min: 0 },
    pricePaise: { type: Number, min: 0 },
    notes: { type: String, default: "" },
    warranty: {
      months: { type: Number, default: 0 },
      provider: { type: String, enum: ["none", "showroom", "manufacturer"], default: "none" },
      terms: String,
      startsAt: Date,
      endsAt: Date,
    },
    warrantyClaims: { type: [warrantyClaimSchema], default: [] },
    reservedOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    reservedUntil: Date,
    soldOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    soldAt: Date,
    buyerId: { type: Schema.Types.ObjectId, ref: "User" },
    /** Optimistic concurrency counter, bumped on every status change. */
    rev: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
inventoryUnitSchema.index(
  { imeiHash: 1 },
  { unique: true, partialFilterExpression: { imeiHash: { $type: "string" }, deletedAt: null } },
);
inventoryUnitSchema.index(
  { serialHash: 1 },
  { unique: true, partialFilterExpression: { serialHash: { $type: "string" }, deletedAt: null } },
);
inventoryUnitSchema.index({ productId: 1, status: 1 });

/** Append-only stock history. */
const inventoryMovementSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    unitId: { type: Schema.Types.ObjectId, ref: "InventoryUnit", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product" },
    from: String,
    to: { type: String, required: true },
    reason: { type: String, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
  },
  { timestamps: true },
);
inventoryMovementSchema.index({ businessId: 1, createdAt: -1 });

export const RETURN_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "pickup_scheduled",
  "received",
  "refund_requested",
  "refunded",
  "escalated",
  "closed",
] as const;

const returnRequestSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    subOrderId: { type: Schema.Types.ObjectId, required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", index: true },
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product" },
    unitId: { type: Schema.Types.ObjectId, ref: "InventoryUnit" },
    reason: { type: String, enum: ["damaged", "not_as_described", "defective", "wrong_item", "changed_mind", "other"], required: true },
    details: { type: String, default: "", maxlength: 2000 },
    imageKeys: { type: [String], default: [] },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: RETURN_STATUSES, default: "requested" },
    sellerNote: String,
    refundId: { type: Schema.Types.ObjectId, ref: "Refund" },
    disputeId: { type: Schema.Types.ObjectId, ref: "Dispute" },
    unitCondition: { type: String, enum: ["resellable", "damaged", "repair"] },
    timeline: {
      type: [{ status: String, note: String, by: Schema.Types.ObjectId, at: { type: Date, default: Date.now } }],
      default: [],
    },
  },
  { timestamps: true },
);

/** A scheduled or immediate discount on one or more of a showroom's listings. */
const promotionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, required: true, maxlength: 120 },
    productIds: { type: [Schema.Types.ObjectId], ref: "Product", default: [] },
    kind: { type: String, enum: ["percent", "amount"], required: true },
    value: { type: Number, required: true, min: 1 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: { type: String, enum: ["scheduled", "active", "ended", "cancelled"], default: "scheduled", index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

/** A showroom asking for a listing to be featured. Admin decides; no payment is faked. */
const featureRequestSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    days: { type: Number, required: true, min: 1, max: 90 },
    note: { type: String, default: "" },
    status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending", index: true },
    adminNote: String,
    decidedAt: Date,
  },
  { timestamps: true },
);

export const Counter = model("Counter", counterSchema);
export const InventoryUnit = model("InventoryUnit", inventoryUnitSchema);
export const InventoryMovement = model("InventoryMovement", inventoryMovementSchema);
export const ReturnRequest = model("ReturnRequest", returnRequestSchema);
export const Promotion = model("Promotion", promotionSchema);
export const FeatureRequest = model("FeatureRequest", featureRequestSchema);

export async function nextCode(prefix: "SH" | "LIST" | "UNIT" | "RET" | "TKT"): Promise<string> {
  const counter = await Counter.findOneAndUpdate({ _id: prefix }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  return `SG-${prefix}-${String(counter.seq).padStart(6, "0")}`;
}
