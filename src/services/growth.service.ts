import crypto from "crypto";
import { User } from "../models/user.model";
import { Product } from "../models/catalog.model";
import { PriceAlert, Referral } from "../models/engagement.model";
import { notify } from "./notification.service";
import { AppError } from "../common/errors";

export function alertIsDue(pricePaise: number, targetPaise: number, notified: boolean): boolean {
  return !notified && pricePaise > 0 && pricePaise <= targetPaise;
}

export async function ensureReferralCode(userId: string): Promise<string> {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, "NOT_FOUND", "Account not found.");
  if (user.referralCode) return user.referralCode;
  const code = `SG${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  user.referralCode = code;
  await user.save();
  return code;
}

export async function claimReferral(refereeId: string, code: string): Promise<void> {
  const referrer = await User.findOne({ referralCode: code.trim().toUpperCase(), status: "active" });
  if (!referrer) throw new AppError(400, "INVALID_REFERRAL", "That referral code is not active.");
  if (String(referrer._id) === refereeId) throw new AppError(400, "INVALID_REFERRAL", "You cannot use your own referral code.");
  const existing = await Referral.findOne({ refereeId });
  if (existing) throw new AppError(409, "REFERRAL_EXISTS", "A referral is already recorded for this account.");
  await Referral.create({ referrerId: referrer._id, refereeId, code: referrer.referralCode, status: "pending" });
}

export async function qualifyReferral(buyerId: string, orderId: string): Promise<void> {
  const referral = await Referral.findOne({ refereeId: buyerId, status: "pending" });
  if (!referral) return;
  referral.status = "qualified";
  referral.qualifiedOrderId = orderId as never;
  await referral.save();
  await notify({
    userId: String(referral.referrerId),
    event: "referral.qualified",
    title: "Referral recorded",
    body: "Someone you invited completed a paid order. This is a record only. It is not a wallet balance.",
    data: { orderId },
  });
}

export async function notifyPriceAlerts(productId: string, pricePaise: number): Promise<void> {
  const alerts = await PriceAlert.find({ productId, active: true, notifiedAt: { $exists: false } });
  for (const alert of alerts) {
    if (!alertIsDue(pricePaise, alert.targetPaise, Boolean(alert.notifiedAt))) continue;
    alert.notifiedAt = new Date();
    alert.active = false;
    await alert.save();
    await notify({
      userId: String(alert.userId),
      event: "price.alert",
      title: "Price alert",
      body: "A saved device is now at or below the price you asked to watch.",
      data: { productId },
    });
  }
}

export async function deviceHistory(productId: string) {
  const product = await Product.findById(productId).select("identifier").lean();
  // Listings marked sold keep the fingerprint behind a "sold:<id>:" prefix.
  const hash = (product?.identifier?.imeiHash || product?.identifier?.serialHash)?.split(":").pop();
  if (!hash) return [];
  const field = product?.identifier?.imeiHash ? "identifier.imeiHash" : "identifier.serialHash";
  const rows = await Product.find({ _id: { $ne: productId }, [field]: { $in: [hash, new RegExp("^sold:[a-f0-9]{24}:" + hash + "$")] }, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(10)
    .select("title status city createdAt")
    .lean();
  return rows.map((row) => ({
    id: String(row._id),
    title: row.title,
    status: row.status,
    city: row.city,
    createdAt: row.createdAt,
  }));
}
