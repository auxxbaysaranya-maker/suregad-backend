import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { asyncHandler, sendData } from "../common/http";
import { AppError, notFound } from "../common/errors";
import { requireUser } from "../middleware/auth";
import { Business } from "../models/profiles.model";
import { Product } from "../models/catalog.model";
import { Order } from "../models/commerce.model";
import { Dispute, PlatformSetting, Review, SupportTicket } from "../models/engagement.model";
import { User } from "../models/user.model";
import { FeatureRequest, InventoryUnit, ReturnRequest, nextCode } from "../models/showroom.model";
import { addDays } from "../common/time";
import { audit } from "../services/audit.service";
import { notify } from "../services/notification.service";
import { REVIEW_ACTIONS, decideSensitiveChange, findOwnShowroom, presentShowroom, reviewShowroom, showroomStatus } from "../services/showroom.service";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mounted inside the admin router, so every route here already requires admin access. */
export const adminShowroom = Router();

adminShowroom.get(
  "/showrooms",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { deletedAt: null };
    const status = String(req.query.status || "");
    if (status === "submitted") filter.verificationStatus = { $in: ["submitted", "pending"] };
    else if (status === "changes") filter["pendingChanges.status"] = "pending";
    else if (status) filter.verificationStatus = status;
    const q = String(req.query.q || "").trim();
    if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), "i") }, { code: new RegExp(escapeRegex(q), "i") }, { gstin: q.toUpperCase() }, { email: new RegExp(escapeRegex(q), "i") }, { "address.city": new RegExp(escapeRegex(q), "i") }];
    const rows = await Business.find(filter).sort({ submittedAt: -1, createdAt: -1 }).limit(200).lean();
    const counts = await Business.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: "$verificationStatus", n: { $sum: 1 } } }]);
    const changes = await Business.countDocuments({ deletedAt: null, "pendingChanges.status": "pending" });
    const countMap: Record<string, number> = {};
    for (const row of counts as { _id: string; n: number }[]) {
      const key = row._id === "pending" ? "submitted" : row._id;
      countMap[key] = (countMap[key] || 0) + row.n;
    }
    sendData(res, {
      counts: { ...countMap, changes },
      items: rows.map((row) => ({
        id: String(row._id),
        code: row.code || null,
        name: row.name,
        status: showroomStatus(row),
        city: row.address?.city || null,
        gstin: row.gstin || null,
        owner: row.owner?.name || null,
        documents: (row.documents || []).length,
        pendingChange: row.pendingChanges?.status === "pending",
        submittedAt: row.submittedAt || null,
        createdAt: row.createdAt,
      })),
    });
  }),
);

adminShowroom.get(
  "/showrooms/:id",
  asyncHandler(async (req, res) => {
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const business = await Business.findById(req.params.id);
    if (!business) throw notFound("Showroom not found.");
    const [owner, listings, units, orders, returns, rating] = await Promise.all([
      User.findById(business.ownerId).select("displayName email status createdAt").lean(),
      Product.aggregate([{ $match: { businessId: business._id, deletedAt: null } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      InventoryUnit.countDocuments({ businessId: business._id, deletedAt: null }),
      Order.countDocuments({ "subOrders.businessId": business._id, status: { $ne: "pending_payment" } }),
      ReturnRequest.countDocuments({ businessId: business._id }),
      Review.aggregate([{ $match: { businessId: business._id, status: "published" } }, { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } }]),
    ]);
    const status = showroomStatus(business);
    sendData(res, {
      ...presentShowroom(business, true),
      ownerAccount: owner ? { id: String(owner._id), name: owner.displayName, email: owner.email, status: owner.status, since: owner.createdAt } : null,
      stats: { listings: Object.fromEntries((listings as { _id: string; n: number }[]).map((row) => [row._id, row.n])), units, orders, returns, rating: rating[0] ? { average: Math.round(rating[0].avg * 10) / 10, count: rating[0].n } : null },
      actions: Object.entries(REVIEW_ACTIONS).filter(([, rule]) => rule.from.includes(status as never)).map(([action, rule]) => ({ action, to: rule.to, needsNote: Boolean(rule.needsNote) })),
    });
  }),
);

adminShowroom.post(
  "/showrooms/:id/review",
  asyncHandler(async (req, res) => {
    const body = z.object({ action: z.enum(Object.keys(REVIEW_ACTIONS) as [string, ...string[]]), note: z.string().trim().max(2000).optional() }).parse(req.body);
    const business = await reviewShowroom(req, req.params.id, body.action, body.note);
    sendData(res, presentShowroom(business, true));
  }),
);

adminShowroom.patch(
  "/showrooms/:id/documents/:docId",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["approved", "rejected", "pending"]), note: z.string().trim().max(500).optional() }).parse(req.body);
    if (body.status === "rejected" && !body.note) throw new AppError(400, "NOTE_REQUIRED", "Say why the document was rejected.");
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const business = await Business.findById(req.params.id);
    const doc = business?.documents.id(req.params.docId);
    if (!business || !doc) throw notFound("Document not found.");
    doc.status = body.status;
    doc.note = body.note;
    await business.save();
    await audit(req, "showroom.document_reviewed", "Business", String(business._id), { docId: req.params.docId, status: body.status });
    sendData(res, presentShowroom(business, true));
  }),
);

adminShowroom.post(
  "/showrooms/:id/changes",
  asyncHandler(async (req, res) => {
    const body = z.object({ approve: z.boolean(), note: z.string().trim().max(1000).optional() }).parse(req.body);
    sendData(res, presentShowroom(await decideSensitiveChange(req, req.params.id, body.approve, body.note), true));
  }),
);

/** ---------- Featured listing requests ---------- */

adminShowroom.get(
  "/feature-requests",
  asyncHandler(async (req, res) => {
    const rows = await FeatureRequest.find(req.query.status ? { status: String(req.query.status) } : {}).sort({ createdAt: -1 }).limit(200).lean();
    const [products, businesses] = await Promise.all([
      Product.find({ _id: { $in: rows.map((row) => row.productId) } }).select("title slug featuredUntil").lean(),
      Business.find({ _id: { $in: rows.map((row) => row.businessId) } }).select("name code").lean(),
    ]);
    sendData(
      res,
      rows.map((row) => ({
        id: String(row._id),
        days: row.days,
        note: row.note,
        status: row.status,
        adminNote: row.adminNote || null,
        createdAt: row.createdAt,
        product: products.find((item) => String(item._id) === String(row.productId)) || null,
        showroom: businesses.find((item) => String(item._id) === String(row.businessId)) || null,
      })),
    );
  }),
);

adminShowroom.post(
  "/feature-requests/:id",
  asyncHandler(async (req, res) => {
    const body = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional() }).parse(req.body);
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const row = await FeatureRequest.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { status: body.approve ? "approved" : "rejected", adminNote: body.note, decidedAt: new Date() }, { new: true });
    if (!row) throw notFound("Request not found or already decided.");
    if (body.approve) {
      const product = await Product.findById(row.productId);
      if (product) {
        const from = product.featuredUntil && product.featuredUntil > new Date() ? product.featuredUntil : new Date();
        product.featuredUntil = addDays(from, row.days);
        await product.save();
      }
    }
    const business = await Business.findById(row.businessId).select("ownerId").lean();
    if (business) await notify({ userId: String(business.ownerId), event: "feature.decided", title: body.approve ? "Listing featured" : "Feature request declined", body: body.note || (body.approve ? `Your listing is featured for ${row.days} days.` : "Your feature request was declined.") });
    await audit(req, body.approve ? "feature.approved" : "feature.rejected", "FeatureRequest", String(row._id));
    sendData(res, row);
  }),
);

/** ---------- Returns & disputes overview ---------- */

adminShowroom.get(
  "/returns",
  asyncHandler(async (req, res) => {
    const rows = await ReturnRequest.find(req.query.status ? { status: String(req.query.status) } : {}).sort({ createdAt: -1 }).limit(200).lean();
    sendData(res, rows);
  }),
);

adminShowroom.post(
  "/returns/:id/resolve",
  asyncHandler(async (req, res) => {
    const body = z.object({ outcome: z.enum(["refund_buyer", "side_with_seller"]), note: z.string().trim().min(5).max(1000) }).parse(req.body);
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const ret = await ReturnRequest.findOne({ _id: req.params.id, status: "escalated" });
    if (!ret) throw notFound("Escalated return not found.");
    if (body.outcome === "refund_buyer") {
      const order = await Order.findById(ret.orderId);
      const { Payment, Refund } = await import("../models/commerce.model");
      const payment = order ? await Payment.findById(order.paymentId) : null;
      if (!payment || payment.status !== "captured") throw new AppError(409, "PAYMENT_NOT_CAPTURED", "No captured payment to refund.");
      const refund = await Refund.create({ paymentId: payment._id, orderId: ret.orderId, subOrderId: ret.subOrderId, returnId: ret._id, userId: ret.buyerId, amountPaise: Math.min(ret.amountPaise, payment.amountPaise), reason: `Dispute on return ${ret.number}`, status: "approved" });
      ret.refundId = refund._id;
      ret.status = "refund_requested";
    } else {
      ret.status = "closed";
    }
    ret.timeline.push({ status: ret.status, note: `SureGad decision: ${body.note}`, by: req.user!._id as never, at: new Date() });
    await ret.save();
    if (ret.disputeId) await Dispute.updateOne({ _id: ret.disputeId }, { status: "resolved", resolution: body.note });
    for (const userId of [ret.buyerId, ret.sellerUserId]) await notify({ userId: String(userId), event: "return.resolved", title: "Return dispute decided", body: body.note, data: { returnId: String(ret._id) } });
    await audit(req, "return.dispute_resolved", "ReturnRequest", String(ret._id), body);
    sendData(res, ret);
  }),
);

/** ---------- Commission & settlement settings ---------- */

adminShowroom.patch(
  "/settings/fees",
  asyncHandler(async (req, res) => {
    const body = z.object({ commissionPercent: z.number().min(0).max(50), gatewayFeePercent: z.number().min(0).max(10), settlementHoldDays: z.number().int().min(0).max(60) }).partial().parse(req.body);
    const current = await PlatformSetting.findOne({ key: "platform" });
    const value = { ...((current?.value || {}) as Record<string, unknown>), ...body };
    const saved = await PlatformSetting.findOneAndUpdate({ key: "platform" }, { value }, { upsert: true, new: true });
    await audit(req, "settings.fees_updated", "PlatformSetting", "platform", body);
    sendData(res, saved);
  }),
);

/** ---------- Support desk ---------- */

function presentTicket(ticket: Record<string, any>, users: Map<string, string>, staff: boolean) {
  return {
    id: String(ticket._id),
    number: ticket.number || null,
    subject: ticket.subject,
    body: ticket.body,
    category: ticket.category || "other",
    priority: ticket.priority || "normal",
    status: ticket.status,
    attachments: ticket.attachments || [],
    user: staff ? { id: String(ticket.userId), name: users.get(String(ticket.userId)) || "User" } : undefined,
    businessId: ticket.businessId ? String(ticket.businessId) : null,
    assignedTo: staff && ticket.assignedTo ? { id: String(ticket.assignedTo), name: users.get(String(ticket.assignedTo)) || "Admin" } : null,
    messages: (ticket.messages || []).map((message: Record<string, any>) => ({
      id: String(message._id),
      fromStaff: Boolean(message.fromStaff),
      author: message.fromStaff ? (staff ? users.get(String(message.authorId)) || "SureGad" : "SureGad support") : users.get(String(message.authorId)) || "You",
      body: message.body,
      attachments: message.attachments || [],
      at: message.at,
    })),
    lastActivityAt: ticket.lastActivityAt || ticket.updatedAt,
    createdAt: ticket.createdAt,
  };
}

async function namesFor(tickets: Record<string, any>[]) {
  const ids = new Set<string>();
  for (const ticket of tickets) {
    ids.add(String(ticket.userId));
    if (ticket.assignedTo) ids.add(String(ticket.assignedTo));
    for (const message of ticket.messages || []) ids.add(String(message.authorId));
  }
  const users = await User.find({ _id: { $in: [...ids].filter((id) => Types.ObjectId.isValid(id)) } }).select("displayName").lean();
  return new Map(users.map((user) => [String(user._id), user.displayName]));
}

adminShowroom.get(
  "/support",
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = {};
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.priority) filter.priority = String(req.query.priority);
    if (req.query.category) filter.category = String(req.query.category);
    if (req.query.showrooms === "true") filter.businessId = { $ne: null };
    const tickets = await SupportTicket.find(filter).sort({ lastActivityAt: -1, createdAt: -1 }).limit(300).lean();
    const users = await namesFor(tickets);
    sendData(res, tickets.map((ticket) => ({ ...presentTicket(ticket, users, true), messages: undefined, replies: (ticket.messages || []).length })));
  }),
);

adminShowroom.get(
  "/support/:id",
  asyncHandler(async (req, res) => {
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const ticket = await SupportTicket.findById(req.params.id).lean();
    if (!ticket) throw notFound("Ticket not found.");
    const users = await namesFor([ticket]);
    const business = ticket.businessId ? await Business.findById(ticket.businessId).select("name code verificationStatus").lean() : null;
    sendData(res, { ...presentTicket(ticket, users, true), showroom: business ? { id: String(business._id), name: business.name, code: business.code || null, status: showroomStatus(business) } : null });
  }),
);

adminShowroom.post(
  "/support/:id/reply",
  asyncHandler(async (req, res) => {
    const body = z.object({ body: z.string().trim().min(1).max(4000), status: z.enum(["open", "pending", "waiting_on_user", "resolved", "closed"]).optional() }).parse(req.body);
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) throw notFound("Ticket not found.");
    ticket.messages.push({ authorId: req.user!._id as never, fromStaff: true, body: body.body, at: new Date() } as never);
    ticket.status = body.status || "waiting_on_user";
    ticket.lastActivityAt = new Date();
    if (!ticket.assignedTo) ticket.assignedTo = req.user!._id as never;
    await ticket.save();
    await notify({ userId: String(ticket.userId), event: "support.replied", title: "SureGad support replied", body: `${ticket.number || "Your ticket"}: ${body.body.slice(0, 120)}`, data: { ticketId: String(ticket._id) } });
    sendData(res, presentTicket(ticket.toObject(), await namesFor([ticket.toObject()]), true));
  }),
);

adminShowroom.patch(
  "/support/:id",
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(["open", "pending", "waiting_on_user", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assignToMe: z.boolean().optional() }).parse(req.body);
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) throw notFound("Ticket not found.");
    if (body.status) ticket.status = body.status;
    if (body.priority) ticket.priority = body.priority;
    if (body.assignToMe) ticket.assignedTo = req.user!._id as never;
    ticket.lastActivityAt = new Date();
    await ticket.save();
    await audit(req, "support.updated", "SupportTicket", String(ticket._id), body);
    if (body.status === "resolved") await notify({ userId: String(ticket.userId), event: "support.resolved", title: "Ticket resolved", body: `${ticket.number || "Your ticket"} was marked resolved.`, data: { ticketId: String(ticket._id) } });
    sendData(res, presentTicket(ticket.toObject(), await namesFor([ticket.toObject()]), true));
  }),
);

/** ---------- Support for every signed-in user (sellers, partners, buyers) ---------- */

export const support = Router();
support.use(["/support"], requireUser);

const attachmentsSchema = z.array(z.object({ key: z.string().max(300), name: z.string().trim().min(1).max(120) })).max(5).default([]);

function assertOwnAttachments(userId: string, attachments: { key: string }[]) {
  for (const file of attachments) {
    const ok = !file.key.includes("..") && (file.key.startsWith(`private/business_document/${userId}/`) || file.key.startsWith(`public/chat_image/${userId}/`));
    if (!ok) throw new AppError(400, "INVALID_FILE", "Upload the attachment again.");
  }
}

support.post(
  "/support",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        subject: z.string().trim().min(3).max(160),
        body: z.string().trim().min(3).max(4000),
        category: z.enum(["account", "verification", "listings", "orders", "payments", "delivery", "returns", "inspections", "subscription", "technical", "other"]).default("other"),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
        attachments: attachmentsSchema,
      })
      .parse(req.body);
    assertOwnAttachments(String(req.user!._id), body.attachments);
    const business = await findOwnShowroom(req.user!._id);
    const ticket = await SupportTicket.create({ ...body, userId: req.user!._id, businessId: business?._id, number: await nextCode("TKT"), lastActivityAt: new Date() });
    const admins = await User.find({ roles: "super_admin", status: "active" }).select("_id");
    if (body.priority === "urgent" || body.priority === "high") {
      await Promise.all(admins.map((admin) => notify({ userId: String(admin._id), event: "support.created", title: `${body.priority === "urgent" ? "Urgent" : "High priority"} ticket`, body: `${ticket.number}: ${body.subject}`, data: { ticketId: String(ticket._id) } })));
    }
    sendData(res, presentTicket(ticket.toObject(), new Map(), false), undefined, 201);
  }),
);

support.get(
  "/support",
  asyncHandler(async (req, res) => {
    const tickets = await SupportTicket.find({ userId: req.user!._id }).sort({ lastActivityAt: -1, createdAt: -1 }).limit(100).lean();
    sendData(res, tickets.map((ticket) => ({ ...presentTicket(ticket, new Map(), false), messages: undefined, replies: (ticket.messages || []).length })));
  }),
);

async function ownTicket(userId: unknown, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound("Ticket not found.");
  const ticket = await SupportTicket.findOne({ _id: id, userId });
  if (!ticket) throw notFound("Ticket not found.");
  return ticket;
}

support.get(
  "/support/:id",
  asyncHandler(async (req, res) => {
    const ticket = await ownTicket(req.user!._id, req.params.id);
    sendData(res, presentTicket(ticket.toObject(), new Map([[String(req.user!._id), "You"]]), false));
  }),
);

support.post(
  "/support/:id/messages",
  asyncHandler(async (req, res) => {
    const body = z.object({ body: z.string().trim().min(1).max(4000), attachments: attachmentsSchema }).parse(req.body);
    assertOwnAttachments(String(req.user!._id), body.attachments);
    const ticket = await ownTicket(req.user!._id, req.params.id);
    if (ticket.status === "closed") throw new AppError(409, "TICKET_CLOSED", "This ticket is closed. Open a new one.");
    ticket.messages.push({ authorId: req.user!._id as never, fromStaff: false, body: body.body, attachments: body.attachments, at: new Date() } as never);
    ticket.status = "open";
    ticket.lastActivityAt = new Date();
    await ticket.save();
    if (ticket.assignedTo) await notify({ userId: String(ticket.assignedTo), event: "support.user_replied", title: "Ticket reply", body: `${ticket.number}: ${body.body.slice(0, 120)}`, data: { ticketId: String(ticket._id) } });
    sendData(res, presentTicket(ticket.toObject(), new Map([[String(req.user!._id), "You"]]), false));
  }),
);

support.post(
  "/support/:id/close",
  asyncHandler(async (req, res) => {
    const ticket = await ownTicket(req.user!._id, req.params.id);
    ticket.status = "closed";
    ticket.lastActivityAt = new Date();
    await ticket.save();
    sendData(res, presentTicket(ticket.toObject(), new Map([[String(req.user!._id), "You"]]), false));
  }),
);

/** Files attached to tickets: the author or an admin may open them. */
support.get(
  "/support/:id/files",
  asyncHandler(async (req, res) => {
    const key = String(req.query.key || "");
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound();
    const ticket = await SupportTicket.findById(req.params.id).lean();
    if (!ticket) throw notFound();
    const isAdmin = req.permissions?.has("*") || req.permissions?.has("admin.access");
    if (!isAdmin && String(ticket.userId) !== String(req.user!._id)) throw notFound();
    const all = [...(ticket.attachments || []), ...(ticket.messages || []).flatMap((message) => message.attachments || [])];
    if (!all.some((file) => file.key === key)) throw notFound("File not found.");
    const { signedDownload, readLocalUpload, mediaUrl } = await import("../integrations/storage");
    if (key.startsWith("public/")) return sendData(res, { url: mediaUrl(key) });
    const url = await signedDownload(key);
    if (url) return sendData(res, { url });
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(await readLocalUpload(key));
  }),
);
