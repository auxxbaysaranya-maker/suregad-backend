import { Brand, Category, Product } from "../models/catalog.model";
import { Subscription, SubscriptionPlan } from "../models/commerce.model";
import { Business, BuyerProfile, PartnerProfile, SellerProfile } from "../models/profiles.model";
import { User } from "../models/user.model";
import { ensureEmailUser } from "../integrations/firebase";
import { storageMode, uploadRemoteImage } from "../integrations/storage";
import { hashPassword } from "../common/crypto";
import { logger } from "../config/logger";
import { seedSystemData } from "./run";

export const demoPassword = "123456";

const accounts = [
  { email: "admin@suregad.dev", name: "SureGad Admin", roles: ["buyer", "super_admin"] },
  { email: "seller@suregad.dev", name: "Anita Seller", roles: ["buyer", "individual_seller"] },
  { email: "store@suregad.dev", name: "Kochi Refurb Store", roles: ["buyer", "business_seller"] },
  { email: "partner@suregad.dev", name: "Ravi Inspector", roles: ["buyer", "service_partner"] },
  { email: "buyer@suregad.dev", name: "Meera Buyer", roles: ["buyer"] },
] as const;

const places = [
  { city: "Kochi", district: "Ernakulam", pincode: "682001", lng: 76.2673, lat: 9.9312 },
  { city: "Thiruvananthapuram", district: "Thiruvananthapuram", pincode: "695001", lng: 76.9366, lat: 8.5241 },
  { city: "Kozhikode", district: "Kozhikode", pincode: "673001", lng: 75.7804, lat: 11.2588 },
  { city: "Thrissur", district: "Thrissur", pincode: "680001", lng: 76.2144, lat: 10.5276 },
  { city: "Kollam", district: "Kollam", pincode: "691001", lng: 76.6141, lat: 8.8932 },
];

const phones = [
  ["apple", "Apple", "iPhone 13"],
  ["samsung", "Samsung", "Galaxy S23"],
  ["google", "Google", "Pixel 7"],
  ["oneplus", "OnePlus", "Nord CE 3"],
  ["xiaomi", "Xiaomi", "Redmi Note 13"],
  ["vivo", "Vivo", "V29"],
  ["oppo", "Oppo", "Reno 11"],
  ["realme", "Realme", "12 Pro"],
  ["nothing", "Nothing", "Phone 2a"],
] as const;

const laptops = [
  ["apple", "Apple", "MacBook Air M2"],
  ["dell", "Dell", "Inspiron 14"],
  ["hp", "HP", "Pavilion 15"],
  ["lenovo", "Lenovo", "ThinkPad E14"],
  ["asus", "ASUS", "Vivobook 15"],
  ["acer", "Acer", "Aspire 5"],
] as const;

const phoneImages = [
  "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1510557880182-3d4d3cba35a5?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1601784551446-20c9e07cdbdb?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1580910051074-3eb694886505?auto=format&fit=crop&w=1200&q=80",
];

const laptopImages = [
  "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1511385348-a52b4a160dc2?auto=format&fit=crop&w=1200&q=80",
  "https://images.unsplash.com/photo-1525547719571-a2d4ac8945e2?auto=format&fit=crop&w=1200&q=80",
];

const conditions = ["like_new", "excellent", "good", "fair"] as const;
const colours = ["Black", "Blue", "Silver", "Green", "White"];

async function refreshDemoImages() {
  if (storageMode() !== "cloudinary") return;
  const sample = await Product.findOne({ slug: "demo-001" }).select("images");
  if (sample?.images?.[0]?.url?.includes("res.cloudinary.com")) return;
  const phoneAssets = await imageMap(phoneImages, "phone");
  const laptopAssets = await imageMap(laptopImages, "laptop");
  const products = await Product.find({ slug: /^demo-/ });
  for (const product of products) {
    const index = Number(product.slug.replace("demo-", ""));
    const laptop = index > 70;
    const source = laptop ? laptopImages[index % laptopImages.length] : phoneImages[index % phoneImages.length];
    const image = (laptop ? laptopAssets : phoneAssets).get(source!);
    if (!image) continue;
    product.set("images", [{ key: image.key, url: image.url, sort: 0 }]);
    await product.save();
  }
  logger.info("Uploaded demo photographs to Cloudinary.");
}

async function imageMap(urls: string[], folder: string) {
  const mapped = new Map<string, { key: string; url: string }>();
  for (const [index, url] of urls.entries()) {
    mapped.set(url, await uploadRemoteImage(url, `suregad/demo/${folder}-${index + 1}`));
  }
  return mapped;
}

export async function seedDemoData(): Promise<void> {
  await seedSystemData();
  const users = new Map<string, { id: string; email: string }>();
  for (const account of accounts) {
    const firebaseUid = (await ensureEmailUser({ email: account.email, password: demoPassword, name: account.name })) || `dev:${account.email}`;
    const user = await User.findOneAndUpdate(
      { email: account.email },
      {
        $set: {
          firebaseUid,
          email: account.email,
          displayName: account.name,
          roles: [...account.roles],
          status: "active",
          passwordHash: hashPassword(demoPassword),
          notificationPreferences: { inApp: true, email: true, sms: false, whatsapp: false, push: true },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await BuyerProfile.updateOne({ userId: user._id }, { $setOnInsert: { userId: user._id, addresses: [], wishlist: [] } }, { upsert: true });
    users.set(account.email, { id: String(user._id), email: account.email });
  }

  const seller = users.get("seller@suregad.dev")!;
  const store = users.get("store@suregad.dev")!;
  const partner = users.get("partner@suregad.dev")!;
  const kochi = places[0]!;
  await SellerProfile.updateOne(
    { userId: seller.id },
    {
      $set: {
        slug: "anita-seller",
        displayName: "Anita Seller",
        bio: "Individual seller in Kochi. Demo account.",
        city: kochi.city,
        district: kochi.district,
        verified: true,
        location: { type: "Point", coordinates: [kochi.lng, kochi.lat] },
      },
    },
    { upsert: true },
  );
  const business = await Business.findOneAndUpdate(
    { slug: "kochi-refurb-store" },
    {
      $set: {
        ownerId: store.id,
        name: "Kochi Refurb Store",
        slug: "kochi-refurb-store",
        email: store.email,
        phone: "+910000000000",
        description: "Demo refurbished-electronics store.",
        verificationStatus: "approved",
        location: { type: "Point", coordinates: [kochi.lng, kochi.lat] },
      },
    },
    { upsert: true, new: true },
  );
  const growth = await SubscriptionPlan.findOne({ code: "business_growth" });
  if (growth && business) {
    await Subscription.updateOne(
      { subjectType: "business", subjectId: business._id, status: "active" },
      {
        $setOnInsert: {
          subjectType: "business",
          subjectId: business._id,
          planId: growth._id,
          status: "active",
          interval: "monthly",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      },
      { upsert: true },
    );
  }
  await PartnerProfile.updateOne(
    { userId: partner.id },
    {
      $set: {
        name: "Ravi Inspector",
        email: partner.email,
        phone: "+910000000001",
        categories: ["smartphones", "laptops"],
        experienceYears: 4,
        verificationStatus: "approved",
        agreementAcceptedAt: new Date(),
        serviceRadiusKm: 25,
        location: { type: "Point", coordinates: [kochi.lng, kochi.lat] },
        availability: { paused: false, hours: "09:00-18:00" },
      },
    },
    { upsert: true },
  );

  const existing = await Product.countDocuments({ slug: /^demo-/ });
  if (existing >= 100) {
    await refreshDemoImages();
    logger.info({ accounts: accounts.map((account) => account.email) }, "Demo catalogue already has 100 products.");
    return;
  }
  if (existing > 0) await Product.deleteMany({ slug: /^demo-/ });

  const [phoneCategory, laptopCategory] = await Promise.all([
    Category.findOne({ slug: "smartphones" }),
    Category.findOne({ slug: "laptops" }),
  ]);
  if (!phoneCategory || !laptopCategory) throw new Error("Categories are missing. Run the system seed first.");
  const brands = await Brand.find({ active: true });
  const brandBySlug = new Map(brands.map((brand) => [brand.slug, brand]));
  const phoneAssets = await imageMap(phoneImages, "phone");
  const laptopAssets = await imageMap(laptopImages, "laptop");

  const docs = [];
  for (let index = 1; index <= 100; index += 1) {
    const laptop = index > 70;
    const catalog = laptop ? laptops[(index - 71) % laptops.length]! : phones[(index - 1) % phones.length]!;
    const brand = brandBySlug.get(catalog[0]);
    const place = places[index % places.length]!;
    const source = laptop ? laptopImages[index % laptopImages.length]! : phoneImages[index % phoneImages.length]!;
    const image = (laptop ? laptopAssets : phoneAssets).get(source)!;
    const storageGb = laptop ? [256, 512, 1024][index % 3]! : [64, 128, 256][index % 3]!;
    const ramGb = laptop ? [8, 16, 32][index % 3]! : [4, 6, 8][index % 3]!;
    const condition = conditions[index % conditions.length]!;
    const sellerIsStore = index % 2 === 0;
    docs.push({
      sellerUserId: sellerIsStore ? store.id : seller.id,
      sellerType: sellerIsStore ? "business" : "individual",
      businessId: sellerIsStore ? business?._id : undefined,
      categoryId: laptop ? laptopCategory._id : phoneCategory._id,
      categorySlug: laptop ? "laptops" : "smartphones",
      brandId: brand?._id,
      title: `${catalog[2]} ${storageGb}GB ${condition.replace("_", " ")} ${index}`,
      slug: `demo-${String(index).padStart(3, "0")}`,
      description: `Demo listing ${index} for a used ${catalog[1]} ${catalog[2]}. The photograph is a public sample uploaded for the catalogue. This is not a live seller offer.`,
      condition,
      pricePaise: (laptop ? 25000 : 9000) * 100 + index * 50000,
      specs: laptop
        ? { brand: catalog[1], model: catalog[2], processor: "Intel Core i5", ramGb, storageGb, displayInches: 14, os: "Windows 11" }
        : { brand: catalog[1], model: catalog[2], storageGb, ramGb, colour: colours[index % colours.length], os: catalog[0] === "apple" ? "iOS" : "Android" },
      images: [{ key: image.key, url: image.url, sort: 0 }],
      city: place.city,
      district: place.district,
      state: "Kerala",
      pincode: place.pincode,
      location: { type: "Point", coordinates: [place.lng, place.lat] },
      status: "active",
      inventory: { state: "available" },
    });
  }
  await Product.insertMany(docs, { ordered: false });
  logger.info("Inserted 100 demo products.");
}
