import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";
import { createApp } from "../src/app";
import { connectDb } from "../src/config/db";
import { seedSystemData } from "../src/seed/run";
import { signDevToken } from "../src/integrations/firebase";
import { mockPaymentSignature } from "../src/integrations/payments";
import { User } from "../src/models/user.model";
import { Product } from "../src/models/catalog.model";
import { Cart, SubscriptionPlan } from "../src/models/commerce.model";
import { Business, PartnerProfile } from "../src/models/profiles.model";
import { InventoryUnit } from "../src/models/showroom.model";
import { expireListings } from "../src/services/selling.service";

const app = createApp();
let mongo: MongoMemoryServer | undefined;
let ready = false;

const call = (method: "get" | "post" | "patch" | "put", path: string, token: string, body?: object) => {
  const req = request(app)[method](`/api/v1${path}`).set("Authorization", `Bearer ${token}`);
  return body ? req.send(body) : req;
};
async function login(uid: string, name: string) {
  const token = signDevToken({ uid, name, email: `${uid}@example.com` });
  const response = await request(app).post("/api/v1/auth/session").send({ token });
  expect(response.status).toBe(200);
  return { token, id: response.body.data.id as string };
}
const body = (userId: string, title: string, extra: object = {}) => ({
  categorySlug: "smartphones",
  title,
  description: "One owner, original box and charger included.",
  condition: "good",
  pricePaise: 2000000,
  specs: { brand: "Google", model: "Pixel 8", storageGb: 128, ramGb: 8, colour: "Hazel" },
  imageKeys: [`public/product_image/${userId}/a.jpg`],
  location: { city: "Kochi", district: "Ernakulam", state: "Kerala", pincode: "682001", coordinates: { lat: 9.9312, lng: 76.2673 } },
  ...extra,
});

describe("individual selling", () => {
  beforeAll(async () => {
    try {
      mongo = await MongoMemoryServer.create();
      await connectDb(mongo.getUri());
      await seedSystemData();
      await Product.init();
      ready = true;
    } catch (error) {
      console.warn("MongoDB test instance did not start.", error);
    }
  }, 180000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it("lists, chats, sells, expires and renews without cart or checkout", async (context) => {
    if (!ready) context.skip();
    const seller = await login("user-a", "Anu");
    const buyer = await login("user-b", "Binu");
    const admin = await login("boss", "Boss");
    await User.updateOne({ _id: admin.id }, { $addToSet: { roles: "super_admin" } });

    // A plain buyer account sees the plan before selling anything.
    const before = (await call("get", "/me/selling", seller.token)).body.data;
    expect(before.canSell).toBe(true);
    expect(before.limits.monthlyListings).toBe(2);
    expect(before.usage.monthlyLeft).toBe(2);

    const noPhoto = await call("post", "/me/selling", seller.token, body(seller.id, "Pixel without photo", { imageKeys: [] }));
    expect(noPhoto.status).toBe(400);
    const stolen = await call("post", "/me/selling", seller.token, body(buyer.id, "Pixel with stolen photo"));
    expect(stolen.status).toBe(400);

    const first = await call("post", "/me/selling", seller.token, body(seller.id, "Pixel first", { imei: "490154203237518" }));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await call("post", "/me/selling", seller.token, body(seller.id, "Pixel second"));
    expect(second.status).toBe(201);
    const third = await call("post", "/me/selling", seller.token, body(seller.id, "Pixel third"));
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe("MONTHLY_LISTING_LIMIT");
    const id = first.body.data.id as string;
    const id2 = second.body.data.id as string;

    // Deleting does not give the month's slot back.
    await call("post", `/products/${id2}/archive`, seller.token).expect(200);
    expect((await call("post", "/me/selling", seller.token, body(seller.id, "Pixel again"))).body.error.code).toBe("MONTHLY_LISTING_LIMIT");

    // Super admin changes the plan; other limits stay as they were.
    await call("patch", "/admin/plans/individual_free", admin.token, { limits: { monthlyListings: 4, listingValidityDays: 10 } }).expect(200);
    const plan = await SubscriptionPlan.findOne({ code: "individual_free" });
    expect(plan!.limits).toMatchObject({ monthlyListings: 4, listingValidityDays: 10, activeListings: 3, photosPerListing: 10 });
    await seedSystemData();
    expect((await SubscriptionPlan.findOne({ code: "individual_free" }))!.limits!.monthlyListings).toBe(4);

    // Validity starts at approval and is not extended by edits.
    await call("patch", `/admin/listings/${id}`, admin.token, { status: "active" }).expect(200);
    const live = await Product.findById(id);
    const days = (live!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(9.9);
    expect(days).toBeLessThan(10.1);
    await call("patch", `/products/${id}`, seller.token, { pricePaise: 1900000 }).expect(200);
    await call("patch", `/admin/listings/${id}`, admin.token, { status: "active" }).expect(200);
    expect((await Product.findById(id))!.expiresAt!.getTime()).toBe(live!.expiresAt!.getTime());

    // No cart, no checkout: not directly, not from an old cart.
    const cart = await call("post", "/cart/items", buyer.token, { productId: id });
    expect(cart.body.error.code).toBe("CHAT_ONLY");
    expect((await call("post", "/checkout", buyer.token, { fulfillment: "pickup", productIds: [id] })).body.error.code).toBe("CHAT_ONLY");
    await Cart.updateOne({ userId: buyer.id }, { $set: { items: [{ productId: id }] } }, { upsert: true });
    expect((await call("get", "/cart", buyer.token)).body.data.items[0].available).toBe(false);
    expect((await call("post", "/checkout", buyer.token, { fulfillment: "pickup" })).body.error.code).toBe("CHAT_ONLY");

    // Chat and offer.
    const chat = (await call("post", "/chat/conversations", buyer.token, { productId: id, message: "Available?" })).body.data.id as string;
    const offer = (await call("post", `/chat/conversations/${chat}/offers`, buyer.token, { amountPaise: 1800000 })).body.data.offer;
    await call("post", `/chat/offers/${offer.id}/respond`, seller.token, { action: "accept" }).expect(200);
    expect((await call("post", "/checkout", buyer.token, { fulfillment: "pickup", offerId: offer.id })).body.error.code).toBe("CHAT_ONLY");
    const messages = (await call("get", `/chat/conversations/${chat}/messages`, buyer.token)).body.data as { body: string }[];
    expect(messages.at(-1)!.body).toContain("pay the seller directly");
    expect(messages.at(-1)!.body).not.toContain("check out");

    // Expiry and renewal.
    await Product.updateOne({ _id: id }, { expiresAt: new Date(Date.now() - 1000) });
    expect(await expireListings()).toBe(1);
    expect((await Product.findById(id))!.status).toBe("expired");
    expect((await request(app).get(`/api/v1/products/${first.body.data.slug}`)).status).toBe(404);
    expect((await call("patch", `/products/${id}`, seller.token, { title: "Swapped device" })).status).toBe(409);
    expect((await call("post", `/me/selling/${id}/renew`, buyer.token)).status).toBe(404);
    await call("post", `/me/selling/${id}/renew`, seller.token).expect(200);
    expect((await call("get", "/me/selling", seller.token)).body.data.usage.monthly).toBe(3);
    expect((await call("post", `/me/selling/${id}/renew`, seller.token)).status).toBe(409);

    // Sold out with a reason.
    expect((await call("post", `/me/selling/${id}/sold`, buyer.token, { reason: "sold_elsewhere" })).status).toBe(404);
    expect((await call("post", `/me/selling/${id}/sold`, seller.token, { reason: "other" })).status).toBe(400);
    const sold = await call("post", `/me/selling/${id}/sold`, seller.token, { reason: "sold_on_suregad", conversationId: chat, pricePaise: 1800000 });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    expect(sold.body.data).toMatchObject({ status: "sold", soldOut: { reason: "sold_on_suregad", pricePaise: 1800000 } });
    expect((await call("get", `/chat/offers/${offer.id}`, buyer.token)).body.data.status).toBe("purchased");
    expect((await call("patch", `/admin/listings/${id}`, admin.token, { status: "active" })).status).toBe(409);
    const publicView = await request(app).get(`/api/v1/products/${first.body.data.slug}`);
    expect(JSON.stringify(publicView.body)).not.toContain("buyerUserId");
    expect(publicView.body.data.product.soldOut).toBeUndefined();

    // The new owner can list the same device, and its history is kept.
    const relist = await call("post", "/me/selling", buyer.token, body(buyer.id, "Pixel resale", { imei: "490154203237518" }));
    expect(relist.status, JSON.stringify(relist.body)).toBe(201);
    await call("patch", `/admin/listings/${relist.body.data.id}`, admin.token, { status: "active" }).expect(200);
    expect((await request(app).get(`/api/v1/products/${relist.body.data.slug}`)).body.data.history).toHaveLength(1);
  });

  it("never goes past the limit when listings are submitted together", async (context) => {
    if (!ready) context.skip();
    const racer = await login("racer", "Racer");
    await call("patch", "/admin/plans/individual_free", (await login("boss", "Boss")).token, { limits: { monthlyListings: 2 } }).expect(200);
    await Promise.all([1, 2, 3, 4].map((n) => call("post", "/me/selling", racer.token, body(racer.id, `Race phone ${n}`)).then((r) => r.status)));
    expect(await Product.countDocuments({ sellerUserId: racer.id })).toBeLessThanOrEqual(2);
  });

  it("opens partner chats with both buyer and seller", async (context) => {
    if (!ready) context.skip();
    const seller = await login("insp-seller", "Sara");
    const buyer = await login("insp-buyer", "Biju");
    const partner = await login("insp-partner", "Nila");
    const admin = await login("boss", "Boss");
    const made = (await call("post", "/me/selling", seller.token, body(seller.id, "Inspect me"))).body.data;
    await call("patch", `/admin/listings/${made.id}`, admin.token, { status: "active" }).expect(200);
    await PartnerProfile.create({ userId: partner.id, name: "Nila", phone: "9876543210", email: "n@example.com", categories: ["smartphones"], serviceRadiusKm: 20, verificationStatus: "approved", location: { type: "Point", coordinates: [76.28, 9.94] } } as never);
    const booked = (await call("post", "/inspections/checkout", buyer.token, { productId: made.id, planCode: "phone_basic" })).body.data;
    const order = booked.payment.gatewayOrderId as string;
    await call("post", "/payments/verify", buyer.token, { gatewayOrderId: order, gatewayPaymentId: "pay_x", signature: mockPaymentSignature(order, "pay_x") }).expect(200);
    await call("post", `/partner/jobs/${booked.requestId}/accept`, partner.token).expect(200);
    for (const [person, role] of [[buyer, "buyer"], [seller, "seller"]] as const) {
      const row = (await call("get", "/me/inspections", person.token)).body.data[0];
      expect(row.role).toBe(role);
      expect(row.conversationId).toBeTruthy();
      await call("post", `/chat/conversations/${row.conversationId}/messages`, person.token, { body: "When can you come?" }).expect(201);
      expect((await call("get", `/chat/conversations/${row.conversationId}`, person.token)).body.data.other.id).toBe(partner.id);
    }
    expect((await call("get", "/chat/conversations?box=inspection", partner.token)).body.data).toHaveLength(2);
  });

  it("lets a showroom mark sold out and publish again", async (context) => {
    if (!ready) context.skip();
    const owner = await login("shop", "Shop");
    await User.updateOne({ _id: owner.id }, { $addToSet: { roles: "business_seller" } });
    expect((await call("post", "/me/selling", owner.token, body(owner.id, "Sneaky"))).body.error.code).toBe("USE_SELLER_HUB");
    const business = await Business.create({ ownerId: owner.id, name: "Shop", slug: "shop-1", phone: "9876543210", email: "s@example.com", verificationStatus: "approved" } as never);
    const category = (await Product.findOne())!.categoryId;
    const product = await Product.create({ sellerUserId: owner.id, sellerType: "business", businessId: (business as { _id: unknown })._id, categoryId: category, categorySlug: "smartphones", title: "Stocked", slug: "stocked-1", description: "Stocked phone here", condition: "good", pricePaise: 100000, specs: { brand: "X" }, status: "active", stockTracked: true, inventory: { state: "available" }, expiresAt: new Date(Date.now() + 86_400_000) } as never);
    const pid = String((product as { _id: unknown })._id);
    await InventoryUnit.create({ code: "U1", businessId: (business as { _id: unknown })._id, productId: pid, status: "AVAILABLE" } as never);
    const sold = await call("post", `/showroom/products/${pid}/sold`, owner.token, { reason: "sold_elsewhere", note: "Walk-in" });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
    expect(sold.body.data).toMatchObject({ status: "sold", stock: { available: 0 }, soldOut: { reason: "sold_elsewhere" } });
    const back = await call("post", `/showroom/products/${pid}/publish`, owner.token, { published: true });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data).toMatchObject({ status: "pending_review", soldOut: null });
  });
});
