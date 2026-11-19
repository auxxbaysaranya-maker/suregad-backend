import crypto from "crypto";
import mongoose from "mongoose";
import { Cart, Coupon, Order, Payment, Refund, Subscription, SubscriptionPlan } from "../models/commerce.model";
import { Product } from "../models/catalog.model";
import { InspectionPlan, InspectionRequest } from "../models/inspection.model";
import { BuyerProfile, Business } from "../models/profiles.model";
import { WebhookEvent } from "../models/commerce.model";
import { Offer } from "../models/engagement.model";
import { markOffersPurchased } from "./chat.service";
import { AppError, forbidden, notFound } from "../common/errors";
import { randomId } from "../common/crypto";
import { getPaymentProvider } from "../integrations/payments";
import { addDays } from "../common/time";
import { notify } from "./notification.service";
import { qualifyReferral } from "./growth.service";
import { allocatePartner } from "./inspection.service";
import { audit } from "./audit.service";
import { markOrderUnitsSold, releaseOrderUnits, reserveUnit } from "./inventory.service";
import { onOrderPaid } from "./showroom-orders.service";
import type { Request } from "express";

const RESERVATION_MINUTES = 15;

export async function getCart(userId: string) {
  const cart = await Cart.findOne({ userId }).lean();
  if (!cart) return { items: [], couponCode: null };
  const products = await Product.find({
    _id: { $in: cart.items.map((item) => item.productId) },
    deletedAt: null,
  }).lean();
  const byId = new Map(products.map((product) => [String(product._id), product]));
  return {
    couponCode: cart.couponCode,
    items: cart.items
      .map((item) => {
        const product = byId.get(String(item.productId));
        if (!product) return null;
        return {
          productId: String(product._id),
          title: product.title,
          pricePaise: product.pricePaise,
          status: product.status,
          available: product.status === "active" && product.inventory?.state === "available",
          sellerUserId: String(product.sellerUserId),
          city: product.city,
          image: product.images?.[0]?.url,
        };
      })
      .filter(Boolean),
  };
}

export async function addCartItem(userId: string, productId: string) {
  const product = await Product.findOne({ _id: productId, deletedAt: null, status: "active", published: { $ne: false }, businessHold: { $ne: true } });
  if (!product || product.inventory?.state !== "available") {
    throw new AppError(409, "UNAVAILABLE", "This device is not available to purchase.");
  }
  if (String(product.sellerUserId) === userId) throw new AppError(400, "OWN_LISTING", "You cannot buy your own listing.");
  await Cart.updateOne(
    { userId },
    { $setOnInsert: { userId }, $addToSet: { items: { productId: product._id } } },
    { upsert: true },
  );
  return getCart(userId);
}

export async function removeCartItem(userId: string, productId: string) {
  await Cart.updateOne({ userId }, { $pull: { items: { productId } } });
  return getCart(userId);
}

async function priceCoupon(code: string | undefined, amountPaise: number) {
  if (!code) return { discountPaise: 0, code: undefined as string | undefined };
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true });
  if (!coupon) throw new AppError(400, "INVALID_COUPON", "Coupon is not valid.");
  if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new AppError(400, "COUPON_EXPIRED", "Coupon has expired.");
  if (coupon.usedCount >= coupon.maxUses) throw new AppError(400, "COUPON_EXHAUSTED", "Coupon has been fully used.");
  if (amountPaise < coupon.minOrderPaise) throw new AppError(400, "COUPON_MINIMUM", "Order total is below the coupon minimum.");
  const discountPaise = coupon.percentOff
    ? Math.floor((amountPaise * coupon.percentOff) / 100)
    : Math.min(amountPaise, coupon.amountOffPaise || 0);
  return { discountPaise, code: coupon.code };
}

export async function checkout(req: Request, input: { addressId?: string; fulfillment: "delivery" | "pickup"; couponCode?: string; productIds?: string[]; offerId?: string }) {
  const user = req.user;
  if (!user) throw forbidden();
  const cart = await Cart.findOne({ userId: user._id });
  // An accepted chat offer buys exactly that one device at the agreed price.
  let offer: InstanceType<typeof Offer> | null = null;
  if (input.offerId) {
    if (!mongoose.isValidObjectId(input.offerId)) throw new AppError(400, "INVALID_OFFER", "That offer could not be found.");
    offer = await Offer.findOne({ _id: input.offerId, buyerId: user._id });
    if (!offer) throw new AppError(404, "INVALID_OFFER", "That offer could not be found.");
    if (offer.status !== "accepted") throw new AppError(409, "OFFER_NOT_ACCEPTED", "Only an accepted offer can be bought at the offer price.");
    if (offer.expiresAt && offer.expiresAt < new Date()) throw new AppError(409, "OFFER_EXPIRED", "This accepted offer has expired. Ask the seller again in chat.");
    input.productIds = [String(offer.productId)];
    input.couponCode = undefined;
  }
  const ids = input.productIds?.length ? input.productIds : cart?.items.map((item) => String(item.productId)) || [];
  if (!ids.length) throw new AppError(400, "EMPTY_CART", "Your cart is empty.");
  const priceOf = (product: { _id: unknown; pricePaise: number }) =>
    offer && String(product._id) === String(offer.productId) ? offer.amountPaise : product.pricePaise;
  const buyer = await BuyerProfile.findOne({ userId: user._id });
  const address = input.fulfillment === "delivery" ? buyer?.addresses.id(input.addressId || "") : undefined;
  if (input.fulfillment === "delivery" && !address) {
    throw new AppError(400, "ADDRESS_REQUIRED", "Choose a saved delivery address.");
  }
  const reserved: string[] = [];
  /** Stock-tracked showroom listings reserve one physical unit; productId → unit. */
  const units = new Map<string, { _id: unknown; code: string }>();
  const expires = new Date(Date.now() + RESERVATION_MINUTES * 60 * 1000);
  const orderId = new (await import("mongoose")).Types.ObjectId();
  try {
    for (const id of ids) {
      if (!mongoose.isValidObjectId(id)) throw new AppError(400, "UNAVAILABLE", "One of the devices could not be found.");
      const tracked = await Product.findOne({ _id: id, stockTracked: true, status: "active", published: { $ne: false }, businessHold: { $ne: true }, deletedAt: null, sellerUserId: { $ne: user._id } });
      if (tracked) {
        const unit = await reserveUnit(tracked._id, orderId, expires, user._id as never);
        if (!unit) throw new AppError(409, "UNAVAILABLE", `${tracked.title} just went out of stock. Review your cart.`);
        units.set(String(tracked._id), { _id: unit._id, code: unit.code });
        reserved.push(String(tracked._id));
        continue;
      }
      const updated = await Product.findOneAndUpdate(
        { _id: id, stockTracked: { $ne: true }, published: { $ne: false }, businessHold: { $ne: true }, status: "active", "inventory.state": "available", deletedAt: null, sellerUserId: { $ne: user._id } },
        { $set: { status: "reserved", "inventory.state": "reserved", "inventory.reservedUntil": expires, "inventory.reservedOrderId": orderId } },
        { new: true },
      );
      if (!updated) {
        throw new AppError(409, "UNAVAILABLE", "One of the devices was just reserved or sold. Review your cart.");
      }
      reserved.push(String(updated._id));
    }
    const products = await Product.find({ _id: { $in: reserved } });
    const amount = products.reduce((sum, product) => sum + priceOf(product), 0);
    const coupon = await priceCoupon(input.couponCode, amount);
    const payable = Math.max(0, amount - coupon.discountPaise);
    const groups = new Map<string, typeof products>();
    for (const product of products) {
      const key = String(product.businessId || product.sellerUserId);
      groups.set(key, [...(groups.get(key) || []), product]);
    }
    const subOrders = [...groups.values()].map((group) => ({
      sellerUserId: group[0].sellerUserId,
      businessId: group[0].businessId,
      items: group.map((product) => ({
        productId: product._id,
        sellerUserId: product.sellerUserId,
        businessId: product.businessId,
        title: product.title,
        pricePaise: priceOf(product),
        quantity: 1,
        unitId: units.get(String(product._id))?._id,
        unitCode: units.get(String(product._id))?.code,
      })),
      amountPaise: group.reduce((sum, product) => sum + priceOf(product), 0),
      status: "pending_payment",
      fulfillment: input.fulfillment,
    }));
    const order = await Order.create({
      _id: orderId,
      number: `SG${Date.now().toString(36).toUpperCase()}${randomId(2).toUpperCase()}`,
      buyerId: user._id,
      items: subOrders.flatMap((sub) => sub.items),
      subOrders,
      amountPaise: payable,
      discountPaise: coupon.discountPaise,
      couponCode: coupon.code,
      fulfillment: input.fulfillment,
      address: address ? address.toObject() : undefined,
      status: "pending_payment",
      reservationExpiresAt: expires,
    });
    const provider = getPaymentProvider();
    if (!provider.configured) {
      throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Payment gateway is not configured. The order was not marked as paid.");
    }
    const gateway = await provider.createOrder({
      amountPaise: payable,
      receipt: order.number,
      notes: { orderId: String(order._id), type: "product" },
    });
    const payment = await Payment.create({
      type: "product",
      userId: user._id,
      amountPaise: payable,
      provider: provider.name,
      gatewayOrderId: gateway.gatewayOrderId,
      referenceType: "order",
      referenceId: order._id,
      idempotencyKey: `order:${order._id}`,
    });
    order.paymentId = payment._id;
    await order.save();
    if (offer) {
      offer.orderId = order._id;
      await offer.save();
    }
    if (cart) {
      await Cart.updateOne(
        { _id: cart._id },
        {
          $set: { items: cart.items.filter((item) => !reserved.includes(String(item.productId))) },
          $unset: { couponCode: 1 },
        },
      );
    }
    return {
      orderId: String(order._id),
      number: order.number,
      amountPaise: payable,
      reservationExpiresAt: expires,
      payment: gateway,
      mock: provider.name === "mock",
    };
  } catch (error) {
    await releaseOrderUnits(orderId, "checkout_failed");
    await Product.updateMany(
      { _id: { $in: reserved }, "inventory.reservedOrderId": orderId, "inventory.state": "reserved" },
      { $set: { status: "active", "inventory.state": "available" }, $unset: { "inventory.reservedUntil": 1, "inventory.reservedOrderId": 1 } },
    );
    await Order.deleteOne({ _id: orderId });
    throw error;
  }
}

export async function capturePayment(input: {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  signature: string;
}) {
  const provider = getPaymentProvider();
  if (
    !provider.verifyCheckoutSignature({
      orderId: input.gatewayOrderId,
      paymentId: input.gatewayPaymentId,
      signature: input.signature,
    })
  ) {
    throw new AppError(400, "PAYMENT_SIGNATURE_INVALID", "Payment signature verification failed. The order remains unpaid.");
  }
  return applyCapturedPayment(input.gatewayOrderId, input.gatewayPaymentId);
}

export async function applyCapturedPayment(gatewayOrderId: string, gatewayPaymentId: string) {
  const payment = await Payment.findOneAndUpdate(
    { gatewayOrderId, status: "created" },
    { $set: { status: "captured", gatewayPaymentId } },
    { new: true },
  );
  if (!payment) {
    const existing = await Payment.findOne({ gatewayOrderId, status: "captured" });
    if (existing) return { alreadyProcessed: true, paymentId: String(existing._id) };
    throw notFound("Payment order not found.");
  }
  if (payment.referenceType === "order" && payment.referenceId) {
    const order = await Order.findOneAndUpdate(
      { _id: payment.referenceId, status: "pending_payment" },
      { $set: { status: "paid", "subOrders.$[].status": "paid" } },
      { new: true },
    );
    if (order) {
      await Product.updateMany(
        { "inventory.reservedOrderId": order._id, "inventory.state": "reserved" },
        { $set: { status: "sold", "inventory.state": "sold" } },
      );
      await markOrderUnitsSold(order._id, order.buyerId);
      await onOrderPaid(String(order._id));
      await markOffersPurchased(order._id, order.number);
      if (order.couponCode) await Coupon.updateOne({ code: order.couponCode }, { $inc: { usedCount: 1 } });
      await qualifyReferral(String(order.buyerId), String(order._id));
      const sellers = [...new Set(order.subOrders.map((sub) => String(sub.sellerUserId)))];
      await notify({
        userId: String(order.buyerId),
        event: "payment.successful",
        title: "Payment received",
        body: `Order ${order.number} is paid. Sellers will confirm fulfilment.`,
        data: { orderId: String(order._id) },
      });
      await Promise.all(
        sellers.map((sellerId) =>
          notify({
            userId: sellerId,
            event: "order.created",
            title: "New paid order",
            body: `Order ${order.number} includes one of your listings.`,
            data: { orderId: String(order._id) },
          }),
        ),
      );
    }
  }
  if (payment.referenceType === "inspection" && payment.referenceId) {
    const request = await InspectionRequest.findOneAndUpdate(
      { _id: payment.referenceId, status: "pending_payment" },
      { $set: { status: "matching", paymentId: payment._id } },
      { new: true },
    );
    if (request) {
      await notify({
        userId: String(request.buyerId),
        event: "inspection.requested",
        title: "Inspection payment received",
        body: "We are matching a nearby verified partner.",
        data: { requestId: String(request._id) },
      });
      await allocatePartner(String(request._id));
    }
  }
  if (payment.referenceType === "subscription" && payment.referenceId) {
    const subscription = await Subscription.findById(payment.referenceId);
    if (subscription) {
      const days = subscription.interval === "annual" ? 365 : 30;
      subscription.status = "active";
      subscription.currentPeriodStart = new Date();
      subscription.currentPeriodEnd = addDays(new Date(), days);
      await subscription.save();
      await notify({
        userId: String(payment.userId),
        event: "subscription.renewed",
        title: "Subscription active",
        body: "Your SureGad subscription payment was verified.",
      });
    }
  }
  return { alreadyProcessed: false, paymentId: String(payment._id) };
}

export async function handleWebhook(rawBody: Buffer, signature: string | undefined) {
  const provider = getPaymentProvider();
  if (!provider.verifyWebhook(rawBody, signature)) {
    throw new AppError(400, "WEBHOOK_SIGNATURE_INVALID", "Webhook signature verification failed.");
  }
  const event = JSON.parse(rawBody.toString("utf8")) as {
    id?: string;
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string; status?: string } } };
  };
  const eventId = event.id || crypto.createHash("sha256").update(rawBody).digest("hex");
  try {
    await WebhookEvent.create({ provider: provider.name, eventId, type: event.event });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return { duplicate: true };
    throw error;
  }
  const paymentEntity = event.payload?.payment?.entity;
  if (event.event === "payment.captured" && paymentEntity?.order_id && paymentEntity.id) {
    await applyCapturedPayment(paymentEntity.order_id, paymentEntity.id);
  }
  return { duplicate: false };
}

export async function releaseExpiredReservations(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const now = new Date();
  const expired = await Order.find({ status: "pending_payment", reservationExpiresAt: { $lt: now } });
  for (const order of expired) {
    const cancelled = await Order.findOneAndUpdate(
      { _id: order._id, status: "pending_payment" },
      { $set: { status: "cancelled", cancelReason: "payment_timeout" } },
    );
    if (!cancelled) continue;
    await Product.updateMany(
      { "inventory.reservedOrderId": order._id, "inventory.state": "reserved" },
      { $set: { status: "active", "inventory.state": "available" }, $unset: { "inventory.reservedUntil": 1, "inventory.reservedOrderId": 1 } },
    );
    await releaseOrderUnits(order._id, "payment_timeout");
    await Payment.updateOne({ _id: order.paymentId, status: "created" }, { status: "failed" });
  }
}

export async function requestRefund(req: Request, orderId: string, reason: string) {
  const order = await Order.findOne({ _id: orderId, buyerId: req.user?._id });
  if (!order) throw notFound("Order not found.");
  if (!["paid", "confirmed", "delivered"].includes(order.status)) {
    throw new AppError(409, "REFUND_NOT_ALLOWED", "This order cannot be refunded in its current state.");
  }
  const payment = await Payment.findById(order.paymentId);
  if (!payment || payment.status !== "captured") throw new AppError(409, "PAYMENT_NOT_CAPTURED", "Payment is not captured.");
  return Refund.create({
    paymentId: payment._id,
    orderId: order._id,
    userId: req.user!._id,
    amountPaise: order.amountPaise,
    reason,
    status: "requested",
  });
}

export async function processRefund(req: Request, refundId: string, approve: boolean) {
  const refund = await Refund.findById(refundId);
  if (!refund) throw notFound("Refund not found.");
  if (!approve) {
    refund.status = "rejected";
    await refund.save();
    await audit(req, "refund.rejected", "Refund", String(refund._id));
    return refund;
  }
  const payment = await Payment.findById(refund.paymentId);
  if (!payment?.gatewayPaymentId) throw new AppError(409, "PAYMENT_MISSING", "Gateway payment id is missing.");
  const provider = getPaymentProvider();
  const result = await provider.refund({ paymentId: payment.gatewayPaymentId, amountPaise: refund.amountPaise });
  refund.status = "processed";
  refund.gatewayRefundId = result.refundId;
  await refund.save();
  payment.status = refund.amountPaise >= payment.amountPaise ? "refunded" : "partially_refunded";
  await payment.save();
  if (refund.orderId) {
    const order = await Order.findById(refund.orderId);
    if (order) {
      // Sub-order refunds (rejected orders, returns) only touch that seller's part.
      const subs = refund.subOrderId ? order.subOrders.filter((sub) => String(sub._id) === String(refund.subOrderId)) : order.subOrders;
      for (const sub of subs) {
        sub.status = "refunded";
        sub.timeline.push({ status: "refunded", note: "Refund processed", at: new Date() });
      }
      order.status = order.subOrders.every((sub) => sub.status === "refunded")
        ? "refunded"
        : "partially_refunded";
      await order.save();
      // Single-device listings go back on sale. Stock-tracked units are restocked by the seller after inspection.
      const legacyIds = subs.flatMap((sub) => sub.items).filter((item) => !item.unitId).map((item) => item.productId);
      if (!refund.returnId && legacyIds.length) {
        await Product.updateMany(
          { _id: { $in: legacyIds }, stockTracked: { $ne: true }, "inventory.state": "sold" },
          { $set: { status: "active", "inventory.state": "available" }, $unset: { "inventory.reservedOrderId": 1 } },
        );
      }
    }
  }
  if (refund.returnId) {
    const { ReturnRequest } = await import("../models/showroom.model");
    await ReturnRequest.updateOne(
      { _id: refund.returnId },
      { $set: { status: "refunded" }, $push: { timeline: { status: "refunded", note: "Refund processed by SureGad", at: new Date() } } },
    );
  }
  await notify({
    userId: String(refund.userId),
    event: "refund.processed",
    title: "Refund processed",
    body: "Your refund was submitted to the payment provider.",
  });
  await audit(req, "refund.processed", "Refund", String(refund._id));
  return refund;
}

export async function startInspectionCheckout(req: Request, input: { productId: string; planCode: string; publishOnListing: boolean; mode?: "physical" | "online" }) {
  const user = req.user;
  if (!user) throw forbidden();
  const product = await Product.findOne({ _id: input.productId, status: { $in: ["active", "reserved"] }, deletedAt: null });
  if (!product) throw notFound("Product not found.");
  const plan = await InspectionPlan.findOne({ code: input.planCode, active: true, categorySlug: product.categorySlug });
  if (!plan) throw new AppError(400, "UNKNOWN_PLAN", "Inspection plan is not available for this device.");
  const provider = getPaymentProvider();
  if (!provider.configured) {
    throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Inspection payment cannot start until the payment gateway is configured.");
  }
  const request = await InspectionRequest.create({
    number: `INS-${randomId(4).toUpperCase()}`,
    buyerId: user._id,
    productId: product._id,
    sellerUserId: product.sellerUserId,
    planId: plan._id,
    status: "pending_payment",
    publishOnListing: input.publishOnListing,
    mode: input.mode || "physical",
    businessId: product.businessId,
  });
  const gateway = await provider.createOrder({
    amountPaise: plan.pricePaise,
    receipt: request.number,
    notes: { requestId: String(request._id), type: "inspection" },
  });
  const payment = await Payment.create({
    type: "inspection",
    userId: user._id,
    amountPaise: plan.pricePaise,
    provider: provider.name,
    gatewayOrderId: gateway.gatewayOrderId,
    referenceType: "inspection",
    referenceId: request._id,
    idempotencyKey: `inspection:${request._id}`,
  });
  request.paymentId = payment._id;
  await request.save();
  return { requestId: String(request._id), payment: gateway, mock: provider.name === "mock" };
}

export async function startSubscriptionCheckout(req: Request, input: { planCode: string; interval: "monthly" | "annual"; businessId?: string }) {
  const user = req.user;
  if (!user) throw forbidden();
  const plan = await SubscriptionPlan.findOne({ code: input.planCode, active: true });
  if (!plan) throw notFound("Plan not found.");
  if (plan.monthlyPricePaise <= 0) throw new AppError(400, "FREE_PLAN", "The free plan does not require payment.");
  if (plan.audience === "business") {
    if (!input.businessId) throw new AppError(400, "BUSINESS_REQUIRED", "Choose a business.");
    const business = await Business.findOne({ _id: input.businessId, ownerId: user._id });
    if (!business && !req.permissions?.has("*")) throw forbidden();
  }
  const subjectType = plan.audience === "business" ? "business" : "user";
  const subjectId = plan.audience === "business" ? input.businessId : user._id;
  const amount = input.interval === "annual" ? plan.annualPricePaise : plan.monthlyPricePaise;
  let subscription = await Subscription.findOne({ subjectType, subjectId, status: { $in: ["active", "past_due", "grace", "expired", "cancelled"] } }).sort({ createdAt: -1 });
  if (!subscription) {
    subscription = await Subscription.create({
      subjectType,
      subjectId,
      planId: plan._id,
      status: "past_due",
      interval: input.interval,
    });
  } else {
    subscription.planId = plan._id;
    subscription.interval = input.interval;
    subscription.status = "past_due";
    await subscription.save();
  }
  const provider = getPaymentProvider();
  if (!provider.configured) throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Subscription payments are not configured.");
  const gateway = await provider.createOrder({
    amountPaise: amount,
    receipt: `sub_${String(subscription._id).slice(-8)}`,
    notes: { subscriptionId: String(subscription._id), type: "subscription" },
  });
  await Payment.create({
    type: "subscription",
    userId: user._id,
    amountPaise: amount,
    provider: provider.name,
    gatewayOrderId: gateway.gatewayOrderId,
    referenceType: "subscription",
    referenceId: subscription._id,
    idempotencyKey: `sub:${subscription._id}:${gateway.gatewayOrderId}`,
  });
  return { subscriptionId: String(subscription._id), payment: gateway, mock: provider.name === "mock" };
}
