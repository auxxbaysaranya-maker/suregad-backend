import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import { asyncHandler, sendData } from "../common/http";
import { AppError, notFound } from "../common/errors";
import { decryptSecret } from "../common/crypto";
import { addDays } from "../common/time";
import { requireUser } from "../middleware/auth";
import { Product } from "../models/catalog.model";
import { Order, Payment, Refund, Subscription, SubscriptionPlan, DELIVERY_STATUSES } from "../models/commerce.model";
import { Conversation, Notification, PlatformSetting, Review, SellerSettlement } from "../models/engagement.model";
import { InspectionPlan, InspectionReport, InspectionRequest } from "../models/inspection.model";
import { PartnerProfile } from "../models/profiles.model";
import { User } from "../models/user.model";
import {
  FeatureRequest,
  InventoryMovement,
  InventoryUnit,
  Promotion,
  ReturnRequest,
  UNIT_STATUSES,
  nextCode,
  type UnitStatus,
} from "../models/showroom.model";
import { laptopSpecsSchema, smartphoneSpecsSchema } from "../shared/validation";
import { createListing, presentProduct, setListingStatus } from "../services/catalog.service";
import { getEntitlements } from "../services/entitlement.service";
import { notifyPriceAlerts } from "../services/growth.service";
import { audit } from "../services/audit.service";
import { notify } from "../services/notification.service";
import {
  DOCUMENT_KINDS,
  EDITABLE_STATUSES,
  assertOwnPrivateKey,
  assertOwnPublicKey,
  findOwnShowroom,
  presentShowroom,
  requestSensitiveChange,
  requireApprovedShowroom,
  requireShowroom,
  saveApplication,
  showroomStatus,
  submitApplication,
} from "../services/showroom.service";
import {
  MANUAL_TRANSITIONS,
  assertUniqueIdentifiers,
  changeUnitStatus,
  createUnit,
  identifierFields,
  syncListingStock,
} from "../services/inventory.service";
import {
  addDeliveryDocument,
  buyerConfirmReceipt,
  buyerHandoverCode,
  changeDeliveryStatus,
  changeSubOrderStatus,
  completeHandover,
  createReturn,
  escalateReturn,
  loadSellerSubOrder,
  presentSubOrder,
  sellerReturnAction,
  updateDeliveryDetails,
} from "../services/showroom-orders.service";
import { signedDownload, readLocalUpload } from "../integrations/storage";

export const showroom = Router();
const seller = Router();
seller.use(requireUser, requireApprovedShowroom);

const biz = (req: Request) => req.showroom!;
const bizId = (req: Request) => req.showroom!._id;
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const LIVE_SUB = ["paid", "accepted", "confirmed", "processing", "ready_for_dispatch", "shipped", "dispatched", "delivered"];
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function csv(rows: Record<string, unknown>[], columns: string[]) {
  const cell = (value: unknown) => {
    const text = value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
    // Neutralise spreadsheet formulas and quote everything.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n");
}

function sendCsv(res: import("express").Response, name: string, body: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(body);
}

async function platformFees() {
  const settings = await PlatformSetting.findOne({ key: "platform" }).lean();
  const value = (settings?.value || {}) as { commissionPercent?: number; gatewayFeePercent?: number; settlementHoldDays?: number };
  return {
    configured: typeof value.commissionPercent === "number",
    commissionPercent: Number(value.commissionPercent ?? 0),
    gatewayFeePercent: Number(value.gatewayFeePercent ?? 0),
    settlementHoldDays: Number(value.settlementHoldDays ?? 7),
  };
}

/** ================= Application (any status) ================= */

showroom.get(
  "/showroom/application",
  requireUser,
  asyncHandler(async (req, res) => {
    const business = await findOwnShowroom(req.user!._id);
    sendData(res, business ? presentShowroom(business) : null);
  }),
);

showroom.put(
  "/showroom/application",
  requireUser,
  asyncHandler(async (req, res) => {
    const business = await saveApplication(req, req.body);
    sendData(res, presentShowroom(business));
  }),
);

showroom.post(
  "/showroom/application/submit",
  requireUser,
  asyncHandler(async (req, res) => sendData(res, presentShowroom(await submitApplication(req)))),
);

showroom.post(
  "/showroom/application/documents",
  requireUser,
  requireShowroom,
  asyncHandler(async (req, res) => {
    const body = z.object({ key: z.string().min(5).max(300), name: z.string().trim().min(1).max(120), kind: z.enum(DOCUMENT_KINDS) }).parse(req.body);
    const business = biz(req);
    const status = showroomStatus(business);
    // Documents can be added while editing, or when SureGad asked for more, or for an approved profile-change request.
    if (!EDITABLE_STATUSES.includes(status as never) && status !== "approved") throw new AppError(409, "APPLICATION_LOCKED", "Your application is being reviewed.");
    assertOwnPrivateKey(body.key, String(req.user!._id), "business_document");
    if (business.documents.length >= 20) throw new AppError(400, "TOO_MANY_DOCUMENTS", "Up to 20 documents can be attached.");
    business.documents.push({ key: body.key, name: body.name, kind: body.kind, status: "pending", uploadedAt: new Date() } as never);
    await business.save();
    sendData(res, presentShowroom(business), undefined, 201);
  }),
);

showroom.delete(
  "/showroom/application/documents/:docId",
  requireUser,
  requireShowroom,
  asyncHandler(async (req, res) => {
    const business = biz(req);
    if (!EDITABLE_STATUSES.includes(showroomStatus(business) as never)) throw new AppError(409, "APPLICATION_LOCKED", "Documents can't be removed during review.");
    const doc = business.documents.id(req.params.docId);
    if (!doc) throw notFound("Document not found.");
    if (doc.status === "approved") throw new AppError(409, "DOCUMENT_APPROVED", "Approved documents can't be removed.");
    doc.deleteOne();
    await business.save();
    sendData(res, presentShowroom(business));
  }),
);

showroom.get(
  "/showroom/application/documents/:docId/file",
  requireUser,
  requireShowroom,
  asyncHandler(async (req, res) => {
    const doc = biz(req).documents.id(req.params.docId);
    if (!doc?.key) throw notFound("Document not found.");
    const url = await signedDownload(doc.key);
    if (url) return sendData(res, { url });
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(await readLocalUpload(doc.key));
  }),
);

/** Showroom summary for the panel shell (works in every status). */
showroom.get(
  "/showroom/me",
  requireUser,
  asyncHandler(async (req, res) => {
    const business = await findOwnShowroom(req.user!._id);
    sendData(res, business ? presentShowroom(business) : null);
  }),
);

/** ================= Dashboard ================= */

seller.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const id = bizId(req);
    const since30 = daysAgo(30);
    const since14 = daysAgo(13);
    since14.setHours(0, 0, 0, 0);
    const [listingCounts, unitCounts, subRows, daily, pendingReturns, lowStock, unreadRows, ratingRows, recent, openInspections] = await Promise.all([
      Product.aggregate([{ $match: { businessId: id, deletedAt: null } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      InventoryUnit.aggregate([{ $match: { businessId: id, deletedAt: null } }, { $group: { _id: "$status", n: { $sum: 1 }, value: { $sum: { $ifNull: ["$costPaise", 0] } } } }]),
      Order.aggregate([
        { $unwind: "$subOrders" },
        { $match: { "subOrders.businessId": id, "subOrders.status": { $ne: "pending_payment" } } },
        { $group: { _id: "$subOrders.status", n: { $sum: 1 }, amount: { $sum: "$subOrders.amountPaise" }, recent: { $sum: { $cond: [{ $gte: ["$createdAt", since30] }, "$subOrders.amountPaise", 0] } } } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: since14 } } },
        { $unwind: "$subOrders" },
        { $match: { "subOrders.businessId": id, "subOrders.status": { $in: LIVE_SUB } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } }, revenue: { $sum: "$subOrders.amountPaise" }, orders: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      ReturnRequest.countDocuments({ businessId: id, status: { $in: ["requested", "approved", "pickup_scheduled", "received", "escalated"] } }),
      Product.find({ businessId: id, deletedAt: null, stockTracked: true, status: "active" }).select("title stock lowStockThreshold slug").lean(),
      Conversation.find({ participantIds: req.user!._id }).select("unread").lean(),
      Review.aggregate([{ $match: { businessId: id, status: "published" } }, { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } }]),
      Order.find({ "subOrders.businessId": id, status: { $ne: "pending_payment" } }).sort({ createdAt: -1 }).limit(6).lean(),
      InspectionRequest.countDocuments({ sellerUserId: req.user!._id, status: { $in: ["matching", "offered", "accepted", "scheduled", "in_progress"] } }),
    ]);
    const threshold = biz(req).settings?.lowStockThreshold ?? 2;
    const byStatus = (rows: { _id: string; n: number }[]) => Object.fromEntries(rows.map((row) => [row._id, row.n]));
    const subs = subRows as { _id: string; n: number; amount: number; recent: number }[];
    const revenue30 = subs.filter((row) => LIVE_SUB.includes(row._id)).reduce((sum, row) => sum + row.recent, 0);
    const days: { date: string; revenuePaise: number; orders: number }[] = [];
    for (let i = 0; i < 14; i++) {
      const date = addDays(since14, i);
      const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(date);
      const row = (daily as { _id: string; revenue: number; orders: number }[]).find((entry) => entry._id === key);
      days.push({ date: key, revenuePaise: row?.revenue || 0, orders: row?.orders || 0 });
    }
    const userId = String(req.user!._id);
    sendData(res, {
      showroom: { name: biz(req).name, code: biz(req).code, slug: biz(req).slug },
      listings: byStatus(listingCounts),
      units: byStatus(unitCounts),
      inventoryCostPaise: (unitCounts as { _id: string; value: number }[]).filter((row) => row._id === "AVAILABLE").reduce((sum, row) => sum + row.value, 0),
      orders: byStatus(subs),
      revenue30Paise: revenue30,
      lifetimeRevenuePaise: subs.filter((row) => LIVE_SUB.includes(row._id)).reduce((sum, row) => sum + row.amount, 0),
      actions: {
        toAccept: subs.find((row) => row._id === "paid")?.n || 0,
        toDispatch: subs.filter((row) => ["accepted", "confirmed", "processing", "ready_for_dispatch"].includes(row._id)).reduce((sum, row) => sum + row.n, 0),
        inTransit: subs.filter((row) => ["dispatched", "shipped"].includes(row._id)).reduce((sum, row) => sum + row.n, 0),
        returns: pendingReturns,
        unreadMessages: unreadRows.reduce((sum, row) => sum + Number((row.unread as Record<string, number> | undefined)?.[userId] || 0), 0),
        pendingReview: byStatus(listingCounts).pending_review || 0,
        inspections: openInspections,
      },
      lowStock: lowStock
        .filter((product) => (product.stock?.available ?? 0) <= (product.lowStockThreshold ?? threshold))
        .map((product) => ({ id: String(product._id), title: product.title, available: product.stock?.available ?? 0 })),
      rating: { average: ratingRows[0]?.avg ? Math.round(ratingRows[0].avg * 10) / 10 : null, count: ratingRows[0]?.n || 0 },
      daily: days,
      recentOrders: recent.map((order) => {
        const sub = order.subOrders.find((entry) => String(entry.businessId) === String(id))!;
        return { orderId: String(order._id), subOrderId: String(sub._id), number: order.number, status: sub.status, amountPaise: sub.amountPaise, createdAt: order.createdAt, title: sub.items[0]?.title };
      }),
    });
  }),
);

/** ================= Products ================= */

function presentListing(product: Record<string, any>) {
  return {
    ...presentProduct(product, true),
    status: product.status,
    published: product.published !== false,
    onHold: product.businessHold === true,
    rejectionReason: product.rejectionReason || null,
    stockTracked: Boolean(product.stockTracked),
    stock: product.stock || { available: 0, reserved: 0, sold: 0 },
    lowStockThreshold: product.lowStockThreshold ?? null,
    priceHistory: (product.priceHistory || []).slice(-20),
    promo: product.promo?.promotionId ? { promotionId: String(product.promo.promotionId), basePricePaise: product.promo.basePricePaise, endsAt: product.promo.endsAt } : null,
    views: product.stats?.views || 0,
    updatedAt: product.updatedAt,
  };
}

async function ownListing(req: Request, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Listing not found.");
  const product = await Product.findOne({ _id: id, businessId: bizId(req), deletedAt: null });
  if (!product) throw notFound("Listing not found.");
  return product;
}

seller.get(
  "/products",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { businessId: bizId(req), deletedAt: null };
    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ title: new RegExp(escapeRegex(q), "i") }, { listingCode: new RegExp(escapeRegex(q), "i") }, { "specs.model": new RegExp(escapeRegex(q), "i") }];
    if (req.query.status === "unpublished") filter.published = false;
    else if (req.query.status === "out_of_stock") Object.assign(filter, { stockTracked: true, "stock.available": 0 });
    else if (req.query.status === "low_stock") Object.assign(filter, { stockTracked: true, $expr: { $lte: ["$stock.available", { $ifNull: ["$lowStockThreshold", biz(req).settings?.lowStockThreshold ?? 2] }] } });
    else if (req.query.status) filter.status = String(req.query.status);
    if (req.query.itemType) filter.itemType = String(req.query.itemType);
    if (req.query.category) filter.categorySlug = String(req.query.category);
    const sorts: Record<string, Record<string, 1 | -1>> = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      price_asc: { pricePaise: 1 },
      price_desc: { pricePaise: -1 },
      stock_asc: { "stock.available": 1 },
      views: { "stats.views": -1 },
      updated: { updatedAt: -1 },
    };
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const [items, total] = await Promise.all([
      Product.find(filter).sort(sorts[String(req.query.sort)] || sorts.newest).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(filter),
    ]);
    sendData(res, items.map((item) => presentListing(item)), { page, limit, total, hasMore: page * limit < total } as never);
  }),
);

const unitInputSchema = z.object({
  imei: z.string().trim().regex(/^[0-9]{14,17}$/, "IMEI must be 14–17 digits.").optional().or(z.literal("").transform(() => undefined)),
  serial: z.string().trim().min(4).max(64).optional().or(z.literal("").transform(() => undefined)),
  condition: z.enum(["new", "like_new", "excellent", "good", "fair"]).optional(),
  colour: z.string().trim().max(40).optional(),
  storageGb: z.number().positive().max(8192).optional(),
  ramGb: z.number().positive().max(512).optional(),
  batteryHealth: z.number().int().min(1).max(100).optional(),
  costPaise: z.number().int().nonnegative().max(50_000_000).optional(),
  pricePaise: z.number().int().positive().max(50_000_000).optional(),
  notes: z.string().max(1000).optional(),
  status: z.enum(["AVAILABLE", "UNLISTED"]).optional(),
  warranty: z.object({ months: z.number().int().min(0).max(60).optional(), provider: z.enum(["none", "showroom", "manufacturer"]).optional(), terms: z.string().max(1000).optional() }).optional(),
});

const listingExtrasSchema = z.object({
  itemType: z.enum(["new", "used", "refurbished"]).default("used"),
  warrantyMonths: z.number().int().min(0).max(60).default(0),
  returnWindowDays: z.number().int().min(0).max(30).default(0),
  deliveryAvailable: z.boolean().default(true),
  pickupAvailable: z.boolean().default(true),
  lowStockThreshold: z.number().int().min(0).max(1000).optional(),
});

const createSchema = listingExtrasSchema.extend({
  categorySlug: z.enum(["smartphones", "laptops"]),
  title: z.string().trim().min(4).max(140),
  description: z.string().trim().min(10).max(8000),
  condition: z.enum(["like_new", "excellent", "good", "fair"]).optional(),
  pricePaise: z.number().int().positive().max(50_000_000),
  specs: z.record(z.unknown()),
  imageKeys: z.array(z.string().min(3)).max(20).default([]),
  submit: z.boolean().default(true),
  units: z.array(unitInputSchema).max(200).default([]),
});

async function createShowroomListing(req: Request, body: unknown) {
  const input = createSchema.parse(body);
  const business = biz(req);
  if (!business.settings?.deliveryAvailable && input.deliveryAvailable && !input.pickupAvailable) {
    throw new AppError(400, "NO_FULFILMENT", "Offer delivery or pickup.");
  }
  if (!input.deliveryAvailable && !input.pickupAvailable) throw new AppError(400, "NO_FULFILMENT", "Offer delivery, pickup or both.");
  // Check unit identifiers before anything is created.
  const seen = new Set<string>();
  for (const unit of input.units) {
    for (const value of [unit.imei, unit.serial]) {
      if (!value) continue;
      if (seen.has(value)) throw new AppError(409, "DUPLICATE_IDENTIFIER", `${value} appears twice in this listing.`);
      seen.add(value);
    }
    await assertUniqueIdentifiers({ imei: unit.imei, serial: unit.serial });
  }
  if (!business.address?.city || !business.address?.district || !business.address?.pincode) {
    throw new AppError(409, "ADDRESS_INCOMPLETE", "Your showroom address needs a city, district and PIN code before listing. Contact support to update it.");
  }
  const coordinates = business.location?.coordinates?.length === 2 ? { lng: business.location.coordinates[0]!, lat: business.location.coordinates[1]! } : undefined;
  const listing = await createListing(req, {
    categorySlug: input.categorySlug,
    sellerType: "business",
    businessId: String(business._id),
    title: input.title,
    description: input.description,
    condition: input.itemType === "new" ? "like_new" : input.condition || "good",
    pricePaise: input.pricePaise,
    specs: input.specs,
    imageKeys: input.imageKeys,
    location: {
      city: business.address.city,
      district: business.address.district,
      state: business.address.state || "Kerala",
      pincode: business.address.pincode,
      coordinates,
    },
    submit: input.submit,
  });
  const listingCode = await nextCode("LIST");
  await Product.updateOne(
    { _id: listing.id },
    {
      $set: {
        listingCode,
        itemType: input.itemType,
        stockTracked: true,
        warrantyMonths: input.warrantyMonths,
        returnWindowDays: input.returnWindowDays,
        deliveryAvailable: input.deliveryAvailable,
        pickupAvailable: input.pickupAvailable,
        lowStockThreshold: input.lowStockThreshold,
        "inventory.state": "sold",
        priceHistory: [{ pricePaise: input.pricePaise, reason: "created", by: req.user!._id, at: new Date() }],
      },
    },
  );
  const errors: { index: number; message: string }[] = [];
  for (const [index, unit] of input.units.entries()) {
    try {
      await createUnit(business._id, req.user!._id as never, {
        ...unit,
        productId: listing.id,
        condition: unit.condition || (input.itemType === "new" ? "new" : input.condition),
        warranty: unit.warranty || { months: input.warrantyMonths, provider: input.warrantyMonths ? "showroom" : "none" },
      });
    } catch (error) {
      errors.push({ index, message: error instanceof Error ? error.message : "Unit could not be added." });
    }
  }
  await syncListingStock(listing.id);
  await audit(req, "listing.created", "Product", listing.id, { listingCode, units: input.units.length - errors.length });
  const saved = await Product.findById(listing.id).lean();
  return { listing: presentListing(saved!), unitErrors: errors };
}

seller.post(
  "/products",
  asyncHandler(async (req, res) => sendData(res, await createShowroomListing(req, req.body), undefined, 201)),
);

seller.get(
  "/products/export.csv",
  asyncHandler(async (req, res) => {
    const items = await Product.find({ businessId: bizId(req), deletedAt: null }).sort({ createdAt: -1 }).lean();
    const rows = items.map((item) => ({
      listingCode: item.listingCode,
      title: item.title,
      categorySlug: item.categorySlug,
      itemType: item.itemType,
      condition: item.condition,
      price: (item.pricePaise / 100).toFixed(2),
      status: item.status,
      published: item.published !== false,
      available: item.stock?.available ?? (item.inventory?.state === "available" ? 1 : 0),
      reserved: item.stock?.reserved ?? 0,
      sold: item.stock?.sold ?? 0,
      brand: (item.specs as Record<string, unknown>)?.brand,
      model: (item.specs as Record<string, unknown>)?.model,
      storageGb: (item.specs as Record<string, unknown>)?.storageGb,
      ramGb: (item.specs as Record<string, unknown>)?.ramGb,
      views: item.stats?.views ?? 0,
      createdAt: item.createdAt,
    }));
    sendCsv(res, "listings", csv(rows, Object.keys(rows[0] || { listingCode: "" })));
  }),
);

/** CSV import: one row per listing; optional imei/serial columns add a unit to it. */
seller.post(
  "/products/import",
  asyncHandler(async (req, res) => {
    const text = z.object({ csv: z.string().min(10).max(2_000_000) }).parse(req.body).csv;
    const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true }) as Record<string, string>[];
    if (rows.length > 500) throw new AppError(400, "TOO_MANY_ROWS", "Import up to 500 rows at a time.");
    const created: string[] = [];
    const errors: { row: number; message: string }[] = [];
    for (const [index, row] of rows.entries()) {
      try {
        const num = (value?: string) => (value ? Number(value) : undefined);
        const units = row.imei || row.serial ? [{ imei: row.imei || undefined, serial: row.serial || undefined, costPaise: row.cost ? Math.round(Number(row.cost) * 100) : undefined }] : [];
        const result = await createShowroomListing(req, {
          categorySlug: row.categorySlug || row.category,
          title: row.title,
          description: row.description,
          condition: row.condition || undefined,
          itemType: row.itemType || "used",
          pricePaise: row.pricePaise ? Number(row.pricePaise) : Math.round(Number(row.price) * 100),
          specs: {
            brand: row.brand,
            model: row.model,
            storageGb: num(row.storageGb),
            ramGb: num(row.ramGb),
            colour: row.colour || "Unknown",
            processor: row.processor || undefined,
            displayInches: num(row.displayInches),
          },
          warrantyMonths: num(row.warrantyMonths) || 0,
          returnWindowDays: num(row.returnWindowDays) || 0,
          submit: row.submit !== "false",
          units,
        });
        if (result.unitErrors.length) errors.push({ row: index + 2, message: `Listing created; unit not added: ${result.unitErrors[0]!.message}` });
        created.push(result.listing.id);
      } catch (error) {
        const message = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") : error instanceof Error ? error.message : "Invalid row";
        errors.push({ row: index + 2, message });
      }
    }
    sendData(res, { created: created.length, errors });
  }),
);

seller.get(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const product = await ownListing(req, req.params.id);
    const units = await InventoryUnit.find({ productId: product._id, deletedAt: null }).sort({ createdAt: -1 }).limit(500).lean();
    sendData(res, { listing: presentListing(product.toObject()), units: units.map(presentUnit) });
  }),
);

const editSchema = listingExtrasSchema.partial().extend({
  title: z.string().trim().min(4).max(140).optional(),
  description: z.string().trim().min(10).max(8000).optional(),
  condition: z.enum(["like_new", "excellent", "good", "fair"]).optional(),
  pricePaise: z.number().int().positive().max(50_000_000).optional(),
  specs: z.record(z.unknown()).optional(),
  lowStockThreshold: z.number().int().min(0).max(1000).nullable().optional(),
});

seller.patch(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const product = await ownListing(req, req.params.id);
    const input = editSchema.parse(req.body);
    if (product.inventory?.state === "sold" && !product.stockTracked) throw new AppError(409, "SOLD", "Sold listings can't be edited.");
    let reReview = false;
    for (const key of ["title", "description", "condition"] as const) {
      if (input[key] !== undefined && input[key] !== product[key]) {
        product.set(key, input[key]);
        reReview = true;
      }
    }
    if (input.specs) {
      product.specs = product.categorySlug === "smartphones" ? smartphoneSpecsSchema.parse(input.specs) : laptopSpecsSchema.parse(input.specs);
      reReview = true;
    }
    for (const key of ["itemType", "warrantyMonths", "returnWindowDays", "deliveryAvailable", "pickupAvailable"] as const) {
      if (input[key] !== undefined) product.set(key, input[key]);
    }
    if (input.lowStockThreshold !== undefined) product.lowStockThreshold = input.lowStockThreshold ?? undefined;
    if (product.deliveryAvailable === false && product.pickupAvailable === false) throw new AppError(400, "NO_FULFILMENT", "Offer delivery, pickup or both.");
    let priceDrop = false;
    if (input.pricePaise !== undefined && input.pricePaise !== product.pricePaise) {
      if (product.promo?.promotionId) throw new AppError(409, "PROMOTION_ACTIVE", "End the running promotion before changing the price.");
      priceDrop = input.pricePaise < product.pricePaise;
      product.priceHistory.push({ pricePaise: input.pricePaise, reason: "manual", by: req.user!._id as never, at: new Date() });
      product.pricePaise = input.pricePaise;
    }
    // Content changes go back to moderation; price and stock settings don't.
    if (reReview && product.status === "active") product.status = "pending_review";
    await product.save();
    if (priceDrop) await notifyPriceAlerts(String(product._id), product.pricePaise);
    await syncListingStock(product._id);
    await audit(req, "listing.updated", "Product", String(product._id), { fields: Object.keys(input), reReview });
    sendData(res, presentListing((await Product.findById(product._id).lean())!));
  }),
);

seller.post(
  "/products/:id/duplicate",
  asyncHandler(async (req, res) => {
    const source = await ownListing(req, req.params.id);
    const result = await createShowroomListing(req, {
      categorySlug: source.categorySlug,
      title: `${source.title} (copy)`.slice(0, 140),
      description: source.description,
      condition: source.condition,
      itemType: source.itemType,
      pricePaise: source.promo?.basePricePaise || source.pricePaise,
      specs: source.specs,
      imageKeys: (source.images || []).map((image) => image.key).filter(Boolean),
      warrantyMonths: source.warrantyMonths,
      returnWindowDays: source.returnWindowDays,
      deliveryAvailable: source.deliveryAvailable,
      pickupAvailable: source.pickupAvailable,
      submit: false,
      units: [],
    });
    sendData(res, result.listing, undefined, 201);
  }),
);

async function publishListing(req: Request, product: InstanceType<typeof Product>, publish: boolean) {
  if (publish) {
    product.published = true;
    if (product.status === "draft" || product.status === "rejected") product.status = "pending_review";
  } else {
    product.published = false;
  }
  await product.save();
  await audit(req, publish ? "listing.published" : "listing.unpublished", "Product", String(product._id));
}

seller.post(
  "/products/:id/publish",
  asyncHandler(async (req, res) => {
    const product = await ownListing(req, req.params.id);
    const publish = z.object({ published: z.boolean() }).parse(req.body).published;
    await publishListing(req, product, publish);
    sendData(res, presentListing(product.toObject()));
  }),
);

async function archiveListing(req: Request, product: InstanceType<typeof Product>) {
  const reserved = await InventoryUnit.countDocuments({ productId: product._id, status: "RESERVED" });
  if (reserved) throw new AppError(409, "UNITS_RESERVED", "A buyer is paying for a unit of this listing. Try again after the order settles.");
  await InventoryUnit.updateMany({ productId: product._id, status: "AVAILABLE", deletedAt: null }, { $set: { status: "UNLISTED" }, $inc: { rev: 1 } });
  await setListingStatus(String(product._id), "archived");
  await audit(req, "listing.archived", "Product", String(product._id));
}

seller.post(
  "/products/:id/archive",
  asyncHandler(async (req, res) => {
    await archiveListing(req, await ownListing(req, req.params.id));
    sendData(res, { archived: true });
  }),
);

/** Bulk actions over listings the showroom owns. Each id is checked against the showroom. */
seller.post(
  "/products/bulk",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        ids: z.array(objectId).min(1).max(200),
        action: z.enum(["publish", "unpublish", "archive", "price", "threshold", "warranty", "return_window"]),
        priceMode: z.enum(["set", "percent", "amount"]).optional(),
        value: z.number().optional(),
      })
      .parse(req.body);
    const products = await Product.find({ _id: { $in: body.ids }, businessId: bizId(req), deletedAt: null });
    const results: { id: string; ok: boolean; message?: string }[] = [];
    for (const product of products) {
      try {
        if (body.action === "publish" || body.action === "unpublish") await publishListing(req, product, body.action === "publish");
        else if (body.action === "archive") await archiveListing(req, product);
        else if (body.action === "price") {
          if (body.value === undefined || !body.priceMode) throw new AppError(400, "VALUE_REQUIRED", "Choose how to change the price.");
          if (product.promo?.promotionId) throw new AppError(409, "PROMOTION_ACTIVE", "Promotion running.");
          const current = product.pricePaise;
          const next =
            body.priceMode === "set" ? Math.round(body.value) : body.priceMode === "percent" ? Math.round(current * (1 + body.value / 100)) : Math.round(current + body.value);
          if (!Number.isFinite(next) || next < 100) throw new AppError(400, "INVALID_PRICE", "Price would fall below ₹1.");
          if (next !== current) {
            product.priceHistory.push({ pricePaise: next, reason: `bulk_${body.priceMode}`, by: req.user!._id as never, at: new Date() });
            product.pricePaise = next;
            await product.save();
            if (next < current) await notifyPriceAlerts(String(product._id), next);
          }
        } else if (body.action === "threshold") {
          product.lowStockThreshold = Math.max(0, Math.round(body.value ?? 0));
          await product.save();
          await syncListingStock(product._id);
        } else if (body.action === "warranty") {
          product.warrantyMonths = Math.max(0, Math.min(60, Math.round(body.value ?? 0)));
          await product.save();
        } else if (body.action === "return_window") {
          product.returnWindowDays = Math.max(0, Math.min(30, Math.round(body.value ?? 0)));
          await product.save();
        }
        results.push({ id: String(product._id), ok: true });
      } catch (error) {
        results.push({ id: String(product._id), ok: false, message: error instanceof Error ? error.message : "Failed" });
      }
    }
    const missing = body.ids.filter((id) => !products.some((product) => String(product._id) === id));
    for (const id of missing) results.push({ id, ok: false, message: "Not found in this showroom" });
    await audit(req, "listing.bulk", "Business", String(bizId(req)), { action: body.action, count: products.length });
    sendData(res, { updated: results.filter((row) => row.ok).length, results });
  }),
);

/** ================= Inventory ================= */

function presentUnit(unit: Record<string, any>) {
  return {
    id: String(unit._id),
    code: unit.code,
    productId: unit.productId ? String(unit.productId) : null,
    status: unit.status,
    allowed: MANUAL_TRANSITIONS[unit.status as UnitStatus] || [],
    condition: unit.condition,
    imeiLast4: unit.imeiLast4 || null,
    serialLast4: unit.serialLast4 || null,
    colour: unit.colour || null,
    storageGb: unit.storageGb || null,
    ramGb: unit.ramGb || null,
    batteryHealth: unit.batteryHealth || null,
    costPaise: unit.costPaise ?? null,
    pricePaise: unit.pricePaise ?? null,
    notes: unit.notes || "",
    warranty: unit.warranty || { months: 0, provider: "none" },
    claims: (unit.warrantyClaims || []).map((claim: Record<string, any>) => ({ id: String(claim._id), issue: claim.issue, status: claim.status, sellerNote: claim.sellerNote || null, createdAt: claim.createdAt })),
    reservedOrderId: unit.reservedOrderId ? String(unit.reservedOrderId) : null,
    soldOrderId: unit.soldOrderId ? String(unit.soldOrderId) : null,
    soldAt: unit.soldAt || null,
    rev: unit.rev || 0,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

async function ownUnit(req: Request, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Unit not found.");
  const unit = await InventoryUnit.findOne({ _id: id, businessId: bizId(req), deletedAt: null });
  if (!unit) throw notFound("Unit not found.");
  return unit;
}

seller.get(
  "/inventory",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { businessId: bizId(req), deletedAt: null };
    if (req.query.status && UNIT_STATUSES.includes(String(req.query.status) as UnitStatus)) filter.status = String(req.query.status);
    if (req.query.productId && Types.ObjectId.isValid(String(req.query.productId))) filter.productId = String(req.query.productId);
    if (req.query.unassigned === "true") filter.productId = null;
    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ code: new RegExp(escapeRegex(q), "i") }, { imeiLast4: q.slice(-4) }, { serialLast4: q.slice(-4) }, { colour: new RegExp(escapeRegex(q), "i") }];
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const [units, total, counts] = await Promise.all([
      InventoryUnit.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      InventoryUnit.countDocuments(filter),
      InventoryUnit.aggregate([{ $match: { businessId: bizId(req), deletedAt: null } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const products = await Product.find({ _id: { $in: units.map((unit) => unit.productId).filter(Boolean) } }).select("title listingCode slug").lean();
    const byId = new Map(products.map((product) => [String(product._id), product]));
    sendData(
      res,
      {
        units: units.map((unit) => {
          const product = unit.productId ? byId.get(String(unit.productId)) : null;
          return { ...presentUnit(unit), listing: product ? { id: String(product._id), title: product.title, listingCode: product.listingCode || null } : null };
        }),
        counts: Object.fromEntries((counts as { _id: string; n: number }[]).map((row) => [row._id, row.n])),
      },
      { page, limit, total, hasMore: page * limit < total } as never,
    );
  }),
);

seller.post(
  "/inventory",
  asyncHandler(async (req, res) => {
    const body = unitInputSchema.extend({ productId: objectId.optional() }).parse(req.body);
    const unit = await createUnit(bizId(req), req.user!._id as never, body);
    await audit(req, "inventory.unit_added", "InventoryUnit", String(unit._id), { code: unit.code });
    sendData(res, presentUnit(unit.toObject()), undefined, 201);
  }),
);

seller.post(
  "/inventory/bulk",
  asyncHandler(async (req, res) => {
    const body = z.object({ productId: objectId.optional(), units: z.array(unitInputSchema).min(1).max(200) }).parse(req.body);
    const created: string[] = [];
    const errors: { index: number; message: string }[] = [];
    for (const [index, unit] of body.units.entries()) {
      try {
        const saved = await createUnit(bizId(req), req.user!._id as never, { ...unit, productId: body.productId });
        created.push(saved.code);
      } catch (error) {
        errors.push({ index, message: error instanceof Error ? error.message : "Unit could not be added." });
      }
    }
    await audit(req, "inventory.bulk_added", "Business", String(bizId(req)), { count: created.length });
    sendData(res, { created, errors }, undefined, 201);
  }),
);

seller.get(
  "/inventory/movements",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { businessId: bizId(req) };
    if (req.query.unitId && Types.ObjectId.isValid(String(req.query.unitId))) filter.unitId = String(req.query.unitId);
    const rows = await InventoryMovement.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const units = await InventoryUnit.find({ _id: { $in: rows.map((row) => row.unitId) } }).select("code").lean();
    const codes = new Map(units.map((unit) => [String(unit._id), unit.code]));
    sendData(res, rows.map((row) => ({ id: String(row._id), unitId: String(row.unitId), unitCode: codes.get(String(row.unitId)) || null, from: row.from || null, to: row.to, reason: row.reason, orderId: row.orderId ? String(row.orderId) : null, at: row.createdAt })));
  }),
);

seller.get(
  "/inventory/alerts",
  asyncHandler(async (req, res) => {
    const threshold = biz(req).settings?.lowStockThreshold ?? 2;
    const products = await Product.find({ businessId: bizId(req), deletedAt: null, stockTracked: true, status: { $in: ["active", "pending_review", "draft"] } }).select("title listingCode stock lowStockThreshold status").lean();
    sendData(
      res,
      products
        .filter((product) => (product.stock?.available ?? 0) <= (product.lowStockThreshold ?? threshold))
        .map((product) => ({ id: String(product._id), title: product.title, listingCode: product.listingCode || null, available: product.stock?.available ?? 0, threshold: product.lowStockThreshold ?? threshold, level: (product.stock?.available ?? 0) === 0 ? "out" : "low" })),
    );
  }),
);

seller.patch(
  "/inventory/:id",
  asyncHandler(async (req, res) => {
    const unit = await ownUnit(req, req.params.id);
    const body = unitInputSchema.omit({ status: true }).extend({ rev: z.number().int().optional() }).parse(req.body);
    if (body.rev !== undefined && body.rev !== unit.rev) throw new AppError(409, "UNIT_CHANGED", "This unit was changed elsewhere. Refresh and try again.");
    if (["SOLD", "RESERVED"].includes(unit.status) && (body.imei || body.serial)) throw new AppError(409, "UNIT_LOCKED", "Identifiers of a sold or reserved unit can't change.");
    if (body.imei || body.serial) await assertUniqueIdentifiers({ imei: body.imei, serial: body.serial, exceptUnitId: unit._id });
    const { imei, serial, rev: _rev, warranty, ...rest } = body;
    void _rev;
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) unit.set(key, value);
    if (warranty) for (const [key, value] of Object.entries(warranty)) if (value !== undefined) unit.set(`warranty.${key}`, value);
    for (const [key, value] of Object.entries(identifierFields(imei, serial))) unit.set(key, value);
    unit.rev += 1;
    try {
      await unit.save();
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new AppError(409, "DUPLICATE_IDENTIFIER", "This IMEI or serial number is already in stock.");
      throw error;
    }
    await audit(req, "inventory.unit_updated", "InventoryUnit", String(unit._id), { fields: Object.keys(body) });
    sendData(res, presentUnit(unit.toObject()));
  }),
);

seller.post(
  "/inventory/:id/status",
  asyncHandler(async (req, res) => {
    const unit = await ownUnit(req, req.params.id);
    const body = z.object({ to: z.enum(UNIT_STATUSES), reason: z.string().trim().min(2).max(300), rev: z.number().int().optional() }).parse(req.body);
    const allowed = MANUAL_TRANSITIONS[unit.status as UnitStatus] || [];
    if (!allowed.includes(body.to)) throw new AppError(409, "INVALID_TRANSITION", `A ${unit.status.toLowerCase()} unit can't be set to ${body.to.toLowerCase()} by hand.`, { allowed });
    if (body.to === "AVAILABLE" && unit.productId) {
      const product = await Product.findOne({ _id: unit.productId, deletedAt: null }).select("_id");
      if (!product) throw new AppError(409, "LISTING_ARCHIVED", "Assign the unit to an active listing first.");
    }
    const updated = await changeUnitStatus({ unitId: unit._id, businessId: bizId(req), from: [unit.status as UnitStatus], to: body.to, reason: body.reason, actorId: req.user!._id as never, rev: body.rev });
    sendData(res, presentUnit(updated!.toObject()));
  }),
);

seller.post(
  "/inventory/:id/assign",
  asyncHandler(async (req, res) => {
    const unit = await ownUnit(req, req.params.id);
    const body = z.object({ productId: objectId.nullable() }).parse(req.body);
    if (["SOLD", "RESERVED"].includes(unit.status)) throw new AppError(409, "UNIT_LOCKED", "Sold or reserved units stay on their listing.");
    const previous = unit.productId;
    if (body.productId) {
      const product = await Product.findOne({ _id: body.productId, businessId: bizId(req), deletedAt: null, stockTracked: true });
      if (!product) throw notFound("Listing not found in this showroom.");
    }
    const updated = await InventoryUnit.findOneAndUpdate(
      { _id: unit._id, rev: unit.rev, status: { $nin: ["SOLD", "RESERVED"] } },
      { $set: { productId: body.productId }, $inc: { rev: 1 } },
      { new: true },
    );
    if (!updated) throw new AppError(409, "UNIT_CHANGED", "This unit changed. Refresh and try again.");
    await InventoryMovement.create({ businessId: bizId(req), unitId: unit._id, productId: body.productId, from: unit.status, to: unit.status, reason: body.productId ? "assigned_to_listing" : "removed_from_listing", actorId: req.user!._id });
    if (previous) await syncListingStock(previous);
    if (body.productId) await syncListingStock(body.productId);
    sendData(res, presentUnit(updated.toObject()));
  }),
);

/** Reveals the full IMEI/serial to the owner. Every reveal is audited. */
seller.get(
  "/inventory/:id/identifiers",
  asyncHandler(async (req, res) => {
    const unit = await ownUnit(req, req.params.id);
    await audit(req, "inventory.identifiers_viewed", "InventoryUnit", String(unit._id));
    sendData(res, { imei: unit.imeiCipher ? decryptSecret(unit.imeiCipher) : null, serial: unit.serialCipher ? decryptSecret(unit.serialCipher) : null });
  }),
);

seller.delete(
  "/inventory/:id",
  asyncHandler(async (req, res) => {
    const unit = await ownUnit(req, req.params.id);
    if (!["UNLISTED", "DAMAGED", "AVAILABLE"].includes(unit.status)) throw new AppError(409, "UNIT_LOCKED", "Only unsold units can be removed.");
    const removed = await InventoryUnit.findOneAndUpdate({ _id: unit._id, status: unit.status, rev: unit.rev }, { $set: { deletedAt: new Date(), imeiHash: undefined, serialHash: undefined }, $inc: { rev: 1 } });
    if (!removed) throw new AppError(409, "UNIT_CHANGED", "This unit changed. Refresh and try again.");
    await InventoryMovement.create({ businessId: bizId(req), unitId: unit._id, productId: unit.productId, from: unit.status, to: "REMOVED", reason: "removed", actorId: req.user!._id });
    if (unit.productId) await syncListingStock(unit.productId);
    await audit(req, "inventory.unit_removed", "InventoryUnit", String(unit._id), { code: unit.code });
    sendData(res, { removed: true });
  }),
);

/** ================= Warranty claims ================= */

seller.get(
  "/warranty-claims",
  asyncHandler(async (req, res) => {
    const units = await InventoryUnit.find({ businessId: bizId(req), "warrantyClaims.0": { $exists: true } }).select("code productId warranty warrantyClaims buyerId").lean();
    const products = await Product.find({ _id: { $in: units.map((unit) => unit.productId) } }).select("title").lean();
    const titles = new Map(products.map((product) => [String(product._id), product.title]));
    const rows = units.flatMap((unit) =>
      unit.warrantyClaims.map((claim) => ({
        unitId: String(unit._id),
        unitCode: unit.code,
        title: titles.get(String(unit.productId)) || "Device",
        warranty: unit.warranty,
        claimId: String(claim._id),
        issue: claim.issue,
        status: claim.status,
        sellerNote: claim.sellerNote || null,
        createdAt: claim.createdAt,
      })),
    );
    sendData(res, rows.sort((a, b) => +new Date(b.createdAt!) - +new Date(a.createdAt!)));
  }),
);

seller.post(
  "/warranty-claims/:unitId/:claimId",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["accepted", "in_repair", "resolved", "rejected"]), note: z.string().trim().max(1000).optional() }).parse(req.body);
    if (body.status === "rejected" && !body.note) throw new AppError(400, "REASON_REQUIRED", "Explain why the claim is rejected.");
    const unit = await ownUnit(req, req.params.unitId);
    const claim = unit.warrantyClaims.id(req.params.claimId);
    if (!claim) throw notFound("Claim not found.");
    const order: Record<string, string[]> = { open: ["accepted", "rejected"], accepted: ["in_repair", "resolved"], in_repair: ["resolved"] };
    if (!(order[claim.status] || []).includes(body.status)) throw new AppError(409, "INVALID_TRANSITION", `A ${claim.status.replace("_", " ")} claim can't be marked ${body.status.replace("_", " ")}.`);
    claim.status = body.status;
    claim.sellerNote = body.note || claim.sellerNote;
    if (body.status === "resolved" || body.status === "rejected") claim.resolvedAt = new Date();
    await unit.save();
    await notify({ userId: String(claim.buyerId), event: "warranty.updated", title: `Warranty claim ${body.status.replace("_", " ")}`, body: body.note || `Your claim for ${unit.code} is ${body.status.replace("_", " ")}.`, data: { unitId: String(unit._id) } });
    sendData(res, { status: claim.status });
  }),
);

/** ================= Orders & delivery ================= */

seller.get(
  "/orders",
  asyncHandler(async (req, res) => {
    const match: Record<string, unknown> = { "subOrders.businessId": bizId(req), "subOrders.sellerUserId": req.user!._id };
    const status = String(req.query.status || "");
    const q = String(req.query.q || "").trim();
    if (q) match.number = new RegExp(escapeRegex(q), "i");
    const orders = await Order.find({ ...match, status: { $ne: "pending_payment" } }).sort({ createdAt: -1 }).limit(300).lean();
    const buyers = await User.find({ _id: { $in: orders.map((order) => order.buyerId) } }).select("displayName").lean();
    const buyerById = new Map(buyers.map((buyer) => [String(buyer._id), buyer]));
    let rows = orders.flatMap((order) =>
      order.subOrders
        .filter((sub) => String(sub.businessId) === String(bizId(req)) && sub.status !== "pending_payment")
        .map((sub) => presentSubOrder(order, sub, buyerById.get(String(order.buyerId)))),
    );
    const groups: Record<string, string[]> = {
      new: ["paid"],
      active: ["accepted", "confirmed", "processing", "ready_for_dispatch"],
      shipping: ["dispatched", "shipped"],
      completed: ["delivered"],
      closed: ["rejected", "cancelled", "returned", "refunded"],
    };
    if (groups[status]) rows = rows.filter((row) => groups[status]!.includes(row.status));
    else if (status) rows = rows.filter((row) => row.status === status);
    sendData(res, rows);
  }),
);

seller.get(
  "/orders/:orderId/:subId",
  asyncHandler(async (req, res) => {
    const { order, sub } = await loadSellerSubOrder(req, req.params.orderId, req.params.subId);
    const buyer = await User.findById(order.buyerId).select("displayName").lean();
    const payment = order.paymentId ? await Payment.findById(order.paymentId).select("status provider createdAt").lean() : null;
    const refunds = await Refund.find({ orderId: order._id, subOrderId: sub._id }).select("status amountPaise reason createdAt").lean();
    const returns = await ReturnRequest.find({ orderId: order._id, subOrderId: sub._id }).select("number status reason createdAt").lean();
    sendData(res, { ...presentSubOrder(order.toObject(), sub.toObject(), buyer), payment: payment ? { status: payment.status, provider: payment.provider } : null, refunds, returns });
  }),
);

seller.post(
  "/orders/:orderId/:subId/status",
  asyncHandler(async (req, res) => {
    const body = z.object({ to: z.enum(["accepted", "rejected", "processing", "ready_for_dispatch", "dispatched", "cancelled"]), note: z.string().trim().max(500).optional() }).parse(req.body);
    const order = await changeSubOrderStatus(req, req.params.orderId, req.params.subId, body.to, body.note);
    const sub = order.subOrders.id(req.params.subId)!;
    sendData(res, presentSubOrder(order.toObject(), sub.toObject()));
  }),
);

seller.patch(
  "/orders/:orderId/:subId/delivery",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        method: z.enum(["self", "courier"]).optional(),
        courier: z.string().trim().max(80).optional(),
        trackingNumber: z.string().trim().max(80).optional(),
        trackingUrl: z.string().trim().max(400).optional(),
        expectedAt: z.string().max(40).optional(),
      })
      .parse(req.body);
    const order = await updateDeliveryDetails(req, req.params.orderId, req.params.subId, body);
    sendData(res, presentSubOrder(order.toObject(), order.subOrders.id(req.params.subId)!.toObject()));
  }),
);

seller.post(
  "/orders/:orderId/:subId/delivery/status",
  asyncHandler(async (req, res) => {
    const body = z.object({ to: z.enum(DELIVERY_STATUSES), note: z.string().trim().max(500).optional() }).parse(req.body);
    if (body.to === "DELIVERED") throw new AppError(400, "PROOF_REQUIRED", "Use handover with the buyer's code to mark delivered.");
    const order = await changeDeliveryStatus(req, req.params.orderId, req.params.subId, body.to, body.note);
    sendData(res, presentSubOrder(order.toObject(), order.subOrders.id(req.params.subId)!.toObject()));
  }),
);

seller.post(
  "/orders/:orderId/:subId/delivery/documents",
  asyncHandler(async (req, res) => {
    const body = z.object({ key: z.string().min(5).max(300), name: z.string().trim().min(1).max(120) }).parse(req.body);
    assertOwnPrivateKey(body.key, String(req.user!._id), "business_document");
    const order = await addDeliveryDocument(req, req.params.orderId, req.params.subId, body);
    sendData(res, presentSubOrder(order.toObject(), order.subOrders.id(req.params.subId)!.toObject()), undefined, 201);
  }),
);

seller.post(
  "/orders/:orderId/:subId/handover",
  asyncHandler(async (req, res) => {
    const body = z.object({ otp: z.string().trim().regex(/^[0-9]{6}$/).optional(), photoKey: z.string().max(300).optional(), note: z.string().trim().max(500).optional() }).parse(req.body);
    if (body.photoKey) assertOwnPrivateKey(body.photoKey, String(req.user!._id), "business_document");
    const order = await completeHandover(req, req.params.orderId, req.params.subId, body);
    sendData(res, presentSubOrder(order.toObject(), order.subOrders.id(req.params.subId)!.toObject()));
  }),
);

seller.get(
  "/deliveries",
  asyncHandler(async (req, res) => {
    const orders = await Order.find({ "subOrders.businessId": bizId(req), "subOrders.delivery.status": { $exists: true } }).sort({ updatedAt: -1 }).limit(300).lean();
    const buyers = await User.find({ _id: { $in: orders.map((order) => order.buyerId) } }).select("displayName").lean();
    const buyerById = new Map(buyers.map((buyer) => [String(buyer._id), buyer]));
    const status = String(req.query.status || "");
    const rows = orders
      .flatMap((order) => order.subOrders.filter((sub) => String(sub.businessId) === String(bizId(req)) && sub.delivery?.status).map((sub) => presentSubOrder(order, sub, buyerById.get(String(order.buyerId)))))
      .filter((row) => !status || row.delivery?.status === status);
    sendData(res, rows);
  }),
);

/** ================= Customers ================= */

seller.get(
  "/customers",
  asyncHandler(async (req, res) => {
    const rows = await Order.aggregate([
      { $unwind: "$subOrders" },
      { $match: { "subOrders.businessId": bizId(req), "subOrders.status": { $ne: "pending_payment" } } },
      {
        $group: {
          _id: "$buyerId",
          orders: { $sum: 1 },
          spentPaise: { $sum: { $cond: [{ $in: ["$subOrders.status", LIVE_SUB] }, "$subOrders.amountPaise", 0] } },
          firstOrderAt: { $min: "$createdAt" },
          lastOrderAt: { $max: "$createdAt" },
          city: { $last: "$address.city" },
        },
      },
      { $sort: { lastOrderAt: -1 } },
      { $limit: 500 },
    ]);
    const chats = await Conversation.aggregate([
      { $match: { sellerUserId: req.user!._id, kind: { $ne: "inspection" } } },
      { $group: { _id: "$buyerId", chats: { $sum: 1 }, lastChatAt: { $max: "$lastMessageAt" } } },
    ]);
    const chatByBuyer = new Map(chats.map((row) => [String(row._id), row]));
    const ids = [...new Set([...rows.map((row) => String(row._id)), ...chats.map((row) => String(row._id))])];
    const users = await User.find({ _id: { $in: ids } }).select("displayName createdAt").lean();
    const userById = new Map(users.map((user) => [String(user._id), user]));
    const customers = ids.map((id) => {
      const order = rows.find((row) => String(row._id) === id);
      const chat = chatByBuyer.get(id);
      return {
        id,
        name: userById.get(id)?.displayName || "Buyer",
        city: order?.city || null,
        orders: order?.orders || 0,
        spentPaise: order?.spentPaise || 0,
        firstOrderAt: order?.firstOrderAt || null,
        lastOrderAt: order?.lastOrderAt || null,
        chats: chat?.chats || 0,
        lastChatAt: chat?.lastChatAt || null,
        kind: order ? (order.orders > 1 ? "repeat" : "customer") : "lead",
      };
    });
    const q = String(req.query.q || "").trim().toLowerCase();
    const kind = String(req.query.kind || "");
    sendData(res, customers.filter((customer) => (!q || customer.name.toLowerCase().includes(q)) && (!kind || customer.kind === kind)));
  }),
);

/** ================= Inspections & service partners ================= */

seller.get(
  "/inspections",
  asyncHandler(async (req, res) => {
    const requests = await InspectionRequest.find({ sellerUserId: req.user!._id, status: { $ne: "pending_payment" } }).sort({ createdAt: -1 }).limit(200).lean();
    const [products, plans, partners, reports] = await Promise.all([
      Product.find({ _id: { $in: requests.map((row) => row.productId) } }).select("title slug").lean(),
      InspectionPlan.find({ _id: { $in: requests.map((row) => row.planId) } }).select("name tier").lean(),
      PartnerProfile.find({ _id: { $in: requests.map((row) => row.assignedPartnerId).filter(Boolean) } }).select("name stats").lean(),
      InspectionReport.find({ requestId: { $in: requests.map((row) => row._id) } }).sort({ version: -1 }).select("requestId score verdict published").lean(),
    ]);
    const find = <T extends { _id: unknown }>(list: T[], id: unknown) => list.find((item) => String(item._id) === String(id));
    sendData(
      res,
      requests.map((row) => {
        const report = reports.find((item) => String(item.requestId) === String(row._id));
        const partner = find(partners, row.assignedPartnerId);
        return {
          id: String(row._id),
          number: row.number,
          status: row.status,
          mode: row.mode || "physical",
          appointmentAt: row.appointmentAt || null,
          product: find(products, row.productId) ? { id: String(row.productId), title: find(products, row.productId)!.title, slug: find(products, row.productId)!.slug } : null,
          plan: find(plans, row.planId)?.name || null,
          partner: partner ? { id: String(partner._id), name: partner.name } : null,
          conversationId: row.conversationId ? String(row.conversationId) : null,
          coordination: row.coordination || {},
          // Findings are the partner's; the seller sees the outcome only.
          report: report ? { score: report.score, verdict: report.verdict, published: report.published } : null,
          createdAt: row.createdAt,
        };
      }),
    );
  }),
);

seller.patch(
  "/inspections/:id/coordination",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        deviceReady: z.boolean().optional(),
        preferredSlots: z.array(z.string().trim().max(80)).max(6).optional(),
        meetingLink: z.string().trim().max(300).optional(),
        sellerNote: z.string().trim().max(1000).optional(),
      })
      .parse(req.body);
    if (body.meetingLink && !/^https:\/\//i.test(body.meetingLink)) throw new AppError(400, "INVALID_URL", "Meeting links must start with https://");
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound("Inspection not found.");
    const request = await InspectionRequest.findOne({ _id: req.params.id, sellerUserId: req.user!._id });
    if (!request) throw notFound("Inspection not found.");
    if (["report_submitted", "completed", "cancelled", "expired"].includes(request.status)) throw new AppError(409, "INSPECTION_CLOSED", "This inspection is closed.");
    for (const [key, value] of Object.entries(body)) if (value !== undefined) request.set(`coordination.${key}`, value);
    request.set("coordination.sellerConfirmedAt", new Date());
    await request.save();
    const partner = request.assignedPartnerId ? await PartnerProfile.findById(request.assignedPartnerId).select("userId").lean() : null;
    if (partner) await notify({ userId: String(partner.userId), event: "inspection.coordination", title: "Seller updated the inspection", body: `${request.number}: ${body.deviceReady ? "device is ready" : "new arrangement details"}.`, data: { requestId: String(request._id) } });
    sendData(res, { coordination: request.coordination });
  }),
);

seller.get(
  "/service-partners",
  asyncHandler(async (req, res) => {
    const rows = await InspectionRequest.aggregate([
      { $match: { sellerUserId: req.user!._id, assignedPartnerId: { $exists: true, $ne: null } } },
      { $group: { _id: "$assignedPartnerId", inspections: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$status", ["accepted", "scheduled", "in_progress"]] }, 1, 0] } }, last: { $max: "$createdAt" }, conversations: { $addToSet: "$conversationId" } } },
      { $sort: { last: -1 } },
    ]);
    const partners = await PartnerProfile.find({ _id: { $in: rows.map((row) => row._id) } }).select("name categories experienceYears stats address.city verificationStatus").lean();
    sendData(
      res,
      rows.map((row) => {
        const partner = partners.find((item) => String(item._id) === String(row._id));
        const stats = partner?.stats;
        return {
          id: String(row._id),
          name: partner?.name || "Partner",
          city: partner?.address?.city || null,
          verified: partner?.verificationStatus === "approved",
          experienceYears: partner?.experienceYears || 0,
          rating: stats?.ratingCount ? Math.round((stats.ratingSum / stats.ratingCount) * 10) / 10 : null,
          completed: stats?.completed || 0,
          inspections: row.inspections,
          open: row.open,
          lastAt: row.last,
          conversationIds: (row.conversations || []).filter(Boolean).map(String),
        };
      }),
    );
  }),
);

/** ================= Promotions & featured requests ================= */

seller.get(
  "/promotions",
  asyncHandler(async (req, res) => {
    const [promotions, features] = await Promise.all([
      Promotion.find({ businessId: bizId(req) }).sort({ createdAt: -1 }).limit(100).lean(),
      FeatureRequest.find({ businessId: bizId(req) }).sort({ createdAt: -1 }).limit(100).lean(),
    ]);
    const productIds = [...promotions.flatMap((promo) => promo.productIds), ...features.map((row) => row.productId)];
    const products = await Product.find({ _id: { $in: productIds } }).select("title featuredUntil").lean();
    const title = (id: unknown) => products.find((product) => String(product._id) === String(id))?.title || "Listing";
    sendData(res, {
      promotions: promotions.map((promo) => ({ id: String(promo._id), name: promo.name, kind: promo.kind, value: promo.value, startsAt: promo.startsAt, endsAt: promo.endsAt, status: promo.status, products: promo.productIds.map((id) => ({ id: String(id), title: title(id) })) })),
      featureRequests: features.map((row) => ({ id: String(row._id), productId: String(row.productId), title: title(row.productId), days: row.days, status: row.status, note: row.note, adminNote: row.adminNote || null, createdAt: row.createdAt, featuredUntil: products.find((product) => String(product._id) === String(row.productId))?.featuredUntil || null })),
    });
  }),
);

seller.post(
  "/promotions",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(120),
        productIds: z.array(objectId).min(1).max(200),
        kind: z.enum(["percent", "amount"]),
        value: z.number().positive(),
        startsAt: z.string().datetime({ offset: true }).optional(),
        endsAt: z.string().datetime({ offset: true }),
      })
      .parse(req.body);
    if (body.kind === "percent" && body.value > 90) throw new AppError(400, "DISCOUNT_TOO_HIGH", "A discount can be at most 90%.");
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    const endsAt = new Date(body.endsAt);
    if (endsAt <= startsAt) throw new AppError(400, "INVALID_DATES", "The promotion must end after it starts.");
    if (endsAt.getTime() - startsAt.getTime() > 90 * 24 * 60 * 60 * 1000) throw new AppError(400, "TOO_LONG", "Promotions can run for up to 90 days.");
    const products = await Product.find({ _id: { $in: body.productIds }, businessId: bizId(req), deletedAt: null });
    if (products.length !== new Set(body.productIds).size) throw notFound("Some listings are not in this showroom.");
    for (const product of products) {
      const amountValue = Math.round(body.value);
      if (body.kind === "amount" && amountValue >= (product.promo?.basePricePaise || product.pricePaise)) throw new AppError(400, "DISCOUNT_TOO_HIGH", `The discount is larger than the price of ${product.title}.`);
    }
    const overlap = await Promotion.findOne({ businessId: bizId(req), productIds: { $in: body.productIds }, status: { $in: ["scheduled", "active"] }, startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt } });
    if (overlap) throw new AppError(409, "PROMOTION_OVERLAP", `"${overlap.name}" already covers one of these listings in that period.`);
    const promotion = await Promotion.create({ businessId: bizId(req), name: body.name, productIds: body.productIds, kind: body.kind, value: body.kind === "amount" ? Math.round(body.value) : body.value, startsAt, endsAt, createdBy: req.user!._id });
    await audit(req, "promotion.created", "Promotion", String(promotion._id), { products: body.productIds.length });
    const { runPromotions } = await import("../services/promotion.service");
    await runPromotions();
    sendData(res, promotion, undefined, 201);
  }),
);

seller.post(
  "/promotions/:id/cancel",
  asyncHandler(async (req, res) => {
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const promotion = await Promotion.findOne({ _id: req.params.id, businessId: bizId(req), status: { $in: ["scheduled", "active"] } });
    if (!promotion) throw notFound("Promotion not found or already ended.");
    promotion.status = "cancelled";
    await promotion.save();
    const { endPromotion } = await import("../services/promotion.service");
    await endPromotion(promotion._id);
    await audit(req, "promotion.cancelled", "Promotion", String(promotion._id));
    sendData(res, { cancelled: true });
  }),
);

seller.post(
  "/feature-requests",
  asyncHandler(async (req, res) => {
    const body = z.object({ productId: objectId, days: z.number().int().min(1).max(90), note: z.string().trim().max(500).default("") }).parse(req.body);
    const product = await Product.findOne({ _id: body.productId, businessId: bizId(req), deletedAt: null, status: "active" });
    if (!product) throw new AppError(409, "LISTING_NOT_LIVE", "Only live listings can be featured.");
    const pending = await FeatureRequest.findOne({ productId: product._id, status: "pending" });
    if (pending) throw new AppError(409, "REQUEST_PENDING", "A feature request for this listing is already pending.");
    const row = await FeatureRequest.create({ businessId: bizId(req), productId: product._id, days: body.days, note: body.note });
    const admins = await User.find({ roles: "super_admin", status: "active" }).select("_id");
    await Promise.all(admins.map((admin) => notify({ userId: String(admin._id), event: "feature.requested", title: "Featured listing request", body: `${biz(req).name} asked to feature ${product.title} for ${body.days} days.`, data: { requestId: String(row._id) } })));
    sendData(res, row, undefined, 201);
  }),
);

seller.post(
  "/feature-requests/:id/cancel",
  asyncHandler(async (req, res) => {
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const row = await FeatureRequest.findOneAndUpdate({ _id: req.params.id, businessId: bizId(req), status: "pending" }, { status: "cancelled" }, { new: true });
    if (!row) throw notFound("Request not found.");
    sendData(res, row);
  }),
);

/** ================= Reviews ================= */

seller.get(
  "/reviews",
  asyncHandler(async (req, res) => {
    const productIds = (await Product.find({ businessId: bizId(req) }).select("_id").lean()).map((product) => product._id);
    const filter = { status: { $ne: "hidden" }, $or: [{ targetType: "business", targetId: bizId(req) }, { targetType: "product", targetId: { $in: productIds } }] };
    const reviews = await Review.find(filter).sort({ createdAt: -1 }).limit(300).lean();
    const [authors, products] = await Promise.all([
      User.find({ _id: { $in: reviews.map((row) => row.authorId) } }).select("displayName").lean(),
      Product.find({ _id: { $in: reviews.filter((row) => row.targetType === "product").map((row) => row.targetId) } }).select("title").lean(),
    ]);
    const distribution = [1, 2, 3, 4, 5].map((star) => ({ star, count: reviews.filter((row) => row.rating === star).length }));
    const replied = reviews.filter((row) => row.sellerReply).length;
    sendData(res, {
      summary: {
        count: reviews.length,
        average: reviews.length ? Math.round((reviews.reduce((sum, row) => sum + row.rating, 0) / reviews.length) * 10) / 10 : null,
        distribution,
        replyRate: reviews.length ? Math.round((replied / reviews.length) * 100) : 0,
        last30: reviews.filter((row) => row.createdAt > daysAgo(30)).length,
      },
      reviews: reviews.map((row) => ({
        id: String(row._id),
        rating: row.rating,
        body: row.body,
        author: authors.find((author) => String(author._id) === String(row.authorId))?.displayName || "Buyer",
        product: row.targetType === "product" ? products.find((product) => String(product._id) === String(row.targetId))?.title || null : null,
        verifiedPurchase: row.verifiedPurchase,
        sellerReply: row.sellerReply || null,
        reported: (row.reports || []).some((report) => String(report.by) === String(req.user!._id)),
        status: row.status,
        createdAt: row.createdAt,
      })),
    });
  }),
);

async function ownReview(req: Request, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Review not found.");
  const review = await Review.findById(id);
  if (!review) throw notFound("Review not found.");
  if (review.targetType === "business" && String(review.targetId) === String(bizId(req))) return review;
  if (review.targetType === "product" && (await Product.exists({ _id: review.targetId, businessId: bizId(req) }))) return review;
  throw notFound("Review not found.");
}

seller.post(
  "/reviews/:id/reply",
  asyncHandler(async (req, res) => {
    const body = z.object({ reply: z.string().trim().min(2).max(1000) }).parse(req.body);
    const review = await ownReview(req, req.params.id);
    review.sellerReply = body.reply;
    review.sellerRepliedAt = new Date();
    await review.save();
    await notify({ userId: String(review.authorId), event: "review.replied", title: "The seller replied to your review", body: body.reply.slice(0, 140) });
    sendData(res, { sellerReply: review.sellerReply });
  }),
);

seller.post(
  "/reviews/:id/report",
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const review = await ownReview(req, req.params.id);
    if (review.reports.some((report) => String(report.by) === String(req.user!._id))) throw new AppError(409, "ALREADY_REPORTED", "You already reported this review.");
    review.reports.push({ by: req.user!._id as never, reason: body.reason, at: new Date(), status: "open" });
    review.status = "flagged";
    await review.save();
    await audit(req, "review.reported", "Review", String(review._id), { reason: body.reason });
    sendData(res, { reported: true });
  }),
);

/** ================= Returns ================= */

seller.get(
  "/returns",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { businessId: bizId(req), sellerUserId: req.user!._id };
    if (req.query.status) filter.status = String(req.query.status);
    const rows = await ReturnRequest.find(filter).sort({ createdAt: -1 }).limit(300).lean();
    const [orders, products, buyers, units] = await Promise.all([
      Order.find({ _id: { $in: rows.map((row) => row.orderId) } }).select("number").lean(),
      Product.find({ _id: { $in: rows.map((row) => row.productId) } }).select("title").lean(),
      User.find({ _id: { $in: rows.map((row) => row.buyerId) } }).select("displayName").lean(),
      InventoryUnit.find({ _id: { $in: rows.map((row) => row.unitId).filter(Boolean) } }).select("code").lean(),
    ]);
    const pick = <T extends { _id: unknown }>(list: T[], id: unknown) => list.find((item) => String(item._id) === String(id));
    const { RETURN_TRANSITIONS } = await import("../services/showroom-orders.service");
    const { mediaUrl } = await import("../integrations/storage");
    sendData(
      res,
      rows.map((row) => ({
        id: String(row._id),
        number: row.number,
        orderId: String(row.orderId),
        subOrderId: String(row.subOrderId),
        orderNumber: pick(orders, row.orderId)?.number || null,
        product: pick(products, row.productId)?.title || null,
        unitCode: pick(units, row.unitId)?.code || null,
        buyer: pick(buyers, row.buyerId)?.displayName || "Buyer",
        reason: row.reason,
        details: row.details,
        images: (row.imageKeys || []).map((key) => mediaUrl(key)),
        amountPaise: row.amountPaise,
        status: row.status,
        allowed: RETURN_TRANSITIONS[row.status] || [],
        sellerNote: row.sellerNote || null,
        unitCondition: row.unitCondition || null,
        timeline: row.timeline,
        createdAt: row.createdAt,
      })),
    );
  }),
);

seller.post(
  "/returns/:id/action",
  asyncHandler(async (req, res) => {
    const body = z.object({ to: z.enum(["approved", "rejected", "pickup_scheduled", "received", "refund_requested"]), note: z.string().trim().max(1000).optional(), unitCondition: z.enum(["resellable", "damaged", "repair"]).optional() }).parse(req.body);
    sendData(res, await sellerReturnAction(req, req.params.id, body));
  }),
);

/** ================= Payments & settlements (real records only) ================= */

seller.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const fees = await platformFees();
    const orders = await Order.find({ "subOrders.businessId": bizId(req), status: { $ne: "pending_payment" } }).sort({ createdAt: -1 }).limit(1000).lean();
    const payments = await Payment.find({ _id: { $in: orders.map((order) => order.paymentId).filter(Boolean) } }).select("status provider gatewayPaymentId createdAt").lean();
    const paymentById = new Map(payments.map((payment) => [String(payment._id), payment]));
    const refunds = await Refund.find({ orderId: { $in: orders.map((order) => order._id) } }).lean();
    const holdMs = fees.settlementHoldDays * 24 * 60 * 60 * 1000;
    const lines = orders.flatMap((order) =>
      order.subOrders
        .filter((sub) => String(sub.businessId) === String(bizId(req)) && sub.status !== "pending_payment")
        .map((sub) => {
          const gross = Number(sub.amountPaise || 0);
          const commission = Math.round((gross * fees.commissionPercent) / 100);
          const gatewayFee = Math.round((gross * fees.gatewayFeePercent) / 100);
          const refunded = refunds.filter((refund) => String(refund.subOrderId) === String(sub._id) && refund.status === "processed").reduce((sum, refund) => sum + refund.amountPaise, 0);
          const payment = paymentById.get(String(order.paymentId));
          const earned = sub.status === "delivered" && sub.deliveredAt;
          const releasable = earned && Date.now() - new Date(sub.deliveredAt!).getTime() >= holdMs;
          return {
            orderId: String(order._id),
            subOrderId: String(sub._id),
            number: order.number,
            createdAt: order.createdAt,
            status: sub.status,
            paymentStatus: payment?.status || "unknown",
            provider: payment?.provider || null,
            grossPaise: gross,
            commissionPaise: commission,
            gatewayFeePaise: gatewayFee,
            refundedPaise: refunded,
            netPaise: Math.max(0, gross - commission - gatewayFee - refunded),
            stage: ["rejected", "cancelled", "refunded", "returned"].includes(sub.status) ? "void" : releasable ? "releasable" : earned ? "on_hold" : "in_progress",
          };
        }),
    );
    const settlements = await SellerSettlement.find({ sellerUserId: req.user!._id }).sort({ createdAt: -1 }).lean();
    const settled = settlements.reduce((sum, row) => sum + row.amountPaise, 0);
    const sum = (stage: string) => lines.filter((line) => line.stage === stage).reduce((total, line) => total + line.netPaise, 0);
    const releasable = sum("releasable");
    sendData(res, {
      fees,
      totals: {
        grossPaise: lines.filter((line) => line.stage !== "void").reduce((total, line) => total + line.grossPaise, 0),
        inProgressPaise: sum("in_progress"),
        onHoldPaise: sum("on_hold"),
        releasablePaise: releasable,
        settledPaise: settled,
        payablePaise: Math.max(0, releasable - settled),
        refundedPaise: lines.reduce((total, line) => total + line.refundedPaise, 0),
      },
      lines,
      settlements: settlements.map((row) => ({ id: String(row._id), amountPaise: row.amountPaise, reference: row.reference, note: row.note, createdAt: row.createdAt })),
      bank: biz(req).bank?.accountNumberLast4 ? { accountName: biz(req).bank!.accountName, accountNumberLast4: biz(req).bank!.accountNumberLast4, ifsc: biz(req).bank!.ifsc } : null,
    });
  }),
);

/** ================= Analytics & reports ================= */

seller.get(
  "/analytics",
  asyncHandler(async (req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const since = daysAgo(days);
    const id = bizId(req);
    const [sales, topProducts, byCategory, listingStats, returns, units, conversations, inspections] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $unwind: "$subOrders" },
        { $match: { "subOrders.businessId": id, "subOrders.status": { $ne: "pending_payment" } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
            revenue: { $sum: { $cond: [{ $in: ["$subOrders.status", LIVE_SUB] }, "$subOrders.amountPaise", 0] } },
            orders: { $sum: 1 },
            lost: { $sum: { $cond: [{ $in: ["$subOrders.status", ["rejected", "cancelled", "refunded", "returned"]] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $unwind: "$subOrders" },
        { $match: { "subOrders.businessId": id, "subOrders.status": { $in: LIVE_SUB } } },
        { $unwind: "$subOrders.items" },
        { $group: { _id: "$subOrders.items.productId", title: { $first: "$subOrders.items.title" }, units: { $sum: 1 }, revenue: { $sum: "$subOrders.items.pricePaise" } } },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $unwind: "$subOrders" },
        { $match: { "subOrders.businessId": id, "subOrders.status": { $in: LIVE_SUB } } },
        { $unwind: "$subOrders.items" },
        { $lookup: { from: "products", localField: "subOrders.items.productId", foreignField: "_id", as: "product" } },
        { $unwind: "$product" },
        { $group: { _id: { category: "$product.categorySlug", itemType: "$product.itemType" }, units: { $sum: 1 }, revenue: { $sum: "$subOrders.items.pricePaise" } } },
      ]),
      Product.aggregate([{ $match: { businessId: id, deletedAt: null } }, { $group: { _id: null, views: { $sum: "$stats.views" }, listings: { $sum: 1 } } }]),
      ReturnRequest.countDocuments({ businessId: id, createdAt: { $gte: since } }),
      InventoryUnit.aggregate([
        { $match: { businessId: id, deletedAt: null } },
        { $group: { _id: "$status", n: { $sum: 1 }, cost: { $sum: { $ifNull: ["$costPaise", 0] } }, soldCost: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "SOLD"] }, { $gte: ["$soldAt", since] }] }, { $ifNull: ["$costPaise", 0] }, 0] } } } },
      ]),
      Conversation.countDocuments({ sellerUserId: req.user!._id, kind: { $ne: "inspection" }, createdAt: { $gte: since } }),
      InspectionRequest.countDocuments({ sellerUserId: req.user!._id, createdAt: { $gte: since }, status: { $ne: "pending_payment" } }),
    ]);
    const totalRevenue = (sales as { revenue: number }[]).reduce((sum, row) => sum + row.revenue, 0);
    const totalOrders = (sales as { orders: number }[]).reduce((sum, row) => sum + row.orders, 0);
    const lost = (sales as { lost: number }[]).reduce((sum, row) => sum + row.lost, 0);
    const views = listingStats[0]?.views || 0;
    const soldCost = (units as { soldCost: number }[]).reduce((sum, row) => sum + row.soldCost, 0);
    sendData(res, {
      days,
      totals: {
        revenuePaise: totalRevenue,
        orders: totalOrders,
        averageOrderPaise: totalOrders - lost > 0 ? Math.round(totalRevenue / (totalOrders - lost)) : 0,
        cancellations: lost,
        returns,
        conversations,
        inspections,
        views,
        conversionPercent: views ? Math.round(((totalOrders - lost) / views) * 1000) / 10 : null,
        // Margin only counts units with a recorded cost price.
        grossMarginPaise: soldCost ? totalRevenue - soldCost : null,
      },
      daily: sales.map((row: { _id: string; revenue: number; orders: number }) => ({ date: row._id, revenuePaise: row.revenue, orders: row.orders })),
      topProducts: topProducts.map((row: { _id: unknown; title: string; units: number; revenue: number }) => ({ id: String(row._id), title: row.title, units: row.units, revenuePaise: row.revenue })),
      byCategory: byCategory.map((row: { _id: { category: string; itemType?: string }; units: number; revenue: number }) => ({ category: row._id.category, itemType: row._id.itemType || "used", units: row.units, revenuePaise: row.revenue })),
      inventory: Object.fromEntries((units as { _id: string; n: number; cost: number }[]).map((row) => [row._id, { units: row.n, costPaise: row.cost }])),
    });
  }),
);

seller.get(
  "/reports/:type",
  asyncHandler(async (req, res) => {
    const type = z.enum(["sales", "inventory", "returns", "payments", "movements"]).parse(req.params.type);
    const days = Math.min(730, Math.max(1, Number(req.query.days) || 90));
    const since = daysAgo(days);
    const id = bizId(req);
    const rupees = (paise?: number | null) => (paise === undefined || paise === null ? "" : (paise / 100).toFixed(2));
    if (type === "sales" || type === "payments") {
      const orders = await Order.find({ "subOrders.businessId": id, createdAt: { $gte: since }, status: { $ne: "pending_payment" } }).sort({ createdAt: -1 }).lean();
      const fees = await platformFees();
      const rows = orders.flatMap((order) =>
        order.subOrders
          .filter((sub) => String(sub.businessId) === String(id) && sub.status !== "pending_payment")
          .flatMap((sub) =>
            sub.items.map((item) => ({
              date: order.createdAt,
              order: order.number,
              status: sub.status,
              fulfillment: sub.fulfillment,
              item: item.title,
              unit: item.unitCode || "",
              price: rupees(item.pricePaise),
              commission: rupees(Math.round(((item.pricePaise || 0) * fees.commissionPercent) / 100)),
              gatewayFee: rupees(Math.round(((item.pricePaise || 0) * fees.gatewayFeePercent) / 100)),
              deliveredAt: sub.deliveredAt || "",
              city: (order.address as { city?: string } | undefined)?.city || "",
            })),
          ),
      );
      const columns = type === "sales" ? ["date", "order", "status", "fulfillment", "item", "unit", "price", "city", "deliveredAt"] : ["date", "order", "status", "item", "price", "commission", "gatewayFee", "deliveredAt"];
      return sendCsv(res, type, csv(rows, columns));
    }
    if (type === "inventory") {
      const units = await InventoryUnit.find({ businessId: id, deletedAt: null }).lean();
      const products = await Product.find({ _id: { $in: units.map((unit) => unit.productId).filter(Boolean) } }).select("title listingCode").lean();
      const rows = units.map((unit) => {
        const product = products.find((item) => String(item._id) === String(unit.productId));
        return { unit: unit.code, listing: product?.listingCode || "", title: product?.title || "", status: unit.status, condition: unit.condition, imeiLast4: unit.imeiLast4 || "", serialLast4: unit.serialLast4 || "", colour: unit.colour || "", cost: rupees(unit.costPaise), price: rupees(unit.pricePaise), warrantyMonths: unit.warranty?.months || 0, soldAt: unit.soldAt || "", added: unit.createdAt };
      });
      return sendCsv(res, "inventory", csv(rows, ["unit", "listing", "title", "status", "condition", "imeiLast4", "serialLast4", "colour", "cost", "price", "warrantyMonths", "soldAt", "added"]));
    }
    if (type === "movements") {
      const rows = await InventoryMovement.find({ businessId: id, createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
      const units = await InventoryUnit.find({ _id: { $in: rows.map((row) => row.unitId) } }).select("code").lean();
      return sendCsv(res, "stock-history", csv(rows.map((row) => ({ at: row.createdAt, unit: units.find((unit) => String(unit._id) === String(row.unitId))?.code || "", from: row.from || "", to: row.to, reason: row.reason })), ["at", "unit", "from", "to", "reason"]));
    }
    const rows = await ReturnRequest.find({ businessId: id, createdAt: { $gte: since } }).sort({ createdAt: -1 }).lean();
    return sendCsv(res, "returns", csv(rows.map((row) => ({ number: row.number, createdAt: row.createdAt, reason: row.reason, status: row.status, amount: rupees(row.amountPaise), unitCondition: row.unitCondition || "" })), ["number", "createdAt", "reason", "status", "amount", "unitCondition"]));
  }),
);

/** ================= Subscription ================= */

seller.get(
  "/subscription",
  asyncHandler(async (req, res) => {
    const id = String(bizId(req));
    const [entitlements, subscription, plans, activeListings, photosMax] = await Promise.all([
      getEntitlements({ businessId: id }),
      Subscription.findOne({ subjectType: "business", subjectId: id }).sort({ createdAt: -1 }).lean(),
      SubscriptionPlan.find({ audience: "business", active: true }).sort({ monthlyPricePaise: 1 }).lean(),
      Product.countDocuments({ businessId: id, deletedAt: null, status: { $in: ["draft", "pending_review", "active", "reserved"] } }),
      Promise.resolve(0),
    ]);
    void photosMax;
    const { kolkataMonthRange } = await import("../common/time");
    const { start, end } = kolkataMonthRange();
    const monthlyListings = await Product.countDocuments({ businessId: id, deletedAt: null, createdAt: { $gte: start, $lt: end } });
    const plan = subscription ? plans.find((row) => String(row._id) === String(subscription.planId)) || (await SubscriptionPlan.findById(subscription.planId).lean()) : null;
    sendData(res, {
      entitlements,
      subscription: subscription ? { status: subscription.status, interval: subscription.interval, currentPeriodEnd: subscription.currentPeriodEnd || null, graceUntil: subscription.graceUntil || null, plan: plan ? { code: plan.code, name: plan.name } : null } : null,
      usage: { activeListings, monthlyListings },
      plans: plans.map((row) => ({ code: row.code, name: row.name, monthlyPricePaise: row.monthlyPricePaise, annualPricePaise: row.annualPricePaise, limits: row.limits, features: row.features })),
    });
  }),
);

/** ================= Business profile & settings ================= */

seller.patch(
  "/profile",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        description: z.string().trim().max(4000).optional(),
        tagline: z.string().trim().max(120).optional(),
        hours: z.string().trim().max(200).optional(),
        phone: z.string().trim().min(8).max(20).optional(),
        email: z.string().trim().email().optional(),
        logoKey: z.string().max(300).nullable().optional(),
        bannerKey: z.string().max(300).nullable().optional(),
        social: z.object({ website: z.string().max(200), instagram: z.string().max(200), facebook: z.string().max(200), youtube: z.string().max(200), x: z.string().max(200), whatsapp: z.string().max(20) }).partial().optional(),
        profile: z.object({ categories: z.array(z.string().max(40)).max(10), brands: z.array(z.string().max(40)).max(40), conditions: z.array(z.enum(["new", "used", "refurbished"])).max(3), physicalShowroom: z.boolean() }).partial().optional(),
        policies: z.object({ warranty: z.string().max(2000), returns: z.string().max(2000), delivery: z.string().max(2000), returnWindowDays: z.number().int().min(0).max(30) }).partial().optional(),
        owner: z.object({ mobile: z.string().trim().min(8).max(20), alternatePhone: z.string().trim().max(20) }).partial().optional(),
      })
      .parse(req.body);
    const business = biz(req);
    for (const key of [body.logoKey, body.bannerKey]) if (key) assertOwnPublicKey(key, String(req.user!._id), ["business_logo", "business_banner"]);
    for (const key of ["description", "tagline", "hours", "phone", "email"] as const) if (body[key] !== undefined) business.set(key, body[key]);
    if (body.logoKey !== undefined) business.logoKey = body.logoKey || undefined;
    if (body.bannerKey !== undefined) business.bannerKey = body.bannerKey || undefined;
    for (const group of ["social", "profile", "policies", "owner"] as const) {
      const value = body[group];
      if (value) for (const [key, entry] of Object.entries(value)) business.set(`${group}.${key}`, entry);
    }
    await business.save();
    await audit(req, "showroom.profile_updated", "Business", String(business._id), { fields: Object.keys(body) });
    sendData(res, presentShowroom(business));
  }),
);

/** Address and map location affect buyers' trust and delivery, so they are re-verified like legal details. */
seller.post(
  "/profile/changes",
  asyncHandler(async (req, res) => sendData(res, presentShowroom(await requestSensitiveChange(req, biz(req), req.body)))),
);

seller.patch(
  "/settings",
  asyncHandler(async (req, res) => {
    const body = z
      .object({ lowStockThreshold: z.number().int().min(0).max(1000), autoAcceptOrders: z.boolean(), deliveryAvailable: z.boolean(), pickupAvailable: z.boolean() })
      .partial()
      .parse(req.body);
    const business = biz(req);
    for (const [key, value] of Object.entries(body)) business.set(`settings.${key}`, value);
    if (business.settings?.deliveryAvailable === false && business.settings?.pickupAvailable === false) throw new AppError(400, "NO_FULFILMENT", "Keep delivery or pickup switched on.");
    await business.save();
    await audit(req, "showroom.settings_updated", "Business", String(business._id), body);
    sendData(res, presentShowroom(business));
  }),
);

/** ================= Buyer-side endpoints that the showroom flows depend on ================= */

const buyer = Router();
// Path-scoped so unrelated requests are not authenticated twice.
buyer.use(["/me/orders/:orderId/suborders", "/orders/:id/returns", "/me/returns", "/me/warranty", "/me/warranty-claims", "/me/notifications/unread-count", "/me/notifications/read-all", "/me/notifications/:id/read"], requireUser);

buyer.get(
  "/me/orders/:orderId/suborders/:subId/handover-code",
  asyncHandler(async (req, res) => sendData(res, await buyerHandoverCode(String(req.user!._id), req.params.orderId, req.params.subId))),
);

buyer.post(
  "/me/orders/:orderId/suborders/:subId/confirm-receipt",
  asyncHandler(async (req, res) => {
    await buyerConfirmReceipt(String(req.user!._id), req.params.orderId, req.params.subId);
    sendData(res, { delivered: true });
  }),
);

buyer.post(
  "/orders/:id/returns",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        subOrderId: objectId,
        itemId: objectId.optional(),
        reason: z.enum(["damaged", "not_as_described", "defective", "wrong_item", "changed_mind", "other"]),
        details: z.string().trim().max(2000).optional(),
        imageKeys: z.array(z.string().max(300)).max(6).optional(),
      })
      .parse(req.body);
    sendData(res, await createReturn(String(req.user!._id), req.params.id, body), undefined, 201);
  }),
);

buyer.get(
  "/me/returns",
  asyncHandler(async (req, res) => {
    const rows = await ReturnRequest.find({ buyerId: req.user!._id }).sort({ createdAt: -1 }).limit(100).lean();
    sendData(res, rows.map((row) => ({ id: String(row._id), number: row.number, orderId: String(row.orderId), subOrderId: String(row.subOrderId), reason: row.reason, status: row.status, sellerNote: row.sellerNote || null, amountPaise: row.amountPaise, createdAt: row.createdAt })));
  }),
);

buyer.post(
  "/me/returns/:id/escalate",
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().trim().min(10).max(1000) }).parse(req.body);
    sendData(res, await escalateReturn(String(req.user!._id), req.params.id, body.reason));
  }),
);

buyer.get(
  "/me/warranty",
  asyncHandler(async (req, res) => {
    const units = await InventoryUnit.find({ buyerId: req.user!._id, status: { $in: ["SOLD"] } }).lean();
    const products = await Product.find({ _id: { $in: units.map((unit) => unit.productId) } }).select("title slug").lean();
    sendData(
      res,
      units.map((unit) => {
        const product = products.find((item) => String(item._id) === String(unit.productId));
        return {
          unitId: String(unit._id),
          unitCode: unit.code,
          orderId: unit.soldOrderId ? String(unit.soldOrderId) : null,
          title: product?.title || "Device",
          warranty: { months: unit.warranty?.months || 0, provider: unit.warranty?.provider || "none", terms: unit.warranty?.terms || null, startsAt: unit.warranty?.startsAt || null, endsAt: unit.warranty?.endsAt || null },
          active: Boolean(unit.warranty?.endsAt && unit.warranty.endsAt > new Date()),
          claims: unit.warrantyClaims.map((claim) => ({ id: String(claim._id), issue: claim.issue, status: claim.status, sellerNote: claim.sellerNote || null, createdAt: claim.createdAt })),
        };
      }),
    );
  }),
);

buyer.post(
  "/me/warranty-claims",
  asyncHandler(async (req, res) => {
    const body = z.object({ unitId: objectId, issue: z.string().trim().min(10).max(2000), imageKeys: z.array(z.string().max(300)).max(6).default([]) }).parse(req.body);
    const unit = await InventoryUnit.findOne({ _id: body.unitId, buyerId: req.user!._id, status: "SOLD" });
    if (!unit) throw notFound("Device not found.");
    if (!unit.warranty?.endsAt || unit.warranty.endsAt < new Date()) throw new AppError(409, "WARRANTY_EXPIRED", "This device has no active warranty.");
    if (unit.warrantyClaims.some((claim) => ["open", "accepted", "in_repair"].includes(claim.status))) throw new AppError(409, "CLAIM_OPEN", "A claim for this device is already open.");
    for (const key of body.imageKeys) if (key.includes("..") || !key.startsWith(`public/chat_image/${String(req.user!._id)}/`)) throw new AppError(400, "INVALID_IMAGE", "Upload the photos again.");
    unit.warrantyClaims.push({ buyerId: req.user!._id as never, issue: body.issue, imageKeys: body.imageKeys, status: "open" } as never);
    await unit.save();
    const business = await (await import("../models/profiles.model")).Business.findById(unit.businessId).select("ownerId").lean();
    if (business) await notify({ userId: String(business.ownerId), event: "warranty.claim", title: "Warranty claim", body: `A buyer raised a claim on ${unit.code}.`, data: { unitId: String(unit._id) } });
    sendData(res, { claimed: true }, undefined, 201);
  }),
);

/** ================= Notifications (every signed-in user) ================= */

buyer.get(
  "/me/notifications/unread-count",
  asyncHandler(async (req, res) => sendData(res, { count: await Notification.countDocuments({ userId: req.user!._id, readAt: null }) })),
);

buyer.post(
  "/me/notifications/read-all",
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ userId: req.user!._id, readAt: null }, { readAt: new Date() });
    sendData(res, { read: true });
  }),
);

buyer.post(
  "/me/notifications/:id/read",
  asyncHandler(async (req, res) => {
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    await Notification.updateOne({ _id: req.params.id, userId: req.user!._id }, { readAt: new Date() });
    sendData(res, { read: true });
  }),
);

showroom.use("/showroom", seller);
showroom.use(buyer);
