import { Schema, model } from "mongoose";

const pointSchema = {
  type: { type: String, enum: ["Point"], default: "Point" },
  coordinates: { type: [Number] },
};

const addressSchema = new Schema(
  {
    label: { type: String, default: "Home" },
    name: String,
    phone: String,
    line1: String,
    line2: String,
    city: String,
    district: String,
    state: { type: String, default: "Kerala" },
    pincode: String,
    coordinates: { lat: Number, lng: Number },
  },
  { _id: true },
);

/** Public links a seller can show on their storefront page. */
const socialSchema = {
  website: String,
  instagram: String,
  facebook: String,
  youtube: String,
  x: String,
  whatsapp: String,
};

const sellerProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    slug: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    bio: { type: String, default: "" },
    tagline: { type: String, default: "" },
    social: socialSchema,
    city: String,
    district: String,
    state: { type: String, default: "Kerala" },
    verified: { type: Boolean, default: false },
    location: pointSchema,
    deletedAt: Date,
  },
  { timestamps: true },
);

const buyerProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    addresses: { type: [addressSchema], default: [] },
    wishlist: { type: [Schema.Types.ObjectId], ref: "Product", default: [] },
    savedSearches: {
      type: [
        {
          name: String,
          query: Schema.Types.Mixed,
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    deletedAt: Date,
  },
  { timestamps: true },
);

const businessSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    phone: String,
    email: String,
    address: addressSchema,
    gstin: String,
    description: { type: String, default: "" },
    logoKey: String,
    bannerKey: String,
    hours: { type: String, default: "" },
    tagline: { type: String, default: "" },
    social: socialSchema,
    documents: { type: [{ key: String, name: String, status: { type: String, default: "pending" } }], default: [] },
    verificationStatus: {
      type: String,
      enum: ["draft", "pending", "approved", "rejected"],
      default: "pending",
    },
    rejectionReason: String,
    sponsoredUntil: Date,
    location: pointSchema,
    deletedAt: Date,
  },
  { timestamps: true },
);
businessSchema.index({ location: "2dsphere" });
businessSchema.index({ verificationStatus: 1, name: 1 });

const employeeSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    email: { type: String, required: true, lowercase: true },
    name: String,
    permissions: { type: [String], default: [] },
    status: { type: String, enum: ["invited", "active", "revoked"], default: "invited" },
  },
  { timestamps: true },
);
employeeSchema.index({ businessId: 1, email: 1 }, { unique: true });

const partnerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    name: { type: String, required: true },
    phone: String,
    email: String,
    photoKey: String,
    address: addressSchema,
    categories: { type: [String], default: [] },
    experienceYears: { type: Number, default: 0 },
    documents: {
      type: [{ key: String, name: String, kind: String, status: { type: String, default: "pending" } }],
      default: [],
    },
    bank: {
      accountName: String,
      accountNumberLast4: String,
      ifsc: String,
      cipher: String,
    },
    agreementAcceptedAt: Date,
    verificationStatus: {
      type: String,
      enum: ["draft", "pending", "approved", "rejected"],
      default: "pending",
    },
    rejectionReason: String,
    serviceRadiusKm: { type: Number, default: 15 },
    location: pointSchema,
    availability: {
      paused: { type: Boolean, default: false },
      hours: { type: String, default: "09:00-18:00" },
    },
    stats: {
      accepted: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      ratingSum: { type: Number, default: 0 },
      ratingCount: { type: Number, default: 0 },
      openJobs: { type: Number, default: 0 },
    },
    deletedAt: Date,
  },
  { timestamps: true },
);
partnerSchema.index({ location: "2dsphere" });
partnerSchema.index({ verificationStatus: 1, "availability.paused": 1 });

export const SellerProfile = model("SellerProfile", sellerProfileSchema);
export const BuyerProfile = model("BuyerProfile", buyerProfileSchema);
export const Business = model("Business", businessSchema);
export const BusinessEmployee = model("BusinessEmployee", employeeSchema);
export const PartnerProfile = model("PartnerProfile", partnerSchema);
