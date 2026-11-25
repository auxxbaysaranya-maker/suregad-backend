import { Schema, model } from "mongoose";

const subscriptionPlanSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    audience: { type: String, enum: ["individual", "business"], required: true },
    monthlyPricePaise: { type: Number, required: true },
    annualPricePaise: { type: Number, required: true },
    limits: {
      activeListings: { type: Number, required: true },
      monthlyListings: { type: Number, required: true },
      photosPerListing: { type: Number, required: true },
      employees: { type: Number, default: 0 },
      /** Days a listing stays live before it expires (0 = no limit). */
      listingValidityDays: { type: Number, min: 0 },
    },
    features: { type: Schema.Types.Mixed, default: {} },
    gracePeriodDays: { type: Number, default: 3 },
    active: { type: Boolean, default: true },
    custom: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const subscriptionSchema = new Schema(
  {
    subjectType: { type: String, enum: ["user", "business"], required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    planId: { type: Schema.Types.ObjectId, ref: "SubscriptionPlan", required: true },
    status: {
      type: String,
      enum: ["trialing", "active", "past_due", "grace", "cancelled", "expired"],
      default: "active",
    },
    interval: { type: String, enum: ["free", "monthly", "annual"], default: "free" },
    currentPeriodStart: Date,
    currentPeriodEnd: Date,
    graceUntil: Date,
    cancelAtPeriodEnd: { type: Boolean, default: false },
    providerSubscriptionId: String,
    overrideLimits: Schema.Types.Mixed,
  },
  { timestamps: true },
);
subscriptionSchema.index({ subjectType: 1, subjectId: 1, status: 1 });

const usageSchema = new Schema(
  {
    subscriptionId: { type: Schema.Types.ObjectId, ref: "Subscription", required: true },
    metric: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    periodStart: Date,
    meta: Schema.Types.Mixed,
  },
  { timestamps: true },
);

const cartSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    items: {
      type: [
        {
          productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    couponCode: String,
  },
  { timestamps: true },
);

const orderItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: Schema.Types.ObjectId,
    title: String,
    pricePaise: Number,
    quantity: { type: Number, default: 1 },
    unitId: { type: Schema.Types.ObjectId, ref: "InventoryUnit" },
    unitCode: String,
  },
  { _id: true },
);

export const SUBORDER_STATUSES = [
  "pending_payment",
  "paid",
  "accepted",
  "confirmed",
  "processing",
  "ready_for_dispatch",
  "shipped",
  "dispatched",
  "delivered",
  "rejected",
  "cancelled",
  "returned",
  "refunded",
] as const;

export const DELIVERY_STATUSES = [
  "REQUESTED",
  "PREPARING",
  "READY_FOR_PICKUP",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED",
  "RETURNED",
] as const;

const deliverySchema = new Schema(
  {
    status: { type: String, enum: DELIVERY_STATUSES, default: "REQUESTED" },
    method: { type: String, enum: ["self", "courier", "pickup"], default: "self" },
    courier: String,
    trackingNumber: String,
    trackingUrl: String,
    expectedAt: Date,
    documents: { type: [{ key: String, name: String, at: { type: Date, default: Date.now } }], default: [] },
    /** One-time code the buyer reads out at handover; only its hash is stored. */
    otpHash: String,
    otpIssuedAt: Date,
    proof: { kind: { type: String, enum: ["otp", "photo", "signature"] }, key: String, note: String, at: Date },
    events: {
      type: [{ status: String, note: String, by: Schema.Types.ObjectId, at: { type: Date, default: Date.now } }],
      default: [],
    },
  },
  { _id: false },
);

const subOrderSchema = new Schema(
  {
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    businessId: Schema.Types.ObjectId,
    items: [orderItemSchema],
    amountPaise: Number,
    status: { type: String, enum: SUBORDER_STATUSES, default: "pending_payment" },
    fulfillment: { type: String, enum: ["delivery", "pickup"], default: "delivery" },
    trackingNote: String,
    rejectReason: String,
    delivery: deliverySchema,
    timeline: {
      type: [{ status: String, note: String, by: Schema.Types.ObjectId, at: { type: Date, default: Date.now } }],
      default: [],
    },
    deliveredAt: Date,
  },
  { _id: true },
);

const orderSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    items: [orderItemSchema],
    subOrders: [subOrderSchema],
    amountPaise: { type: Number, required: true },
    discountPaise: { type: Number, default: 0 },
    couponCode: String,
    currency: { type: String, default: "INR" },
    fulfillment: { type: String, enum: ["delivery", "pickup"], default: "delivery" },
    address: Schema.Types.Mixed,
    status: {
      type: String,
      enum: [...SUBORDER_STATUSES, "partially_refunded"],
      default: "pending_payment",
    },
    reservationExpiresAt: Date,
    cancelReason: String,
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
  },
  { timestamps: true },
);

const paymentSchema = new Schema(
  {
    type: {
      type: String,
      enum: ["product", "inspection", "subscription", "featured_listing"],
      required: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    status: {
      type: String,
      enum: ["created", "captured", "failed", "refunded", "partially_refunded"],
      default: "created",
    },
    provider: { type: String, required: true },
    gatewayOrderId: { type: String, index: true },
    gatewayPaymentId: String,
    referenceType: String,
    referenceId: Schema.Types.ObjectId,
    idempotencyKey: { type: String, unique: true, sparse: true },
    rawVerified: Schema.Types.Mixed,
  },
  { timestamps: true },
);

const refundSchema = new Schema(
  {
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
    subOrderId: Schema.Types.ObjectId,
    returnId: { type: Schema.Types.ObjectId, ref: "ReturnRequest" },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amountPaise: { type: Number, required: true },
    reason: String,
    status: { type: String, enum: ["requested", "approved", "rejected", "processed", "failed"], default: "requested" },
    gatewayRefundId: String,
  },
  { timestamps: true },
);

const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    percentOff: Number,
    amountOffPaise: Number,
    minOrderPaise: { type: Number, default: 0 },
    maxUses: { type: Number, default: 100 },
    usedCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    expiresAt: Date,
  },
  { timestamps: true },
);

const webhookEventSchema = new Schema(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    type: String,
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export const SubscriptionPlan = model("SubscriptionPlan", subscriptionPlanSchema);
export const Subscription = model("Subscription", subscriptionSchema);
export const SubscriptionUsage = model("SubscriptionUsage", usageSchema);
export const Cart = model("Cart", cartSchema);
export const Order = model("Order", orderSchema);
export const Payment = model("Payment", paymentSchema);
export const Refund = model("Refund", refundSchema);
export const Coupon = model("Coupon", couponSchema);
export const WebhookEvent = model("WebhookEvent", webhookEventSchema);
