import { Schema, model } from "mongoose";

/**
 * One Firebase Cloud Messaging registration token per browser/device.
 * A token belongs to the account that registered it most recently (the account signed in on that device).
 */
const deviceTokenSchema = new Schema(
  {
    token: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /** Which SureGad app registered it, so notification links open the right site. */
    app: { type: String, enum: ["marketplace", "panel"], required: true },
    userAgent: { type: String, maxlength: 300 },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export const DeviceToken = model("DeviceToken", deviceTokenSchema);
