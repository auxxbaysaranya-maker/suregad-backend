import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import crypto from "crypto";
import { createApp } from "../src/app";
import { connectDb } from "../src/config/db";
import { seedSystemData } from "../src/seed/run";
import { signDevToken } from "../src/integrations/firebase";
import { mockPaymentSignature } from "../src/integrations/payments";
import { scoreInspection } from "../src/services/scoring.service";
import { User } from "../src/models/user.model";
import { Product } from "../src/models/catalog.model";
import { InspectionPlan } from "../src/models/inspection.model";

const app = createApp();
let mongo: MongoMemoryServer | undefined;
let databaseReady = false;

async function login(uid: string, name: string, email?: string) {
  const token = signDevToken({ uid, name, email });
  const response = await request(app).post("/api/v1/auth/session").send({ token });
  expect(response.status).toBe(200);
  return { token, user: response.body.data };
}

beforeAll(async () => {
  try {
    mongo = await MongoMemoryServer.create();
    await connectDb(mongo.getUri());
    await seedSystemData();
    await Product.init();
    databaseReady = true;
  } catch (error) {
    console.warn("MongoDB test instance did not start. Database integration cases will be skipped.", error);
  }
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

describe("SureGad platform", () => {
  it("scores critical inspection failures separately from the numeric score", () => {
    const score = scoreInspection(
      [
        { key: "display", label: "Display", critical: true, weight: 3 },
        { key: "speaker", label: "Speaker", critical: false, weight: 1 },
      ],
      [
        { key: "display", result: "failed" },
        { key: "speaker", result: "passed" },
      ],
    );
    expect(score.verdict).toBe("critical_failure");
    expect(score.score).toBe(25);
    expect(score.criticalFailures).toContain("Display");
  });

  it("reports health without pretending integrations are configured", async () => {
    const health = await request(app).get("/api/v1/health");
    expect(health.body.success).toBe(true);
    const status = await request(app).get("/api/v1/system/status");
    expect(status.body.data.payments).toBe("mock");
    expect(status.body.data.firebaseAdmin).toBe(false);
    expect(status.body.data.ai).toBe(false);
  });

  it("rejects firebase-looking tokens when admin SDK is not configured", async () => {
    const response = await request(app).post("/api/v1/auth/session").send({ token: "firebase.not.real" });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("AUTH_NOT_CONFIGURED");
  });

  it("enforces listing limits, search, checkout, webhooks, inspections and reviews", async (context) => {
    if (!databaseReady) context.skip();
    const buyer = await login("buyer-1", "Asha Buyer", "asha@example.com");
    const seller = await login("seller-1", "Ravi Seller", "ravi@example.com");
    const adminSession = await login("admin-1", "Admin", "admin@suregad.com");
    await User.updateOne({ _id: adminSession.user.id }, { $addToSet: { roles: "super_admin" } });

    const denied = await request(app).get("/api/v1/admin/metrics").set("Authorization", `Bearer ${buyer.token}`);
    expect(denied.status).toBe(403);

    await request(app)
      .post("/api/v1/auth/seller")
      .set("Authorization", `Bearer ${seller.token}`)
      .send({ displayName: "Ravi Mobiles", city: "Kochi", district: "Ernakulam", state: "Kerala" })
      .expect(200);

    const listingBody = {
      categorySlug: "smartphones",
      sellerType: "individual",
      title: "Pixel 8 128GB Excellent",
      description: "Unboxed device with original cable. No inspection has been done yet.",
      condition: "excellent",
      pricePaise: 2800000,
      specs: { brand: "Google", model: "Pixel 8", storageGb: 128, ramGb: 8, colour: "Hazel" },
      imageKeys: [],
      location: {
        city: "Kochi",
        district: "Ernakulam",
        state: "Kerala",
        pincode: "682001",
        coordinates: { lat: 9.9312, lng: 76.2673 },
      },
      imei: "490154203237518",
    };

    const created = [];
    for (const title of ["Pixel 8 128GB Excellent", "Pixel 8 128GB Spare"]) {
      const response = await request(app)
        .post("/api/v1/products")
        .set("Authorization", `Bearer ${seller.token}`)
        .send({ ...listingBody, title, imei: undefined });
      expect(response.status).toBe(201);
      created.push(response.body.data);
    }
    const limited = await request(app)
      .post("/api/v1/products")
      .set("Authorization", `Bearer ${seller.token}`)
      .send({ ...listingBody, title: "Pixel 8 128GB Third", imei: undefined });
    expect(limited.status).toBe(403);
    expect(limited.body.error.code).toBe("MONTHLY_LISTING_LIMIT");

    const duplicate = await request(app)
      .post("/api/v1/products")
      .set("Authorization", `Bearer ${seller.token}`)
      .send(listingBody);
    expect(duplicate.status).toBe(403);

    await request(app)
      .patch(`/api/v1/admin/listings/${created[0].id}`)
      .set("Authorization", `Bearer ${adminSession.token}`)
      .send({ status: "active" })
      .expect(200);

    const search = await request(app).get("/api/v1/products").query({ q: "Pixel", city: "Kochi", inspected: "false" });
    expect(search.body.data.some((item: { slug: string }) => item.slug === created[0].slug)).toBe(true);
    expect(search.body.data[0].inspection.inspected).toBe(false);

    // Individuals sell in chat only; the checkout below runs on a business listing.
    await request(app)
      .post("/api/v1/cart/items")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({ productId: created[0].id })
      .expect(409);
    await Product.updateOne({ _id: created[0].id }, { sellerType: "business" });
    await request(app)
      .post("/api/v1/cart/items")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({ productId: created[0].id })
      .expect(200);
    const checkout = await request(app)
      .post("/api/v1/checkout")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({ fulfillment: "pickup", productIds: [created[0].id] });
    expect(checkout.status).toBe(200);
    const gatewayOrderId = checkout.body.data.payment.gatewayOrderId as string;
    const paymentId = `pay_${created[0].id}`;
    const signature = mockPaymentSignature(gatewayOrderId, paymentId);
    const verified = await request(app)
      .post("/api/v1/payments/verify")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({ gatewayOrderId, gatewayPaymentId: paymentId, signature });
    expect(verified.status).toBe(200);
    const again = await request(app)
      .post("/api/v1/cart/items")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({ productId: created[0].id });
    expect(again.status).toBe(409);

    const badReview = await request(app)
      .post("/api/v1/reviews")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({ targetType: "product", targetId: created[0].id, rating: 5, body: "Great", orderId: checkout.body.data.orderId });
    expect(badReview.status).toBe(403);

    await request(app)
      .patch(`/api/v1/seller/orders/${checkout.body.data.orderId}/suborders/${(await request(app).get("/api/v1/seller/orders").set("Authorization", `Bearer ${seller.token}`)).body.data[0].subOrders[0]._id}`)
      .set("Authorization", `Bearer ${seller.token}`)
      .send({ status: "delivered" });

    const partner = await login("partner-1", "Inspector Nila", "nila@example.com");
    await request(app)
      .post("/api/v1/auth/partner")
      .set("Authorization", `Bearer ${partner.token}`)
      .send({
        name: "Nila Inspections",
        phone: "9876543210",
        email: "nila@example.com",
        categories: ["smartphones"],
        experienceYears: 4,
        serviceRadiusKm: 20,
        address: {
          name: "Nila",
          phone: "9876543210",
          line1: "MG Road",
          city: "Kochi",
          district: "Ernakulam",
          state: "Kerala",
          pincode: "682016",
          coordinates: { lat: 9.94, lng: 76.28 },
        },
        agreementAccepted: true,
      })
      .expect(200);
    const partnerProfileId = (await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${partner.token}`)).body.data.partner._id;
    await request(app)
      .patch(`/api/v1/admin/partners/${partnerProfileId}/verification`)
      .set("Authorization", `Bearer ${adminSession.token}`)
      .send({ status: "approved" })
      .expect(200);

    await request(app)
      .patch(`/api/v1/admin/listings/${created[1].id}`)
      .set("Authorization", `Bearer ${adminSession.token}`)
      .send({ status: "active" })
      .expect(200);

    const inspection = await request(app)
      .post("/api/v1/inspections/checkout")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({ productId: created[1].id, planCode: "phone_basic", publishOnListing: true });
    expect(inspection.status).toBe(200);
    const inspectionOrder = inspection.body.data.payment.gatewayOrderId as string;
    const inspectionPayment = "pay_inspection_1";
    await request(app)
      .post("/api/v1/payments/verify")
      .set("Authorization", `Bearer ${buyer.token}`)
      .send({
        gatewayOrderId: inspectionOrder,
        gatewayPaymentId: inspectionPayment,
        signature: mockPaymentSignature(inspectionOrder, inspectionPayment),
      })
      .expect(200);

    const jobs = await request(app).get("/api/v1/partner/jobs").set("Authorization", `Bearer ${partner.token}`);
    expect(jobs.body.data.jobs.length).toBeGreaterThan(0);
    const requestId = jobs.body.data.jobs[0]._id as string;
    await request(app).post(`/api/v1/partner/jobs/${requestId}/accept`).set("Authorization", `Bearer ${partner.token}`).expect(200);
    const plan = await InspectionPlan.findOne({ code: "phone_basic" });
    const incomplete = await request(app)
      .post(`/api/v1/partner/jobs/${requestId}/report`)
      .set("Authorization", `Bearer ${partner.token}`)
      .send({ results: [{ key: "display", result: "passed" }] });
    expect(incomplete.status).toBe(400);
    const results = plan!.checklist.map((item, index) => ({
      key: item.key,
      result: item.key === "activation_lock" ? "failed" : index % 7 === 0 ? "not_applicable" : "passed",
    }));
    const submitted = await request(app)
      .post(`/api/v1/partner/jobs/${requestId}/report`)
      .set("Authorization", `Bearer ${partner.token}`)
      .send({ results, summary: "Activation lock is on." });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data.verdict).toBe("critical_failure");
    const published = await request(app).get(`/api/v1/inspection-reports/${submitted.body.data._id}`);
    expect(published.status).toBe(200);
    expect(published.body.data.criticalFailures.length).toBeGreaterThan(0);
    expect(published.body.data.guarantee).toBe(false);

    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_test_1",
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_webhook", order_id: "missing_order" } } },
      }),
    );
    const webhookSig = crypto.createHmac("sha256", "whsec-test-secret").update(raw).digest("hex");
    const webhook = await request(app)
      .post("/api/v1/payments/webhooks/razorpay")
      .set("x-razorpay-signature", webhookSig)
      .set("Content-Type", "application/json")
      .send(raw.toString());
    expect(webhook.status).toBe(404);
    const replay = await request(app)
      .post("/api/v1/payments/webhooks/razorpay")
      .set("x-razorpay-signature", webhookSig)
      .set("Content-Type", "application/json")
      .send(raw.toString());
    expect(replay.body.data.duplicate).toBe(true);

    const ai = await request(app).post("/api/v1/ai/listing").set("Authorization", `Bearer ${seller.token}`).send({ specs: { model: "Pixel 8" } });
    expect(ai.status).toBe(503);
    expect(ai.body.error.code).toBe("AI_NOT_CONFIGURED");
  });
});
