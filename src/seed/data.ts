import { ROLE_SEEDS } from "../shared";

const phoneChecks = [
  ["imei", "IMEI", "identity", true],
  ["model", "Device model", "identity", true],
  ["serial", "Serial number", "identity", false],
  ["display", "Display", "display", true],
  ["touch", "Touchscreen", "display", true],
  ["battery", "Battery", "power", true],
  ["charging", "Charging", "power", true],
  ["speaker", "Speaker", "audio", false],
  ["microphone", "Microphone", "audio", false],
  ["camera", "Camera", "camera", false],
  ["buttons", "Buttons", "hardware", false],
  ["fingerprint", "Fingerprint", "biometrics", false],
  ["face", "Face unlock", "biometrics", false],
  ["wifi", "Wi-Fi", "connectivity", false],
  ["bluetooth", "Bluetooth", "connectivity", false],
  ["network", "Network", "connectivity", true],
  ["sensors", "Sensors", "hardware", false],
  ["physical", "Physical condition", "condition", false],
  ["water", "Water damage indicators", "condition", true],
  ["repairs", "Repair signs", "condition", false],
  ["activation_lock", "Activation lock", "security", true],
  ["reset", "Device reset readiness", "security", false],
] as const;

const laptopChecks = [
  ["model", "Model", "identity", true],
  ["serial", "Serial number", "identity", true],
  ["processor", "Processor", "performance", false],
  ["ram", "RAM", "performance", false],
  ["storage", "Storage", "performance", false],
  ["display", "Display", "display", true],
  ["keyboard", "Keyboard", "input", false],
  ["touchpad", "Touchpad", "input", false],
  ["battery", "Battery", "power", true],
  ["charging", "Charging", "power", true],
  ["ports", "Ports", "hardware", false],
  ["webcam", "Webcam", "audio", false],
  ["microphone", "Microphone", "audio", false],
  ["speakers", "Speakers", "audio", false],
  ["wifi", "Wi-Fi", "connectivity", false],
  ["bluetooth", "Bluetooth", "connectivity", false],
  ["graphics", "Graphics", "performance", false],
  ["thermal", "Thermal condition", "performance", false],
  ["performance", "Performance", "performance", false],
  ["physical", "Physical condition", "condition", false],
  ["firmware_lock", "BIOS / firmware lock", "security", true],
  ["os_activation", "OS activation", "security", false],
] as const;

function checklist(rows: readonly (readonly [string, string, string, boolean])[]) {
  return rows.map(([key, label, group, critical]) => ({
    key,
    label,
    group,
    critical,
    weight: critical ? 3 : 1,
  }));
}

export const roleSeeds = Object.entries(ROLE_SEEDS).map(([key, permissions]) => ({
  key,
  name: key.replaceAll("_", " "),
  permissions,
  system: true,
}));

export const categorySeeds = [
  { slug: "smartphones", name: "Smartphones", specSchemaKey: "smartphone", sort: 1 },
  { slug: "laptops", name: "Laptops", specSchemaKey: "laptop", sort: 2 },
];

export const brandSeeds = [
  ["apple", "Apple", ["smartphones", "laptops"], true],
  ["samsung", "Samsung", ["smartphones"], true],
  ["google", "Google", ["smartphones"], true],
  ["oneplus", "OnePlus", ["smartphones"], true],
  ["xiaomi", "Xiaomi", ["smartphones"], true],
  ["vivo", "Vivo", ["smartphones"], false],
  ["oppo", "Oppo", ["smartphones"], false],
  ["realme", "Realme", ["smartphones"], false],
  ["nothing", "Nothing", ["smartphones"], false],
  ["dell", "Dell", ["laptops"], true],
  ["hp", "HP", ["laptops"], true],
  ["lenovo", "Lenovo", ["laptops"], true],
  ["asus", "ASUS", ["laptops"], true],
  ["acer", "Acer", ["laptops"], false],
].map(([slug, name, categories, popular]) => ({ slug, name, categories, popular, active: true }));

export const planSeeds = [
  {
    code: "individual_free",
    name: "Individual Free",
    audience: "individual",
    monthlyPricePaise: 0,
    annualPricePaise: 0,
    limits: { activeListings: 3, monthlyListings: 2, photosPerListing: 10, employees: 0, listingValidityDays: 30 },
    features: { analytics: "basic" },
    gracePeriodDays: 0,
  },
  {
    code: "business_starter",
    name: "Starter",
    audience: "business",
    monthlyPricePaise: 99900,
    annualPricePaise: 999000,
    limits: { activeListings: 30, monthlyListings: 60, photosPerListing: 12, employees: 1, listingValidityDays: 60 },
    features: { analytics: "standard", bulkUpload: true },
    gracePeriodDays: 3,
  },
  {
    code: "business_growth",
    name: "Growth",
    audience: "business",
    monthlyPricePaise: 249900,
    annualPricePaise: 2499000,
    limits: { activeListings: 150, monthlyListings: 300, photosPerListing: 15, employees: 5, listingValidityDays: 90 },
    features: { analytics: "advanced", bulkUpload: true },
    gracePeriodDays: 5,
  },
  {
    code: "business_enterprise",
    name: "Enterprise",
    audience: "business",
    monthlyPricePaise: 0,
    annualPricePaise: 0,
    limits: { activeListings: 500, monthlyListings: 1000, photosPerListing: 20, employees: 25, listingValidityDays: 180 },
    features: { analytics: "advanced", bulkUpload: true, support: "priority" },
    gracePeriodDays: 7,
    custom: true,
  },
];

const disclaimer =
  "This inspection records the device condition at the time of the visit. It does not guarantee future reliability or remaining lifespan.";

export const inspectionPlanSeeds = [
  {
    code: "phone_basic",
    name: "Basic smartphone",
    categorySlug: "smartphones",
    tier: "basic",
    pricePaise: 30000,
    partnerPayoutPaise: 18000,
    checklist: checklist(phoneChecks),
    disclaimer,
  },
  {
    code: "phone_advanced",
    name: "Advanced smartphone",
    categorySlug: "smartphones",
    tier: "advanced",
    pricePaise: 49900,
    partnerPayoutPaise: 30000,
    checklist: checklist(phoneChecks),
    disclaimer,
  },
  {
    code: "laptop_basic",
    name: "Basic laptop",
    categorySlug: "laptops",
    tier: "basic",
    pricePaise: 49900,
    partnerPayoutPaise: 30000,
    checklist: checklist(laptopChecks),
    disclaimer,
  },
  {
    code: "laptop_advanced",
    name: "Advanced laptop",
    categorySlug: "laptops",
    tier: "advanced",
    pricePaise: 69900,
    partnerPayoutPaise: 42000,
    checklist: checklist(laptopChecks),
    disclaimer,
  },
];

export const platformSeed = {
  commissionBps: 0,
  refundWindowDays: 2,
  cancellationPolicy:
    "Unpaid reservations expire after 15 minutes. Paid cancellations follow the refund window configured by admin and the payment provider's settlement rules.",
  assignmentTimeoutMinutes: 60,
  maxPartnerDistanceKm: 150,
  defaultServiceRadiusKm: 15,
  supportedLocales: ["en", "ml", "hi"],
  defaultLocale: "en",
  homepage: {
    hero: {
      eyebrow: "Kerala · expanding across India",
      title: "Buy verified phones and laptops.",
      subtitle: "Independent partners inspect devices in person before you pay a premium for trust.",
      primaryCta: "Browse devices",
      secondaryCta: "How verification works",
    },
    howItWorks: [
      { title: "Choose a device", body: "Filter by city, condition, specs and whether a report is already published." },
      { title: "Request an inspection", body: "Pay for a checklist plan. A nearby approved partner is offered the job." },
      { title: "Read the report", body: "Scores never hide critical failures. An inspection is a point-in-time record, not a future guarantee." },
    ],
    testimonials: [],
    banners: [],
  },
};
