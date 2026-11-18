import { Schema, model } from "mongoose";

const categorySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    specSchemaKey: { type: String, required: true },
    active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const brandSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    categories: { type: [String], default: [] },
    popular: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const productModelSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },
    categorySlug: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    attributes: { type: Schema.Types.Mixed, default: {} },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const productSchema = new Schema(
  {
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerType: { type: String, enum: ["individual", "business"], required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    categorySlug: { type: String, required: true, index: true },
    brandId: { type: Schema.Types.ObjectId, ref: "Brand" },
    modelId: { type: Schema.Types.ObjectId, ref: "ProductModel" },
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String, required: true },
    condition: { type: String, enum: ["like_new", "excellent", "good", "fair"], required: true },
    pricePaise: { type: Number, required: true, min: 1 },
    specs: { type: Schema.Types.Mixed, required: true },
    images: { type: [{ key: String, url: String, sort: Number }], default: [] },
    city: String,
    district: String,
    state: { type: String, default: "Kerala" },
    pincode: String,
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number] },
    },
    status: {
      type: String,
      enum: ["draft", "pending_review", "active", "rejected", "reserved", "sold", "archived"],
      default: "draft",
      index: true,
    },
    rejectionReason: String,
    inventory: {
      state: { type: String, enum: ["available", "reserved", "sold"], default: "available" },
      reservedUntil: Date,
      reservedOrderId: { type: Schema.Types.ObjectId, ref: "Order" },
    },
    identifier: {
      imeiHash: String,
      imeiLast4: String,
      imeiCipher: String,
      serialHash: String,
      serialLast4: String,
      serialCipher: String,
    },
    stats: { views: { type: Number, default: 0 } },
    inspection: {
      inspected: { type: Boolean, default: false },
      reportId: { type: Schema.Types.ObjectId, ref: "InspectionReport" },
      score: Number,
      critical: { type: Boolean, default: false },
      published: { type: Boolean, default: false },
    },
    featuredUntil: Date,
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

productSchema.index({ title: "text", description: "text" });
productSchema.index({ location: "2dsphere" });
productSchema.index(
  { "identifier.imeiHash": 1 },
  { unique: true, sparse: true, partialFilterExpression: { deletedAt: null } },
);
productSchema.index(
  { "identifier.serialHash": 1 },
  { unique: true, sparse: true, partialFilterExpression: { deletedAt: null } },
);
productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ categorySlug: 1, status: 1, pricePaise: 1 });
productSchema.index({ businessId: 1, status: 1 });
productSchema.index({ featuredUntil: 1, status: 1 });

export const Category = model("Category", categorySchema);
export const Brand = model("Brand", brandSchema);
export const ProductModel = model("ProductModel", productModelSchema);
export const Product = model("Product", productSchema);
