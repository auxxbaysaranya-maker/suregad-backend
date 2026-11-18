import { Schema, model } from "mongoose";

const enquirySchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    businessId: Schema.Types.ObjectId,
    productId: Schema.Types.ObjectId,
    subject: { type: String, required: true },
    status: { type: String, enum: ["open", "answered", "closed", "spam"], default: "open" },
    conversationId: Schema.Types.ObjectId,
  },
  { timestamps: true },
);

/**
 * One chat thread between a buyer and a seller about one listing.
 * Older threads created before buyerId/sellerUserId existed store the buyer first in participantIds.
 */
const conversationSchema = new Schema(
  {
    participantIds: { type: [Schema.Types.ObjectId], ref: "User", index: true },
    productId: Schema.Types.ObjectId,
    enquiryId: Schema.Types.ObjectId,
    buyerId: { type: Schema.Types.ObjectId, ref: "User" },
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User" },
    lastMessageAt: Date,
    lastPreview: String,
    lastSenderId: Schema.Types.ObjectId,
    /** Unread message count keyed by user id. */
    unread: { type: Map, of: Number, default: {} },
    importantFor: { type: [Schema.Types.ObjectId], default: [] },
    /** Users who deleted the thread from their inbox. A new message brings it back. */
    hiddenFor: { type: [Schema.Types.ObjectId], default: [] },
    blockedBy: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true },
);
conversationSchema.index({ buyerId: 1, sellerUserId: 1, productId: 1 });
conversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["text", "image", "offer", "system"], default: "text" },
    /** Text, or a readable summary for offer/system/image messages. */
    body: { type: String, required: true, maxlength: 4000 },
    imageUrl: String,
    offerId: { type: Schema.Types.ObjectId, ref: "Offer" },
    readBy: { type: [Schema.Types.ObjectId], default: [] },
    reported: { type: Boolean, default: false },
    reportReason: String,
  },
  { timestamps: true },
);
messageSchema.index({ conversationId: 1, createdAt: -1 });

/** A price offer inside a chat. Accepted offers can be bought at the agreed price until they expire. */
const offerSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    amountPaise: { type: Number, required: true, min: 1 },
    listPricePaise: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "withdrawn", "superseded", "expired", "purchased"],
      default: "pending",
    },
    respondedAt: Date,
    expiresAt: Date,
    orderId: { type: Schema.Types.ObjectId, ref: "Order" },
  },
  { timestamps: true },
);

const reviewSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetType: { type: String, enum: ["product", "seller", "business", "partner", "inspection"], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    orderId: Schema.Types.ObjectId,
    inspectionRequestId: Schema.Types.ObjectId,
    rating: { type: Number, min: 1, max: 5, required: true },
    body: { type: String, maxlength: 4000, default: "" },
    imageKeys: { type: [String], default: [] },
    verifiedPurchase: { type: Boolean, default: false },
    inspectionOnly: { type: Boolean, default: false },
    status: { type: String, enum: ["published", "hidden", "flagged"], default: "published" },
    sellerReply: String,
    fraudSignals: { type: [String], default: [] },
  },
  { timestamps: true },
);
reviewSchema.index({ authorId: 1, targetType: 1, targetId: 1 }, { unique: true });
reviewSchema.index({ targetType: 1, targetId: 1, status: 1 });

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    event: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: Schema.Types.Mixed,
    channels: { type: [String], default: ["in_app"] },
    readAt: Date,
  },
  { timestamps: true },
);

const disputeSchema = new Schema(
  {
    openedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["order", "inspection", "review"], required: true },
    referenceId: { type: Schema.Types.ObjectId, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ["open", "under_review", "resolved", "rejected"], default: "open" },
    resolution: String,
  },
  { timestamps: true },
);

const supportTicketSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, enum: ["open", "pending", "resolved"], default: "open" },
  },
  { timestamps: true },
);

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    action: { type: String, required: true },
    entityType: String,
    entityId: String,
    meta: Schema.Types.Mixed,
    ip: String,
  },
  { timestamps: true },
);
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });

const settingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

const aiJobSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    task: { type: String, required: true },
    status: { type: String, enum: ["completed", "failed", "refused"], required: true },
    provider: String,
    model: String,
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    error: String,
  },
  { timestamps: true },
);

const aiRiskSchema = new Schema(
  {
    subjectType: String,
    subjectId: String,
    signals: [String],
    summary: String,
    requiresHumanReview: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const payoutSchema = new Schema(
  {
    partnerId: { type: Schema.Types.ObjectId, ref: "PartnerProfile", required: true },
    requestId: { type: Schema.Types.ObjectId, ref: "InspectionRequest" },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: ["pending", "processed", "failed"], default: "pending" },
    note: String,
  },
  { timestamps: true },
);

export const Enquiry = model("Enquiry", enquirySchema);
export const Conversation = model("Conversation", conversationSchema);
export const Message = model("Message", messageSchema);
export const Offer = model("Offer", offerSchema);
export const Review = model("Review", reviewSchema);
export const Notification = model("Notification", notificationSchema);
export const Dispute = model("Dispute", disputeSchema);
export const SupportTicket = model("SupportTicket", supportTicketSchema);
export const AuditLog = model("AuditLog", auditLogSchema);
export const PlatformSetting = model("PlatformSetting", settingSchema);
export const AIJob = model("AIJob", aiJobSchema);
export const AIRiskEvent = model("AIRiskEvent", aiRiskSchema);
export const PartnerPayout = model("PartnerPayout", payoutSchema);

const referralSchema = new Schema(
  {
    referrerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    refereeId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    code: { type: String, required: true },
    status: { type: String, enum: ["pending", "qualified"], default: "pending" },
    qualifiedOrderId: Schema.Types.ObjectId,
  },
  { timestamps: true },
);

const priceAlertSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    targetPaise: { type: Number, required: true },
    active: { type: Boolean, default: true },
    notifiedAt: Date,
  },
  { timestamps: true },
);
priceAlertSchema.index({ userId: 1, productId: 1 }, { unique: true });

const settlementSchema = new Schema(
  {
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amountPaise: { type: Number, required: true },
    reference: { type: String, required: true },
    note: { type: String, default: "" },
    status: { type: String, enum: ["recorded"], default: "recorded" },
    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

const newsletterSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    emailConsent: { type: Boolean, default: false },
    whatsappConsent: { type: Boolean, default: false },
    phone: String,
  },
  { timestamps: true },
);

export const NewsletterSignup = model("NewsletterSignup", newsletterSchema);
export const Referral = model("Referral", referralSchema);
export const PriceAlert = model("PriceAlert", priceAlertSchema);
export const SellerSettlement = model("SellerSettlement", settlementSchema);
