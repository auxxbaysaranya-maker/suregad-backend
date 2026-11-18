import { Schema, model, type InferSchemaType } from "mongoose";

const roleSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    permissions: { type: [String], required: true },
    system: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const userSchema = new Schema(
  {
    firebaseUid: { type: String, required: true, unique: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    displayName: { type: String, required: true, trim: true },
    passwordHash: String,
    photoUrl: String,
    roles: { type: [String], default: ["buyer"] },
    employeeGrants: {
      type: [
        {
          businessId: { type: Schema.Types.ObjectId, ref: "Business" },
          permissions: [String],
        },
      ],
      default: [],
    },
    status: { type: String, enum: ["active", "suspended", "deleted"], default: "active" },
    suspendedReason: String,
    tokenValidAfter: Date,
    locale: { type: String, default: "en" },
    referralCode: { type: String, unique: true, sparse: true },
    notificationPreferences: {
      inApp: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: false },
      whatsapp: { type: Boolean, default: false },
      push: { type: Boolean, default: false },
    },
    sharePhone: { type: Boolean, default: false },
    fcmTokens: { type: [String], default: [] },
    pushSubscriptions: {
      type: [
        {
          endpoint: { type: String, required: true },
          keys: { p256dh: String, auth: String },
        },
      ],
      default: [],
    },
    lastSeenAt: Date,
    deletedAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { sparse: true });
userSchema.index({ phone: 1 }, { sparse: true });

export type UserShape = InferSchemaType<typeof userSchema> & { _id: Schema.Types.ObjectId };
export const Role = model("Role", roleSchema);
export const User = model("User", userSchema);
