import mongoose, { Types } from "mongoose";
import { Product } from "../models/catalog.model";
import { Promotion } from "../models/showroom.model";
import { Subscription } from "../models/commerce.model";
import { Business } from "../models/profiles.model";
import { notifyPriceAlerts } from "./growth.service";
import { notify } from "./notification.service";
import { logger } from "../config/logger";

function discounted(base: number, kind: string, value: number) {
  const price = kind === "percent" ? Math.round(base * (1 - value / 100)) : Math.round(base - value);
  return Math.max(100, price);
}

/** Restore the base price of every listing still carrying this promotion. */
export async function endPromotion(promotionId: Types.ObjectId | string) {
  const products = await Product.find({ "promo.promotionId": promotionId });
  for (const product of products) {
    const base = product.promo?.basePricePaise;
    // Only touch listings whose promo marker still matches (guards against a concurrent restart).
    const updated = await Product.findOneAndUpdate(
      { _id: product._id, "promo.promotionId": promotionId },
      {
        $set: { pricePaise: base || product.pricePaise },
        $unset: { promo: 1 },
        $push: { priceHistory: { pricePaise: base || product.pricePaise, reason: "promotion_ended", at: new Date() } },
      },
    );
    if (!updated) continue;
  }
}

/**
 * Start due promotions and end expired ones. Runs every minute and right after a promotion is created.
 * Prices change atomically per listing so a buyer never sees a half-applied discount.
 */
export async function runPromotions(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const now = new Date();
  const expired = await Promotion.find({ status: "active", endsAt: { $lte: now } });
  for (const promotion of expired) {
    await endPromotion(promotion._id);
    promotion.status = "ended";
    await promotion.save();
  }
  const due = await Promotion.find({ status: "scheduled", startsAt: { $lte: now }, endsAt: { $gt: now } });
  for (const promotion of due) {
    const claimed = await Promotion.findOneAndUpdate({ _id: promotion._id, status: "scheduled" }, { status: "active" });
    if (!claimed) continue;
    const products = await Product.find({ _id: { $in: promotion.productIds }, businessId: promotion.businessId, deletedAt: null });
    for (const product of products) {
      if (product.promo?.promotionId) continue;
      const base = product.pricePaise;
      const price = discounted(base, promotion.kind, promotion.value);
      const updated = await Product.findOneAndUpdate(
        { _id: product._id, "promo.promotionId": { $exists: false }, pricePaise: base },
        {
          $set: { pricePaise: price, promo: { promotionId: promotion._id, basePricePaise: base, endsAt: promotion.endsAt } },
          $push: { priceHistory: { pricePaise: price, reason: `promotion:${promotion.name}`, at: new Date() } },
        },
      );
      if (updated && price < base) await notifyPriceAlerts(String(product._id), price);
    }
  }
  const stale = await Promotion.find({ status: "scheduled", endsAt: { $lte: now } });
  for (const promotion of stale) {
    promotion.status = "ended";
    await promotion.save();
  }
}

/** Subscriptions past their period move to grace, then expire; owners are told before it happens. */
export async function runSubscriptionLifecycle(): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  const now = new Date();
  const soon = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const ending = await Subscription.find({ subjectType: "business", status: "active", interval: { $ne: "free" }, currentPeriodEnd: { $lte: soon, $gt: now }, cancelAtPeriodEnd: { $ne: true } });
  for (const subscription of ending) {
    const business = await Business.findById(subscription.subjectId).select("ownerId name");
    if (!business) continue;
    const key = `subscription-ending-${subscription._id}-${subscription.currentPeriodEnd?.toISOString().slice(0, 10)}`;
    const { Notification } = await import("../models/engagement.model");
    if (await Notification.exists({ userId: business.ownerId, "data.key": key })) continue;
    await notify({ userId: String(business.ownerId), event: "subscription.ending", title: "Subscription renews soon", body: `${business.name}'s plan period ends on ${subscription.currentPeriodEnd?.toDateString()}. Renew to keep your listing limits.`, data: { key } });
  }
  const lapsed = await Subscription.find({ subjectType: "business", status: "active", interval: { $ne: "free" }, currentPeriodEnd: { $lte: now } });
  for (const subscription of lapsed) {
    subscription.status = "grace";
    subscription.graceUntil = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    await subscription.save();
    const business = await Business.findById(subscription.subjectId).select("ownerId name");
    if (business) await notify({ userId: String(business.ownerId), event: "subscription.grace", title: "Subscription in grace period", body: `Renew within 3 days to keep ${business.name}'s listings live.` });
  }
}

export function startShowroomJobs() {
  setInterval(() => {
    runPromotions().catch((error) => logger.error({ err: error }, "Promotion job failed"));
  }, 60_000);
  setInterval(() => {
    runSubscriptionLifecycle().catch((error) => logger.error({ err: error }, "Subscription job failed"));
  }, 15 * 60_000);
}
