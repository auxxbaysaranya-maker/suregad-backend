import { Subscription, SubscriptionPlan, SubscriptionUsage } from "../models/commerce.model";
import { Product } from "../models/catalog.model";
import { BusinessEmployee } from "../models/profiles.model";
import { AppError } from "../common/errors";
import { kolkataMonthRange } from "../common/time";

export interface Entitlements {
  active: boolean;
  status?: string;
  planCode?: string;
  subscriptionId?: string;
  limits: {
    activeListings: number;
    monthlyListings: number;
    photosPerListing: number;
    employees: number;
  };
  features: Record<string, unknown>;
}

const emptyLimits = { activeListings: 0, monthlyListings: 0, photosPerListing: 0, employees: 0 };

export async function getEntitlements(input: {
  userId?: string;
  businessId?: string;
}): Promise<Entitlements> {
  const subjectType = input.businessId ? "business" : "user";
  const subjectId = input.businessId || input.userId;
  if (!subjectId) return { active: false, limits: emptyLimits, features: {} };
  const subscription = await Subscription.findOne({
    subjectType,
    subjectId,
    status: { $in: ["active", "grace", "trialing"] },
  }).sort({ createdAt: -1 });
  if (!subscription) return { active: false, limits: emptyLimits, features: {} };
  if (subscription.status === "grace" && subscription.graceUntil && subscription.graceUntil < new Date()) {
    subscription.status = "expired";
    await subscription.save();
    return { active: false, status: "expired", limits: emptyLimits, features: {} };
  }
  const plan = await SubscriptionPlan.findById(subscription.planId);
  if (!plan || !plan.active) return { active: false, limits: emptyLimits, features: {} };
  const planLimits = plan.limits || { activeListings: 0, monthlyListings: 0, photosPerListing: 0, employees: 0 };
  const limits = {
    activeListings: Number(subscription.overrideLimits?.activeListings ?? planLimits.activeListings),
    monthlyListings: Number(subscription.overrideLimits?.monthlyListings ?? planLimits.monthlyListings),
    photosPerListing: Number(subscription.overrideLimits?.photosPerListing ?? planLimits.photosPerListing),
    employees: Number(subscription.overrideLimits?.employees ?? planLimits.employees ?? 0),
  };
  return {
    active: true,
    status: subscription.status,
    planCode: plan.code,
    subscriptionId: String(subscription._id),
    limits,
    features: plan.features || {},
  };
}

export async function assertCanCreateListing(input: {
  userId: string;
  businessId?: string;
  imageCount: number;
}): Promise<Entitlements> {
  const entitlements = await getEntitlements(input);
  if (!entitlements.active) {
    throw new AppError(
      402,
      "SUBSCRIPTION_REQUIRED",
      input.businessId
        ? "This business needs an active subscription before listings can be published."
        : "No active listing plan was found for this seller.",
    );
  }
  if (input.imageCount > entitlements.limits.photosPerListing) {
    throw new AppError(403, "PHOTO_LIMIT", "This plan does not allow that many photographs on one listing.");
  }
  const ownerFilter = input.businessId
    ? { businessId: input.businessId }
    : { sellerUserId: input.userId, sellerType: "individual" };
  const activeCount = await Product.countDocuments({
    ...ownerFilter,
    deletedAt: null,
    status: { $in: ["draft", "pending_review", "active", "reserved"] },
  });
  if (activeCount >= entitlements.limits.activeListings) {
    throw new AppError(403, "LISTING_LIMIT", "Active listing limit for the current plan has been reached.");
  }
  const { start, end } = kolkataMonthRange();
  const monthlyCount = await Product.countDocuments({
    ...ownerFilter,
    deletedAt: null,
    createdAt: { $gte: start, $lt: end },
  });
  if (monthlyCount >= entitlements.limits.monthlyListings) {
    throw new AppError(403, "MONTHLY_LISTING_LIMIT", "Monthly listing limit for the current plan has been reached.");
  }
  return entitlements;
}

export async function assertCanAddEmployee(businessId: string): Promise<void> {
  const entitlements = await getEntitlements({ businessId });
  if (!entitlements.active) {
    throw new AppError(402, "SUBSCRIPTION_REQUIRED", "An active business subscription is required to add employees.");
  }
  const count = await BusinessEmployee.countDocuments({ businessId, status: { $ne: "revoked" } });
  if (count >= entitlements.limits.employees) {
    throw new AppError(403, "EMPLOYEE_LIMIT", "Employee limit for the current plan has been reached.");
  }
}

export async function recordUsage(subscriptionId: string | undefined, metric: string, meta?: unknown): Promise<void> {
  if (!subscriptionId) return;
  const { start } = kolkataMonthRange();
  await SubscriptionUsage.create({ subscriptionId, metric, periodStart: start, meta });
}
