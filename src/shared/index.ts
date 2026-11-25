export const APP_NAME = "SureGad";
export const APP_TAGLINE = "Buy Smart. Buy Verified.";
export const DEFAULT_TIMEZONE = "Asia/Kolkata";
export const DEFAULT_CURRENCY = "INR";
export const DEFAULT_LOCALE = "en-IN";

export const USER_ROLES = [
  "buyer",
  "individual_seller",
  "business_seller",
  "business_employee",
  "service_partner",
  "super_admin",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ACCOUNT_STATUSES = ["active", "suspended", "deleted"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const PRODUCT_CONDITIONS = ["like_new", "excellent", "good", "fair"] as const;
export type ProductCondition = (typeof PRODUCT_CONDITIONS)[number];

export const PRODUCT_STATUSES = [
  "draft",
  "pending_review",
  "expired",
  "active",
  "rejected",
  "reserved",
  "sold",
  "archived",
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const SELLER_TYPES = ["individual", "business"] as const;
export type SellerType = (typeof SELLER_TYPES)[number];

export const CHECK_RESULTS = [
  "passed",
  "failed",
  "not_tested",
  "not_applicable",
  "unable_to_verify",
] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const PAYMENT_TYPES = [
  "product",
  "inspection",
  "subscription",
  "featured_listing",
] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const ORDER_STATUSES = [
  "pending_payment",
  "paid",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const INSPECTION_STATUSES = [
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
] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const PERMISSIONS = [
  "profile.read",
  "profile.update",
  "products.create",
  "products.update",
  "products.archive",
  "products.moderate",
  "enquiries.read",
  "enquiries.reply",
  "orders.read",
  "orders.manage",
  "cart.manage",
  "inspections.request",
  "inspections.perform",
  "inspections.manage",
  "reviews.create",
  "reviews.moderate",
  "subscriptions.manage",
  "employees.manage",
  "business.manage",
  "partner.manage",
  "payments.read",
  "admin.access",
  "admin.users",
  "admin.verification",
  "admin.catalog",
  "admin.finance",
  "admin.settings",
  "admin.audit",
  "ai.use",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_SEEDS: Record<UserRole, Permission[] | ["*"]> = {
  buyer: [
    "profile.read",
    "profile.update",
    "enquiries.read",
    "enquiries.reply",
    "orders.read",
    "cart.manage",
    "inspections.request",
    "reviews.create",
    "ai.use",
  ],
  individual_seller: [
    "profile.read",
    "profile.update",
    "products.create",
    "products.update",
    "products.archive",
    "enquiries.read",
    "enquiries.reply",
    "orders.read",
    "orders.manage",
    "inspections.request",
    "subscriptions.manage",
    "ai.use",
  ],
  business_seller: [
    "profile.read",
    "profile.update",
    "products.create",
    "products.update",
    "products.archive",
    "enquiries.read",
    "enquiries.reply",
    "orders.read",
    "orders.manage",
    "inspections.request",
    "subscriptions.manage",
    "employees.manage",
    "business.manage",
    "ai.use",
  ],
  business_employee: ["profile.read", "enquiries.read", "orders.read"],
  service_partner: [
    "profile.read",
    "profile.update",
    "inspections.perform",
    "partner.manage",
  ],
  super_admin: ["*"],
};

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  hasMore?: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiErrorBody;
  meta?: ApiMeta;
}

export function formatInr(paise: number): string {
  return new Intl.NumberFormat(DEFAULT_LOCALE, {
    style: "currency",
    currency: DEFAULT_CURRENCY,
    maximumFractionDigits: 0,
  }).format(paise / 100);
}

export const CONDITION_LABELS: Record<ProductCondition, string> = {
  like_new: "Like new",
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
};
