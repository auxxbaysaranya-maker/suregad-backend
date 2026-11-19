import crypto from "crypto";
import type { Request } from "express";
import { Types } from "mongoose";
import { DELIVERY_STATUSES, Order, Payment, Refund } from "../models/commerce.model";
import { Business } from "../models/profiles.model";
import { Product } from "../models/catalog.model";
import { InventoryUnit, ReturnRequest, nextCode } from "../models/showroom.model";
import { Dispute, PlatformSetting } from "../models/engagement.model";
import { User } from "../models/user.model";
import { AppError, forbidden, notFound } from "../common/errors";
import { decryptSecret, encryptSecret } from "../common/crypto";
import { notify } from "./notification.service";
import { audit } from "./audit.service";
import { restockSoldUnit } from "./inventory.service";

type OrderDoc = InstanceType<typeof Order>;
type SubOrder = OrderDoc["subOrders"][number];
type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Seller-driven sub-order transitions. Legacy "confirmed"/"shipped" behave like accepted/dispatched. */
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  paid: ["accepted", "rejected"],
  accepted: ["processing", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["ready_for_dispatch", "cancelled"],
  ready_for_dispatch: ["dispatched", "cancelled"],
  dispatched: [],
  shipped: [],
  delivered: [],
};

/** Delivery steps. DELIVERED needs proof and goes through completeDelivery. */
export const DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  REQUESTED: ["PREPARING"],
  PREPARING: ["READY_FOR_PICKUP"],
  READY_FOR_PICKUP: ["PICKED_UP"],
  PICKED_UP: ["IN_TRANSIT", "FAILED"],
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "FAILED"],
  OUT_FOR_DELIVERY: ["FAILED"],
  FAILED: ["OUT_FOR_DELIVERY", "RETURNED"],
  DELIVERED: [],
  RETURNED: [],
};

const DELIVERY_TO_ORDER: Partial<Record<DeliveryStatus, string>> = {
  PREPARING: "processing",
  READY_FOR_PICKUP: "ready_for_dispatch",
  PICKED_UP: "dispatched",
  IN_TRANSIT: "dispatched",
  OUT_FOR_DELIVERY: "dispatched",
  DELIVERED: "delivered",
  RETURNED: "returned",
};

const label = (value: string) => value.toLowerCase().replace(/_/g, " ");

/** Loads an order and the caller's sub-order. The seller is always the signed-in user. */
export async function loadSellerSubOrder(req: Request, orderId: string, subId: string) {
  if (!Types.ObjectId.isValid(orderId) || !Types.ObjectId.isValid(subId)) throw notFound("Order not found.");
  const filter: Record<string, unknown> = { _id: orderId, subOrders: { $elemMatch: { _id: subId, sellerUserId: req.user!._id } } };
  if (req.showroom) (filter.subOrders as Record<string, Record<string, unknown>>).$elemMatch.businessId = req.showroom._id;
  const order = await Order.findOne(filter);
  if (!order) throw notFound("Order not found.");
  const sub = order.subOrders.id(subId);
  if (!sub) throw notFound("Order not found.");
  return { order, sub };
}

function rollUp(order: OrderDoc) {
  const statuses = new Set(order.subOrders.map((sub) => sub.status));
  if (statuses.size === 1) order.status = [...statuses][0] as never;
}

/** Called once payment is captured: open delivery tracking and auto-accept when the showroom asks for it. */
export async function onOrderPaid(orderId: string) {
  const order = await Order.findById(orderId);
  if (!order) return;
  let changed = false;
  for (const sub of order.subOrders) {
    if (sub.status !== "paid") continue;
    sub.timeline.push({ status: "paid", note: "Payment received", at: new Date() });
    if (sub.fulfillment === "delivery" && !sub.delivery?.status) {
      sub.delivery = { status: "REQUESTED", method: "self", events: [{ status: "REQUESTED", note: "Buyer paid for delivery", at: new Date() }] } as never;
    }
    if (sub.businessId) {
      const business = await Business.findById(sub.businessId).select("settings");
      if (business?.settings?.autoAcceptOrders) {
        sub.status = "accepted";
        sub.timeline.push({ status: "accepted", note: "Accepted automatically", at: new Date() });
      }
    }
    changed = true;
  }
  if (changed) {
    rollUp(order);
    await order.save();
  }
}

/** Ask SureGad to refund one seller's part of an order. The refund itself is processed by an admin through the gateway. */
async function requestSubOrderRefund(order: OrderDoc, sub: SubOrder, reason: string, returnId?: unknown) {
  const payment = await Payment.findById(order.paymentId);
  if (!payment || payment.status !== "captured") return null;
  const existing = await Refund.findOne({ orderId: order._id, subOrderId: sub._id, status: { $in: ["requested", "approved", "processed"] } });
  if (existing) return existing;
  return Refund.create({
    paymentId: payment._id,
    orderId: order._id,
    subOrderId: sub._id,
    returnId,
    userId: order.buyerId,
    amountPaise: Math.min(Number(sub.amountPaise || 0), payment.amountPaise),
    reason,
    status: "requested",
  });
}

async function restockSubOrderItems(sub: SubOrder, reason: string, actorId: unknown) {
  for (const item of sub.items) {
    if (item.unitId) {
      await restockSoldUnit(item.unitId, "AVAILABLE", reason, actorId as never).catch(() => null);
    } else {
      await Product.updateOne(
        { _id: item.productId, stockTracked: { $ne: true }, "inventory.state": "sold" },
        { $set: { status: "active", "inventory.state": "available" }, $unset: { "inventory.reservedOrderId": 1 } },
      );
    }
  }
}

export async function changeSubOrderStatus(req: Request, orderId: string, subId: string, to: string, note?: string) {
  const { order, sub } = await loadSellerSubOrder(req, orderId, subId);
  const allowed = ORDER_TRANSITIONS[sub.status] || [];
  if (!allowed.includes(to)) {
    throw new AppError(409, "INVALID_TRANSITION", `An order that is ${label(sub.status)} can't be marked ${label(to)}.`, { allowed });
  }
  if ((to === "rejected" || to === "cancelled") && !note?.trim()) throw new AppError(400, "REASON_REQUIRED", "Tell the buyer why.");
  if (to === "dispatched" && sub.fulfillment === "pickup") throw new AppError(400, "PICKUP_ORDER", "This is a pickup order. Hand it over with the buyer's code.");
  sub.status = to as never;
  if (to === "rejected" || to === "cancelled") sub.rejectReason = note;
  sub.timeline.push({ status: to, note, by: req.user!._id as never, at: new Date() });
  if (sub.delivery?.status) {
    const deliveryStep: Partial<Record<string, DeliveryStatus>> = { processing: "PREPARING", ready_for_dispatch: "READY_FOR_PICKUP", dispatched: "PICKED_UP" };
    const step = deliveryStep[to];
    if (step && sub.delivery.status !== step) {
      sub.delivery.status = step;
      sub.delivery.events.push({ status: step, note, by: req.user!._id as never, at: new Date() });
    }
  }
  if (to === "ready_for_dispatch" && sub.fulfillment === "pickup") issueOtp(sub);
  rollUp(order);
  await order.save();
  if (to === "rejected" || to === "cancelled") {
    await restockSubOrderItems(sub, `order_${to}`, req.user!._id);
    await requestSubOrderRefund(order, sub, `Seller ${to} the order: ${note}`);
  }
  await audit(req, `order.${to}`, "Order", String(order._id), { subOrderId: subId, note });
  await notify({
    userId: String(order.buyerId),
    event: `order.${to}`,
    title: `Order ${label(to)}`,
    body:
      to === "rejected" || to === "cancelled"
        ? `The seller ${to} order ${order.number}: ${note}. Your refund has been requested.`
        : to === "ready_for_dispatch" && sub.fulfillment === "pickup"
          ? `Order ${order.number} is ready for pickup. Show your handover code from My orders.`
          : `Order ${order.number} is ${label(to)}.`,
    data: { orderId: String(order._id) },
  });
  return order;
}

function issueOtp(sub: SubOrder) {
  const code = String(crypto.randomInt(100000, 1000000));
  if (!sub.delivery) sub.delivery = { status: "READY_FOR_PICKUP", method: "pickup", events: [] } as never;
  sub.delivery!.otpHash = encryptSecret(code);
  sub.delivery!.otpIssuedAt = new Date();
}

export async function updateDeliveryDetails(
  req: Request,
  orderId: string,
  subId: string,
  input: { method?: "self" | "courier" | "pickup"; courier?: string; trackingNumber?: string; trackingUrl?: string; expectedAt?: string },
) {
  const { order, sub } = await loadSellerSubOrder(req, orderId, subId);
  if (sub.fulfillment !== "delivery") throw new AppError(400, "PICKUP_ORDER", "This order is collected from the showroom.");
  if (["delivered", "rejected", "cancelled", "refunded", "returned"].includes(sub.status)) throw new AppError(409, "ORDER_CLOSED", "This order is closed.");
  if (!sub.delivery?.status) sub.delivery = { status: "REQUESTED", method: "self", events: [] } as never;
  const delivery = sub.delivery!;
  if (input.method) delivery.method = input.method;
  if (input.courier !== undefined) delivery.courier = input.courier;
  if (input.trackingNumber !== undefined) delivery.trackingNumber = input.trackingNumber;
  if (input.trackingUrl !== undefined) {
    if (input.trackingUrl && !/^https:\/\//i.test(input.trackingUrl)) throw new AppError(400, "INVALID_URL", "Tracking links must start with https://");
    delivery.trackingUrl = input.trackingUrl;
  }
  if (input.expectedAt !== undefined) delivery.expectedAt = input.expectedAt ? new Date(input.expectedAt) : undefined;
  await order.save();
  if (delivery.trackingNumber) {
    await notify({
      userId: String(order.buyerId),
      event: "delivery.updated",
      title: "Delivery details added",
      body: `${delivery.courier || "Courier"} tracking ${delivery.trackingNumber} for order ${order.number}.`,
      data: { orderId: String(order._id) },
    });
  }
  return order;
}

export async function changeDeliveryStatus(req: Request, orderId: string, subId: string, to: DeliveryStatus, note?: string) {
  const { order, sub } = await loadSellerSubOrder(req, orderId, subId);
  if (!sub.delivery?.status) throw new AppError(409, "NO_DELIVERY", "This order has no delivery to update.");
  if (["paid", "rejected", "cancelled", "refunded"].includes(sub.status)) throw new AppError(409, "ACCEPT_FIRST", "Accept the order before starting delivery.");
  const allowed = DELIVERY_TRANSITIONS[sub.delivery.status as DeliveryStatus] || [];
  if (!allowed.includes(to)) {
    throw new AppError(409, "INVALID_TRANSITION", `Delivery can't move from ${label(sub.delivery.status)} to ${label(to)}.`, { allowed });
  }
  if ((to === "FAILED" || to === "RETURNED") && !note?.trim()) throw new AppError(400, "REASON_REQUIRED", "Add a note explaining what happened.");
  if (["PICKED_UP", "IN_TRANSIT"].includes(to) && sub.delivery.method === "courier" && !sub.delivery.trackingNumber) {
    throw new AppError(400, "TRACKING_REQUIRED", "Add the courier and tracking number first.");
  }
  sub.delivery.status = to;
  sub.delivery.events.push({ status: to, note, by: req.user!._id as never, at: new Date() });
  if (to === "OUT_FOR_DELIVERY") issueOtp(sub);
  const orderStatus = DELIVERY_TO_ORDER[to];
  if (orderStatus && orderStatus !== sub.status) {
    sub.status = orderStatus as never;
    sub.timeline.push({ status: orderStatus, note: `Delivery: ${label(to)}`, by: req.user!._id as never, at: new Date() });
  }
  rollUp(order);
  await order.save();
  if (to === "RETURNED") {
    for (const item of sub.items) if (item.unitId) await restockSoldUnit(item.unitId, "RETURNED", "delivery_returned", req.user!._id as never).catch(() => null);
    await requestSubOrderRefund(order, sub, `Delivery returned to seller: ${note}`);
  }
  await notify({
    userId: String(order.buyerId),
    event: `delivery.${to.toLowerCase()}`,
    title: `Delivery ${label(to)}`,
    body:
      to === "OUT_FOR_DELIVERY"
        ? `Order ${order.number} is out for delivery. Share the handover code from My orders only when you receive it.`
        : `Order ${order.number}: ${label(to)}${note ? ` — ${note}` : ""}.`,
    data: { orderId: String(order._id) },
  });
  return order;
}

export async function addDeliveryDocument(req: Request, orderId: string, subId: string, input: { key: string; name: string }) {
  const { order, sub } = await loadSellerSubOrder(req, orderId, subId);
  if (!sub.delivery?.status) throw new AppError(409, "NO_DELIVERY", "This order has no delivery.");
  sub.delivery.documents.push({ key: input.key, name: input.name, at: new Date() });
  await order.save();
  return order;
}

/** Proof of delivery: the buyer's one-time code, or a photo when the buyer can't share it. */
export async function completeHandover(req: Request, orderId: string, subId: string, input: { otp?: string; photoKey?: string; note?: string }) {
  const { order, sub } = await loadSellerSubOrder(req, orderId, subId);
  const ready = sub.fulfillment === "pickup" ? sub.status === "ready_for_dispatch" : sub.delivery?.status === "OUT_FOR_DELIVERY";
  if (!ready) {
    throw new AppError(409, "NOT_READY", sub.fulfillment === "pickup" ? "Mark the order ready for pickup first." : "Mark the delivery out for delivery first.");
  }
  let proof: { kind: "otp" | "photo"; key?: string; note?: string; at: Date };
  if (input.otp) {
    const expected = sub.delivery?.otpHash ? decryptSecret(sub.delivery.otpHash) : "";
    const left = Buffer.from(input.otp.trim());
    const right = Buffer.from(expected);
    if (!expected || left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new AppError(400, "WRONG_CODE", "That handover code is not correct.");
    proof = { kind: "otp", note: input.note, at: new Date() };
  } else if (input.photoKey) {
    if (!input.note?.trim()) throw new AppError(400, "NOTE_REQUIRED", "Explain why the buyer's code wasn't used.");
    proof = { kind: "photo", key: input.photoKey, note: input.note, at: new Date() };
  } else {
    throw new AppError(400, "PROOF_REQUIRED", "Enter the buyer's handover code or attach a delivery photo.");
  }
  markDelivered(sub, proof, req.user!._id);
  rollUp(order);
  await order.save();
  await audit(req, "order.delivered", "Order", String(order._id), { subOrderId: subId, proof: proof.kind });
  await notify({
    userId: String(order.buyerId),
    event: "order.delivered",
    title: "Order delivered",
    body: `Order ${order.number} was handed over. You can request a return from My orders within the return window.`,
    data: { orderId: String(order._id) },
  });
  return order;
}

function markDelivered(sub: SubOrder, proof: { kind: "otp" | "photo"; key?: string; note?: string; at: Date } | null, actorId: unknown) {
  if (!sub.delivery) sub.delivery = { status: "DELIVERED", method: sub.fulfillment === "pickup" ? "pickup" : "self", events: [] } as never;
  sub.delivery!.status = "DELIVERED";
  sub.delivery!.otpHash = undefined;
  if (proof) sub.delivery!.proof = proof as never;
  sub.delivery!.events.push({ status: "DELIVERED", note: proof ? `Proof: ${proof.kind}` : "Buyer confirmed receipt", by: actorId as never, at: new Date() });
  sub.status = "delivered";
  sub.deliveredAt = new Date();
  sub.timeline.push({ status: "delivered", note: proof ? `Handed over (${proof.kind})` : "Buyer confirmed receipt", by: actorId as never, at: new Date() });
}

/** Buyer view of the handover code while an order is out for delivery or ready for pickup. */
export async function buyerHandoverCode(userId: string, orderId: string, subId: string) {
  const order = await Order.findOne({ _id: orderId, buyerId: userId });
  const sub = order?.subOrders.id(subId);
  if (!order || !sub) throw notFound("Order not found.");
  if (!sub.delivery?.otpHash) throw new AppError(409, "NO_CODE", "A handover code appears when your order is out for delivery or ready for pickup.");
  return { code: decryptSecret(sub.delivery.otpHash), issuedAt: sub.delivery.otpIssuedAt };
}

export async function buyerConfirmReceipt(userId: string, orderId: string, subId: string) {
  const order = await Order.findOne({ _id: orderId, buyerId: userId });
  const sub = order?.subOrders.id(subId);
  if (!order || !sub) throw notFound("Order not found.");
  if (!["dispatched", "shipped", "ready_for_dispatch"].includes(sub.status)) throw new AppError(409, "NOT_DISPATCHED", "You can confirm once the order is on its way.");
  markDelivered(sub, null, userId);
  rollUp(order);
  await order.save();
  await notify({ userId: String(sub.sellerUserId), event: "order.delivered", title: "Buyer confirmed delivery", body: `Order ${order.number} was received by the buyer.`, data: { orderId: String(order._id) } });
  return order;
}

/** ---------- Returns ---------- */

async function returnWindowDays(sub: SubOrder) {
  const productIds = sub.items.map((item) => item.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select("returnWindowDays").lean();
  const listingDays = Math.max(0, ...products.map((product) => product.returnWindowDays || 0));
  if (listingDays > 0) return listingDays;
  if (sub.businessId) {
    const business = await Business.findById(sub.businessId).select("policies").lean();
    if (business?.policies?.returnWindowDays) return business.policies.returnWindowDays;
  }
  const settings = await PlatformSetting.findOne({ key: "platform" }).lean();
  return Number((settings?.value as { refundWindowDays?: number } | undefined)?.refundWindowDays ?? 7);
}

export async function createReturn(
  userId: string,
  orderId: string,
  input: { subOrderId: string; itemId?: string; reason: "damaged" | "not_as_described" | "defective" | "wrong_item" | "changed_mind" | "other"; details?: string; imageKeys?: string[] },
) {
  if (!Types.ObjectId.isValid(orderId) || !Types.ObjectId.isValid(input.subOrderId)) throw notFound("Order not found.");
  const order = await Order.findOne({ _id: orderId, buyerId: userId });
  const sub = order?.subOrders.id(input.subOrderId);
  if (!order || !sub) throw notFound("Order not found.");
  if (sub.status !== "delivered" || !sub.deliveredAt) throw new AppError(409, "NOT_DELIVERED", "Returns open after the order is delivered.");
  const days = await returnWindowDays(sub);
  if (Date.now() - sub.deliveredAt.getTime() > days * 24 * 60 * 60 * 1000) {
    throw new AppError(409, "RETURN_WINDOW_CLOSED", `The ${days}-day return window for this order has closed.`);
  }
  const open = await ReturnRequest.findOne({ orderId, subOrderId: sub._id, status: { $nin: ["rejected", "closed"] } });
  if (open) throw new AppError(409, "RETURN_EXISTS", `Return ${open.number} is already open for this order.`);
  for (const key of input.imageKeys || []) {
    if (key.includes("..") || !key.startsWith(`public/chat_image/${userId}/`)) throw new AppError(400, "INVALID_IMAGE", "Upload the photos again.");
  }
  const item = input.itemId ? sub.items.id(input.itemId) : sub.items[0];
  if (!item) throw notFound("Item not found.");
  const ret = await ReturnRequest.create({
    number: await nextCode("RET"),
    orderId,
    subOrderId: sub._id,
    businessId: sub.businessId,
    sellerUserId: sub.sellerUserId,
    buyerId: userId,
    productId: item.productId,
    unitId: item.unitId,
    reason: input.reason,
    details: input.details || "",
    imageKeys: input.imageKeys || [],
    amountPaise: item.pricePaise || sub.amountPaise || 0,
    timeline: [{ status: "requested", note: input.details, by: userId, at: new Date() }],
  });
  await notify({
    userId: String(sub.sellerUserId),
    event: "return.requested",
    title: "Return requested",
    body: `Order ${order.number}: ${input.reason.replace(/_/g, " ")}. Review it in Returns.`,
    data: { returnId: String(ret._id), orderId },
  });
  return ret;
}

/** Seller-side return steps. Refunds are requested here and paid out by SureGad through the gateway. */
export const RETURN_TRANSITIONS: Record<string, string[]> = {
  requested: ["approved", "rejected"],
  approved: ["pickup_scheduled", "received"],
  pickup_scheduled: ["received"],
  received: ["refund_requested"],
};

export async function sellerReturnAction(
  req: Request,
  returnId: string,
  input: { to: string; note?: string; unitCondition?: "resellable" | "damaged" | "repair" },
) {
  if (!Types.ObjectId.isValid(returnId)) throw notFound("Return not found.");
  const ret = await ReturnRequest.findOne({ _id: returnId, sellerUserId: req.user!._id, ...(req.showroom ? { businessId: req.showroom._id } : {}) });
  if (!ret) throw notFound("Return not found.");
  const allowed = RETURN_TRANSITIONS[ret.status] || [];
  if (!allowed.includes(input.to)) throw new AppError(409, "INVALID_TRANSITION", `A ${label(ret.status)} return can't be ${label(input.to)}.`, { allowed });
  if (input.to === "rejected" && !input.note?.trim()) throw new AppError(400, "REASON_REQUIRED", "Tell the buyer why the return is rejected.");
  if (input.to === "received" && !input.unitCondition) throw new AppError(400, "CONDITION_REQUIRED", "Record the condition the device came back in.");
  ret.status = input.to as never;
  ret.sellerNote = input.note || ret.sellerNote;
  ret.timeline.push({ status: input.to, note: input.note, by: req.user!._id as never, at: new Date() });
  if (input.to === "received") {
    ret.unitCondition = input.unitCondition;
    const order = await Order.findById(ret.orderId);
    const sub = order?.subOrders.id(ret.subOrderId);
    if (order && sub) {
      sub.status = "returned";
      sub.timeline.push({ status: "returned", note: `Return ${ret.number} received`, by: req.user!._id as never, at: new Date() });
      rollUp(order);
      await order.save();
    }
    if (ret.unitId) {
      const target = input.unitCondition === "resellable" ? "RETURNED" : input.unitCondition === "repair" ? "REPAIR" : "DAMAGED";
      await restockSoldUnit(ret.unitId, "RETURNED", `return_${ret.number}`, req.user!._id as never).catch(() => null);
      if (target !== "RETURNED") {
        const unit = await InventoryUnit.findById(ret.unitId);
        if (unit) {
          const { changeUnitStatus } = await import("./inventory.service");
          await changeUnitStatus({ unitId: unit._id, businessId: unit.businessId, from: ["RETURNED"], to: target, reason: `return_${ret.number}`, actorId: req.user!._id as never }).catch(() => null);
        }
      }
    }
  }
  if (input.to === "refund_requested") {
    const order = await Order.findById(ret.orderId);
    const sub = order?.subOrders.id(ret.subOrderId);
    if (!order || !sub) throw notFound("Order not found.");
    const payment = await Payment.findById(order.paymentId);
    if (!payment || payment.status !== "captured") throw new AppError(409, "PAYMENT_NOT_CAPTURED", "This order has no captured payment to refund.");
    const refund = await Refund.create({
      paymentId: payment._id,
      orderId: order._id,
      subOrderId: sub._id,
      returnId: ret._id,
      userId: ret.buyerId,
      amountPaise: Math.min(ret.amountPaise, payment.amountPaise),
      reason: `Return ${ret.number}`,
      status: "requested",
    });
    ret.refundId = refund._id;
  }
  await ret.save();
  await audit(req, `return.${input.to}`, "ReturnRequest", String(ret._id), { note: input.note });
  await notify({
    userId: String(ret.buyerId),
    event: `return.${input.to}`,
    title: `Return ${label(input.to)}`,
    body: `Return ${ret.number}: ${label(input.to)}${input.note ? ` — ${input.note}` : ""}.`,
    data: { returnId: String(ret._id) },
  });
  return ret;
}

/** Buyer escalates a rejected or stalled return to SureGad. */
export async function escalateReturn(userId: string, returnId: string, reason: string) {
  if (!Types.ObjectId.isValid(returnId)) throw notFound("Return not found.");
  const ret = await ReturnRequest.findOne({ _id: returnId, buyerId: userId });
  if (!ret) throw notFound("Return not found.");
  if (!["rejected", "requested", "approved", "pickup_scheduled", "received"].includes(ret.status)) {
    throw new AppError(409, "CANNOT_ESCALATE", "This return can't be escalated now.");
  }
  if (ret.status === "requested" && Date.now() - ret.createdAt.getTime() < 48 * 60 * 60 * 1000) {
    throw new AppError(409, "TOO_EARLY", "Give the seller 48 hours to respond before escalating.");
  }
  const dispute = await Dispute.create({ openedBy: userId, type: "return", referenceId: ret._id, reason, against: ret.sellerUserId, businessId: ret.businessId });
  ret.status = "escalated";
  ret.disputeId = dispute._id;
  ret.timeline.push({ status: "escalated", note: reason, by: userId as never, at: new Date() });
  await ret.save();
  await notify({ userId: String(ret.sellerUserId), event: "return.escalated", title: "Return escalated", body: `Return ${ret.number} was escalated to SureGad.`, data: { returnId: String(ret._id) } });
  const admins = await User.find({ roles: "super_admin", status: "active" }).select("_id");
  await Promise.all(admins.map((admin) => notify({ userId: String(admin._id), event: "dispute.opened", title: "Return dispute", body: `Return ${ret.number} needs a decision.`, data: { disputeId: String(dispute._id) } })));
  return ret;
}

export function presentSubOrder(order: Record<string, any>, sub: Record<string, any>, buyer?: Record<string, any> | null) {
  const delivery = sub.delivery?.status
    ? {
        status: sub.delivery.status,
        method: sub.delivery.method,
        courier: sub.delivery.courier || null,
        trackingNumber: sub.delivery.trackingNumber || null,
        trackingUrl: sub.delivery.trackingUrl || null,
        expectedAt: sub.delivery.expectedAt || null,
        documents: (sub.delivery.documents || []).map((doc: Record<string, any>) => ({ key: doc.key, name: doc.name, at: doc.at })),
        proof: sub.delivery.proof?.kind ? { kind: sub.delivery.proof.kind, note: sub.delivery.proof.note || null, at: sub.delivery.proof.at } : null,
        codeIssued: Boolean(sub.delivery.otpHash),
        events: sub.delivery.events || [],
      }
    : null;
  return {
    orderId: String(order._id),
    subOrderId: String(sub._id),
    number: order.number,
    createdAt: order.createdAt,
    status: sub.status,
    allowed: ORDER_TRANSITIONS[sub.status] || [],
    fulfillment: sub.fulfillment,
    amountPaise: sub.amountPaise,
    items: (sub.items || []).map((item: Record<string, any>) => ({
      id: String(item._id),
      productId: String(item.productId),
      title: item.title,
      pricePaise: item.pricePaise,
      unitId: item.unitId ? String(item.unitId) : null,
      unitCode: item.unitCode || null,
    })),
    buyer: buyer ? { id: String(buyer._id), name: buyer.displayName } : { id: String(order.buyerId), name: "Buyer" },
    address: sub.fulfillment === "delivery" && order.address
      ? { name: order.address.name, phone: order.address.phone, line1: order.address.line1, line2: order.address.line2, city: order.address.city, district: order.address.district, state: order.address.state, pincode: order.address.pincode }
      : null,
    rejectReason: sub.rejectReason || null,
    delivery,
    deliveryAllowed: delivery ? DELIVERY_TRANSITIONS[delivery.status as DeliveryStatus] || [] : [],
    timeline: sub.timeline || [],
    deliveredAt: sub.deliveredAt || null,
  };
}

export { forbidden };
