import { Schema, model } from "mongoose";

const checklistItemSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    group: String,
    critical: { type: Boolean, default: false },
    weight: { type: Number, default: 1 },
  },
  { _id: false },
);

const inspectionPlanSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    categorySlug: { type: String, required: true },
    tier: { type: String, enum: ["basic", "advanced"], required: true },
    pricePaise: { type: Number, required: true },
    partnerPayoutPaise: { type: Number, required: true },
    checklist: { type: [checklistItemSchema], default: [] },
    active: { type: Boolean, default: true },
    disclaimer: {
      type: String,
      default:
        "This inspection records the device condition at the time of the visit. It does not guarantee future reliability or remaining lifespan.",
    },
  },
  { timestamps: true },
);

const inspectionRequestSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    planId: { type: Schema.Types.ObjectId, ref: "InspectionPlan", required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment" },
    status: {
      type: String,
      enum: [
        "pending_payment",
        "paid",
        "matching",
        "offered",
        "accepted",
        "scheduled",
        "in_progress",
        "report_submitted",
        "completed",
        "cancelled",
        "expired",
        "disputed",
      ],
      default: "pending_payment",
    },
    publishOnListing: { type: Boolean, default: false },
    appointmentAt: Date,
    excludedPartnerIds: { type: [Schema.Types.ObjectId], default: [] },
    assignedPartnerId: { type: Schema.Types.ObjectId, ref: "PartnerProfile" },
    offerExpiresAt: Date,
    notes: String,
  },
  { timestamps: true },
);

const assignmentSchema = new Schema(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "InspectionRequest", required: true, index: true },
    partnerId: { type: Schema.Types.ObjectId, ref: "PartnerProfile", required: true },
    status: { type: String, enum: ["offered", "accepted", "rejected", "expired", "completed"], required: true },
    score: Number,
    distanceKm: Number,
    expiresAt: Date,
    reason: String,
  },
  { timestamps: true },
);

const evidenceSchema = new Schema(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "InspectionRequest", required: true, index: true },
    partnerId: { type: Schema.Types.ObjectId, ref: "PartnerProfile", required: true },
    key: { type: String, required: true },
    url: String,
    caption: String,
    checklistKey: String,
  },
  { timestamps: true },
);

const reportSchema = new Schema(
  {
    requestId: { type: Schema.Types.ObjectId, ref: "InspectionRequest", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    partnerId: { type: Schema.Types.ObjectId, ref: "PartnerProfile", required: true },
    version: { type: Number, required: true },
    supersedes: { type: Schema.Types.ObjectId, ref: "InspectionReport" },
    results: {
      type: [
        {
          key: String,
          label: String,
          result: String,
          comment: String,
          evidenceIds: [Schema.Types.ObjectId],
          critical: Boolean,
          weight: Number,
        },
      ],
      default: [],
    },
    score: Number,
    componentScores: Schema.Types.Mixed,
    criticalFailures: { type: [String], default: [] },
    verdict: { type: String, enum: ["incomplete", "critical_failure", "passed_with_notes", "passed"] },
    disclaimer: String,
    summary: String,
    published: { type: Boolean, default: false },
  },
  { timestamps: true },
);
reportSchema.index({ requestId: 1, version: 1 }, { unique: true });

export const InspectionPlan = model("InspectionPlan", inspectionPlanSchema);
export const InspectionRequest = model("InspectionRequest", inspectionRequestSchema);
export const InspectionAssignment = model("InspectionAssignment", assignmentSchema);
export const InspectionEvidence = model("InspectionEvidence", evidenceSchema);
export const InspectionReport = model("InspectionReport", reportSchema);
