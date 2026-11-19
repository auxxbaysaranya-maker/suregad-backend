import { Types } from "mongoose";
import { InventoryMovement, InventoryUnit, nextCode, type UnitStatus } from "../models/showroom.model";
import { Product } from "../models/catalog.model";
import { Business } from "../models/profiles.model";
import { AppError, notFound } from "../common/errors";
import { encryptSecret, hashIdentifier, lastDigits } from "../common/crypto";
import { addDays } from "../common/time";
import { notify } from "./notification.service";

/** Status changes a showroom may make by hand. RESERVED and SOLD are only set by checkout and payment. */
export const MANUAL_TRANSITIONS: Record<UnitStatus, UnitStatus[]> = {
  AVAILABLE: ["UNLISTED", "DAMAGED", "REPAIR", "UNDER_INSPECTION"],
  UNLISTED: ["AVAILABLE", "DAMAGED", "REPAIR", "UNDER_INSPECTION"],
  DAMAGED: ["REPAIR", "UNLISTED", "AVAILABLE"],
  REPAIR: ["AVAILABLE", "UNLISTED", "DAMAGED"],
  UNDER_INSPECTION: ["AVAILABLE", "UNLISTED", "DAMAGED", "REPAIR"],
  RETURNED: ["AVAILABLE", "UNLISTED", "DAMAGED", "REPAIR"],
  RESERVED: [],
  SOLD: [],
};

type Id = string | Types.ObjectId;

async function record(input: {
  businessId: Id;
  unitId: Id;
  productId?: Id | null;
  from?: string;
  to: string;
  reason: string;
  actorId?: Id;
  orderId?: Id;
}) {
  await InventoryMovement.create(input);
}

/**
 * Throws when an IMEI or serial already belongs to another unit or to another seller's listing.
 * `ownProductId` lets a listing's own identifier be reused when it is converted to a unit.
 */
export async function assertUniqueIdentifiers(input: { imei?: string; serial?: string; exceptUnitId?: Id; ownProductId?: Id }) {
  for (const [kind, value] of [["imei", input.imei], ["serial", input.serial]] as const) {
    if (!value) continue;
    const hash = hashIdentifier(value);
    const unitField = kind === "imei" ? "imeiHash" : "serialHash";
    const unit = await InventoryUnit.findOne({ [unitField]: hash, deletedAt: null, ...(input.exceptUnitId ? { _id: { $ne: input.exceptUnitId } } : {}) }).select("code");
    if (unit) throw new AppError(409, "DUPLICATE_IDENTIFIER", `This ${kind === "imei" ? "IMEI" : "serial number"} is already in stock as ${unit.code}.`);
    const listing = await Product.findOne({
      [`identifier.${unitField}`]: hash,
      deletedAt: null,
      ...(input.ownProductId ? { _id: { $ne: input.ownProductId } } : {}),
    }).select("_id");
    if (listing) throw new AppError(409, "DUPLICATE_IDENTIFIER", `This ${kind === "imei" ? "IMEI" : "serial number"} is already listed on SureGad.`);
  }
}

export function identifierFields(imei?: string, serial?: string) {
  const fields: Record<string, string> = {};
  if (imei) Object.assign(fields, { imeiHash: hashIdentifier(imei), imeiLast4: lastDigits(imei), imeiCipher: encryptSecret(imei) });
  if (serial) Object.assign(fields, { serialHash: hashIdentifier(serial), serialLast4: lastDigits(serial), serialCipher: encryptSecret(serial) });
  return fields;
}

export interface UnitInput {
  productId?: string;
  imei?: string;
  serial?: string;
  condition?: "new" | "like_new" | "excellent" | "good" | "fair";
  colour?: string;
  storageGb?: number;
  ramGb?: number;
  batteryHealth?: number;
  costPaise?: number;
  pricePaise?: number;
  notes?: string;
  status?: "AVAILABLE" | "UNLISTED";
  warranty?: { months?: number; provider?: "none" | "showroom" | "manufacturer"; terms?: string };
}

export async function createUnit(businessId: Id, actorId: Id, input: UnitInput) {
  if (input.productId) {
    const product = await Product.findOne({ _id: input.productId, businessId, deletedAt: null });
    if (!product) throw notFound("Listing not found in this showroom.");
    if (!product.stockTracked) throw new AppError(409, "NOT_STOCK_TRACKED", "Add stock to a showroom listing that tracks units.");
  }
  await assertUniqueIdentifiers({ imei: input.imei, serial: input.serial });
  const code = await nextCode("UNIT");
  let unit;
  try {
    unit = await InventoryUnit.create({
      code,
      businessId,
      productId: input.productId,
      status: input.status || "AVAILABLE",
      condition: input.condition || "good",
      colour: input.colour,
      storageGb: input.storageGb,
      ramGb: input.ramGb,
      batteryHealth: input.batteryHealth,
      costPaise: input.costPaise,
      pricePaise: input.pricePaise,
      notes: input.notes || "",
      warranty: { months: input.warranty?.months || 0, provider: input.warranty?.provider || "none", terms: input.warranty?.terms },
      ...identifierFields(input.imei, input.serial),
    });
  } catch (error) {
    // The unique index is the final guard when two requests race with the same IMEI.
    if ((error as { code?: number }).code === 11000) throw new AppError(409, "DUPLICATE_IDENTIFIER", "This IMEI or serial number is already in stock.");
    throw error;
  }
  await record({ businessId, unitId: unit._id, productId: unit.productId, to: unit.status, reason: "stock_added", actorId });
  if (unit.productId) await syncListingStock(unit.productId);
  return unit;
}

/**
 * Atomic status change: only succeeds if the unit is still in one of `from`.
 * `rev` (optional) adds optimistic locking for edits made from a stale screen.
 */
export async function changeUnitStatus(input: {
  unitId: Id;
  businessId: Id;
  from: UnitStatus[];
  to: UnitStatus;
  reason: string;
  actorId?: Id;
  orderId?: Id;
  rev?: number;
  set?: Record<string, unknown>;
  unset?: Record<string, 1>;
}) {
  const filter: Record<string, unknown> = { _id: input.unitId, businessId: input.businessId, status: { $in: input.from }, deletedAt: null };
  if (input.rev !== undefined) filter.rev = input.rev;
  const update: Record<string, unknown> = { $set: { status: input.to, ...(input.set || {}) }, $inc: { rev: 1 } };
  if (input.unset) update.$unset = input.unset;
  const before = await InventoryUnit.findOneAndUpdate(filter, update, { new: false });
  if (!before) {
    const current = await InventoryUnit.findOne({ _id: input.unitId, businessId: input.businessId, deletedAt: null }).select("status rev");
    if (!current) throw notFound("Unit not found.");
    throw new AppError(409, "UNIT_CHANGED", `This unit is ${current.status.toLowerCase().replace(/_/g, " ")} now. Refresh and try again.`, {
      status: current.status,
      rev: current.rev,
    });
  }
  await record({
    businessId: input.businessId,
    unitId: before._id,
    productId: before.productId,
    from: before.status,
    to: input.to,
    reason: input.reason,
    actorId: input.actorId,
    orderId: input.orderId,
  });
  if (before.productId) await syncListingStock(before.productId);
  return InventoryUnit.findById(before._id);
}

/** Recount a stock-tracked listing's units, update its buyable state and raise low/out-of-stock alerts. */
export async function syncListingStock(productId: Id) {
  const product = await Product.findById(productId);
  if (!product || !product.stockTracked) return;
  const counts = await InventoryUnit.aggregate<{ _id: string; n: number }>([
    { $match: { productId: new Types.ObjectId(String(productId)), deletedAt: null } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const count = (status: UnitStatus) => counts.find((row) => row._id === status)?.n || 0;
  const available = count("AVAILABLE");
  const reserved = count("RESERVED");
  const sold = count("SOLD");
  const state = available > 0 ? "available" : reserved > 0 ? "reserved" : "sold";
  const business = product.businessId ? await Business.findById(product.businessId).select("ownerId settings name") : null;
  const threshold = product.lowStockThreshold ?? business?.settings?.lowStockThreshold ?? 2;
  const update: Record<string, unknown> = {
    "stock.available": available,
    "stock.reserved": reserved,
    "stock.sold": sold,
    "inventory.state": state,
  };
  const recentlyNotified = product.lowStockNotifiedAt && Date.now() - product.lowStockNotifiedAt.getTime() < 12 * 60 * 60 * 1000;
  const wasAbove = (product.stock?.available ?? 0) > threshold;
  if (available > threshold) update.lowStockNotifiedAt = null;
  await Product.updateOne({ _id: product._id }, { $set: update });
  if (business && available <= threshold && product.status === "active" && (!recentlyNotified || (wasAbove && available === 0))) {
    await Product.updateOne({ _id: product._id }, { $set: { lowStockNotifiedAt: new Date() } });
    await notify({
      userId: String(business.ownerId),
      event: available === 0 ? "inventory.out_of_stock" : "inventory.low_stock",
      title: available === 0 ? "Out of stock" : "Low stock",
      body: available === 0 ? `${product.title} has no available units. Buyers can't order it until you add stock.` : `${product.title} has ${available} unit${available === 1 ? "" : "s"} left.`,
      data: { productId: String(product._id), available },
    });
  }
}

/** Checkout: reserve one available unit of a listing for an order. Returns null when none is left. */
export async function reserveUnit(productId: Id, orderId: Id, until: Date, actorId?: Id) {
  const unit = await InventoryUnit.findOneAndUpdate(
    { productId, status: "AVAILABLE", deletedAt: null },
    { $set: { status: "RESERVED", reservedOrderId: orderId, reservedUntil: until }, $inc: { rev: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
  if (!unit) return null;
  await record({ businessId: unit.businessId, unitId: unit._id, productId, from: "AVAILABLE", to: "RESERVED", reason: "checkout", actorId, orderId });
  await syncListingStock(productId);
  return unit;
}

/** Payment failed or timed out: put the order's reserved units back on sale. */
export async function releaseOrderUnits(orderId: Id, reason: string) {
  const units = await InventoryUnit.find({ reservedOrderId: orderId, status: "RESERVED" });
  for (const unit of units) {
    const updated = await InventoryUnit.findOneAndUpdate(
      { _id: unit._id, status: "RESERVED", reservedOrderId: orderId },
      { $set: { status: "AVAILABLE" }, $unset: { reservedOrderId: 1, reservedUntil: 1 }, $inc: { rev: 1 } },
    );
    if (!updated) continue;
    await record({ businessId: unit.businessId, unitId: unit._id, productId: unit.productId, from: "RESERVED", to: "AVAILABLE", reason, orderId });
    if (unit.productId) await syncListingStock(unit.productId);
  }
}

/** Payment captured: reserved units become sold and their warranty starts. */
export async function markOrderUnitsSold(orderId: Id, buyerId: Id) {
  const units = await InventoryUnit.find({ reservedOrderId: orderId, status: "RESERVED" });
  const now = new Date();
  for (const unit of units) {
    const months = unit.warranty?.months || 0;
    const updated = await InventoryUnit.findOneAndUpdate(
      { _id: unit._id, status: "RESERVED", reservedOrderId: orderId },
      {
        $set: {
          status: "SOLD",
          soldOrderId: orderId,
          soldAt: now,
          buyerId,
          ...(months > 0 ? { "warranty.startsAt": now, "warranty.endsAt": addDays(now, Math.round(months * 30.44)) } : {}),
        },
        $unset: { reservedUntil: 1 },
        $inc: { rev: 1 },
      },
    );
    if (!updated) continue;
    await record({ businessId: unit.businessId, unitId: unit._id, productId: unit.productId, from: "RESERVED", to: "SOLD", reason: "payment_captured", orderId });
    if (unit.productId) await syncListingStock(unit.productId);
  }
}

/** A sold unit came back (rejected order, return or refund). */
export async function restockSoldUnit(unitId: Id, to: UnitStatus, reason: string, actorId?: Id) {
  const unit = await InventoryUnit.findById(unitId);
  if (!unit) return null;
  return changeUnitStatus({
    unitId,
    businessId: unit.businessId,
    from: ["SOLD", "RETURNED"],
    to,
    reason,
    actorId,
    unset: to === "AVAILABLE" ? { soldOrderId: 1, soldAt: 1, buyerId: 1, reservedOrderId: 1 } : undefined,
  });
}
