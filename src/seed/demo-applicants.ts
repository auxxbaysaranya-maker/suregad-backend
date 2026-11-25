import { User } from "../models/user.model";
import { Business, BuyerProfile, PartnerProfile, SellerProfile } from "../models/profiles.model";
import { hashPassword, randomId } from "../common/crypto";
import { storeServerFile } from "../integrations/storage";
import { nextCode } from "../models/showroom.model";
import { notify } from "../services/notification.service";
import { logger } from "../config/logger";

/**
 * Two full demo applicants for the admin panel:
 *   seller@suregad.com  — showroom seller with a complete, submitted application
 *   partner@suregad.com — service partner with a complete, submitted application
 * Both use password 123456 (panel sign-in) and wait for a super admin to review them.
 * Documents are clearly marked SAMPLE so reviewers never mistake them for real KYC.
 */
export const DEMO_APPLICANT_PASSWORD = "123456";

export function sampleDocument(title: string, lines: string[]): Buffer {
  const rows = lines.map((line, index) => `<text x="60" y="${250 + index * 44}" font-size="26" fill="#2a2b4d">${line}</text>`).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700">
<rect width="1000" height="700" fill="#f7f6fc"/>
<rect x="20" y="20" width="960" height="660" rx="28" fill="#fff" stroke="#d4cdfe" stroke-width="4"/>
<rect x="20" y="20" width="960" height="120" rx="28" fill="#3a3fe0"/>
<text x="60" y="98" font-family="Arial" font-size="40" font-weight="700" fill="#fff">${title}</text>
<g font-family="Arial">${rows}</g>
<text x="500" y="600" text-anchor="middle" font-family="Arial" font-size="56" font-weight="800" fill="#e0434d" opacity="0.35" transform="rotate(-12 500 600)">SAMPLE — DEMO ACCOUNT</text>
</svg>`,
  );
}

async function upload(prefix: string, userId: string, title: string, lines: string[]) {
  const key = `private/${prefix}/${userId}/${randomId()}.svg`;
  await storeServerFile(key, sampleDocument(title, lines), "image/svg+xml");
  return key;
}

async function ensureUser(email: string, name: string, role: string) {
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ firebaseUid: `dev:${email}`, email, displayName: name, roles: ["buyer", role], passwordHash: hashPassword(DEMO_APPLICANT_PASSWORD), status: "active" });
  } else {
    if (!user.roles.includes(role)) user.roles.push(role);
    user.passwordHash = hashPassword(DEMO_APPLICANT_PASSWORD);
    user.status = "active";
    await user.save();
  }
  await BuyerProfile.updateOne({ userId: user._id }, { $setOnInsert: { userId: user._id, addresses: [], wishlist: [] } }, { upsert: true });
  return user;
}

async function tellAdmins(title: string, body: string, data: Record<string, unknown>) {
  const admins = await User.find({ roles: "super_admin", status: "active" }).select("_id");
  await Promise.all(admins.map((admin) => notify({ userId: String(admin._id), event: "application.submitted", title, body, data })));
}

export async function ensureDemoApplicants(options: { reset?: boolean } = {}) {
  /* ---------- showroom seller ---------- */
  const seller = await ensureUser("seller@suregad.com", "Anil Kumar", "business_seller");
  const sellerId = String(seller._id);
  let business = await Business.findOne({ ownerId: seller._id, deletedAt: null });
  if (!business || options.reset) {
    const docs = [
      { kind: "owner_id", name: "Owner ID proof — Aadhaar (sample)", key: await upload("business_document", sellerId, "Owner ID proof", ["Name: Anil Kumar", "ID type: Aadhaar (masked) XXXX XXXX 4821", "Issued: Government of India"]) },
      { kind: "address_proof", name: "Shop rent agreement (sample)", key: await upload("business_document", sellerId, "Business address proof", ["Rent agreement — TechHub Mobiles & Laptops", "Ground floor, Marine Drive, Kochi 682031", "Valid till: 2028"]) },
      { kind: "gst_certificate", name: "GST registration certificate (sample)", key: await upload("business_document", sellerId, "GST registration certificate", ["GSTIN: 32AAKCT4821M1Z5", "Legal name: TechHub Mobiles & Laptops", "State: Kerala (32)"]) },
      { kind: "shop_photo", name: "Showroom front photo (sample)", key: await upload("business_document", sellerId, "Showroom photo", ["Front of shop with signboard", "TechHub Mobiles & Laptops, Marine Drive"]) },
    ];
    const fields = {
      ownerId: seller._id,
      name: "TechHub Mobiles & Laptops",
      slug: `techhub-mobiles-laptops-${sellerId.slice(-4)}`,
      owner: { name: "Anil Kumar", email: "seller@suregad.com", mobile: "+91 98470 12345", alternatePhone: "+91 484 2350000" },
      businessType: "proprietorship",
      description: "Certified pre-owned and refurbished smartphones and laptops in Kochi since 2016. Every device is tested on our bench and sold with a showroom warranty.",
      tagline: "Tested, warrantied, ready to use",
      yearEstablished: 2016,
      email: "seller@suregad.com",
      phone: "+91 484 2350000",
      gstin: "32AAKCT4821M1Z5",
      pan: "AAKCT4821M",
      registrationNumber: "KL-EKM-SE-2016-04821",
      address: { label: "Showroom", line1: "Ground floor, Bay View Plaza, Marine Drive", line2: "Near GCDA Complex", city: "Kochi", district: "Ernakulam", state: "Kerala", pincode: "682031", coordinates: { lat: 9.9816, lng: 76.2755 } },
      location: { type: "Point", coordinates: [76.2755, 9.9816] },
      hours: "Mon–Sat 10:00–20:30, Sun 11:00–17:00",
      profile: { categories: ["smartphones", "laptops"], brands: ["Apple", "Samsung", "OnePlus", "Dell", "HP", "Lenovo"], conditions: ["used", "refurbished", "new"], physicalShowroom: true },
      social: { website: "https://example.com/techhub", instagram: "@techhub.kochi", whatsapp: "+91 98470 12345" },
      policies: { warranty: "6 months showroom warranty on refurbished devices.", returns: "7-day return if the device doesn't match the listing.", delivery: "Same-day delivery within Kochi city.", returnWindowDays: 7 },
      documents: docs.map((doc) => ({ ...doc, status: "pending", uploadedAt: new Date() })),
      verificationStatus: "submitted",
      submittedAt: new Date(),
      onboardingStep: 5,
      statusHistory: [
        { status: "draft", note: "Application started", by: seller._id, at: new Date(Date.now() - 2 * 86400000) },
        { status: "submitted", note: "Application submitted", by: seller._id, at: new Date() },
      ],
      reviewNote: undefined,
      rejectionReason: undefined,
    };
    if (business) {
      business.set(fields);
      if (!business.code) business.code = await nextCode("SH");
      await business.save();
    } else {
      business = await Business.create({ ...fields, code: await nextCode("SH") });
    }
    await SellerProfile.updateOne(
      { userId: seller._id },
      { $set: { displayName: "TechHub Mobiles & Laptops", city: "Kochi", district: "Ernakulam", location: { type: "Point", coordinates: [76.2755, 9.9816] } }, $setOnInsert: { userId: seller._id, slug: `seller-${sellerId.slice(-6)}` } },
      { upsert: true },
    );
    await tellAdmins("Showroom application", `${business.name} (${business.code}) is waiting for review.`, { businessId: String(business._id) });
  }

  /* ---------- service partner ---------- */
  const partnerUser = await ensureUser("partner@suregad.com", "Divya Menon", "service_partner");
  const partnerId = String(partnerUser._id);
  let partner = await PartnerProfile.findOne({ userId: partnerUser._id });
  if (!partner || options.reset) {
    const documents = [
      { kind: "id_proof", name: "ID proof — Aadhaar (sample)", key: await upload("partner_document", partnerId, "Partner ID proof", ["Name: Divya Menon", "ID type: Aadhaar (masked) XXXX XXXX 7310"]), status: "pending" },
      { kind: "qualification", name: "Diploma in Electronics (sample)", key: await upload("partner_document", partnerId, "Qualification certificate", ["Diploma in Electronics Engineering", "Govt. Polytechnic, Kalamassery — 2014"]), status: "pending" },
      { kind: "experience", name: "Experience letter — 8 years (sample)", key: await upload("partner_document", partnerId, "Experience certificate", ["Senior service technician, 2016–2024", "Smartphone & laptop board-level repair"]), status: "pending" },
      { kind: "certification", name: "Apple & Samsung service training (sample)", key: await upload("partner_document", partnerId, "Training certificate", ["Authorised service training", "iPhone diagnostics, Samsung Galaxy repair"]), status: "pending" },
    ];
    const fields = {
      userId: partnerUser._id,
      name: "Divya Menon",
      phone: "+91 94470 56789",
      email: "partner@suregad.com",
      address: { label: "Home", line1: "12/340, Edappally North", city: "Kochi", district: "Ernakulam", state: "Kerala", pincode: "682024", coordinates: { lat: 10.0261, lng: 76.3125 } },
      categories: ["smartphones", "laptops"],
      experienceYears: 8,
      documents,
      agreementAcceptedAt: new Date(),
      verificationStatus: "pending",
      serviceRadiusKm: 20,
      location: { type: "Point", coordinates: [76.3125, 10.0261] },
      availability: { paused: false, hours: "09:00-19:00" },
    };
    if (partner) {
      partner.set(fields);
      await partner.save();
    } else {
      partner = await PartnerProfile.create(fields);
    }
    await tellAdmins("Service partner application", "Divya Menon applied as a phone & laptop inspection partner.", { partnerId: String(partner._id) });
  }
  logger.info({ seller: "seller@suregad.com", partner: "partner@suregad.com" }, "Demo applicants are ready (password 123456), waiting for super admin review.");
  return { businessId: String(business!._id), partnerId: String(partner!._id) };
}

/**
 * With local-disk storage (no Cloudinary/S3), a fresh server has none of the demo files.
 * Regenerate documents marked "(sample)" so reviewers can still open them.
 */
export async function restoreDemoDocuments(): Promise<void> {
  const { readLocalUpload, storageMode } = await import("../integrations/storage");
  if (storageMode() !== "local") return;
  const sample = { documents: { $elemMatch: { name: / (sample)$/, key: /.svg$/ } } };
  const [businesses, partners] = await Promise.all([Business.find(sample).select("documents"), PartnerProfile.find(sample).select("documents")]);
  let restored = 0;
  for (const doc of [...businesses.flatMap((row) => row.documents), ...partners.flatMap((row) => row.documents)]) {
    if (!doc.key?.endsWith(".svg") || !/ (sample)$/.test(String(doc.name))) continue;
    try {
      await readLocalUpload(doc.key);
    } catch {
      await storeServerFile(doc.key, sampleDocument(String(doc.name || "Document").replace(/ \(sample\)$/, ""), ["Demo account document", "Generated by SureGad for review testing"]), "image/svg+xml");
      restored += 1;
    }
  }
  if (restored) logger.info({ restored }, "Restored demo applicant sample documents");
}
