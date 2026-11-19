import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { requireUser } from "../middleware/auth";
import { asyncHandler, sendData } from "../common/http";
import { AppError, notFound } from "../common/errors";
import { Conversation, Enquiry, Message, Offer, SupportTicket } from "../models/engagement.model";
import { Product } from "../models/catalog.model";
import { Order } from "../models/commerce.model";
import { InspectionRequest } from "../models/inspection.model";
import { Business } from "../models/profiles.model";
import { User } from "../models/user.model";
import { emitToUser, isOnline } from "../realtime/io";
import { mediaUrl } from "../integrations/storage";
import { audit } from "../services/audit.service";
import {
  OFFER_HOLD_HOURS,
  assertNotBlocked,
  loadConversation,
  postMessage,
  presentMessage,
  presentOffer,
  roles,
} from "../services/chat.service";
import { formatInr } from "../shared";

export const chat = Router();
chat.use(requireUser);

const me = (req: { user?: { _id: { toString(): string } } }) => String(req.user!._id);

function productSummary(product: Record<string, any> | null | undefined) {
  if (!product) return null;
  const image = product.images?.[0];
  return {
    id: String(product._id),
    slug: product.slug,
    title: product.title,
    pricePaise: product.pricePaise,
    status: product.status,
    condition: product.condition,
    sellerType: product.sellerType,
    city: product.city,
    image: image ? image.url || mediaUrl(image.key) : null,
    available: product.status === "active" && product.inventory?.state === "available" && !product.deletedAt,
  };
}

function userSummary(user: Record<string, any> | null | undefined) {
  if (!user) return { id: "", name: "SureGad user", photoUrl: null, online: false, lastSeenAt: null, memberSince: null };
  return {
    id: String(user._id),
    name: user.status === "deleted" ? "Deleted user" : user.displayName,
    photoUrl: user.photoUrl || null,
    online: isOnline(String(user._id)),
    lastSeenAt: user.lastSeenAt || null,
    memberSince: user.createdAt || null,
  };
}

function emitConversation(conversation: { _id: unknown; participantIds: unknown[] }) {
  for (const id of conversation.participantIds) emitToUser(String(id), "chat:conversation", { conversationId: String(conversation._id) });
}

/** Total unread messages across the user's visible chats (drives the nav badge). */
chat.get(
  "/unread",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const rows = await Conversation.find({ participantIds: userId, hiddenFor: { $ne: userId } }).select("unread").lean();
    const count = rows.reduce((sum, row) => sum + Number((row.unread as Record<string, number> | undefined)?.[userId] || 0), 0);
    sendData(res, { count });
  }),
);

chat.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const box = String(req.query.box || "all");
    const filter = String(req.query.filter || "all");
    const q = String(req.query.q || "").trim().toLowerCase();
    const query: Record<string, unknown> = { participantIds: userId, hiddenFor: { $ne: userId } };
    if (filter === "important") query.importantFor = userId;
    const conversations = await Conversation.find(query).sort({ lastMessageAt: -1 }).limit(200).lean();
    const productIds = conversations.map((conversation) => conversation.productId).filter(Boolean);
    const otherIds = conversations.map((conversation) => conversation.participantIds.find((id) => String(id) !== userId)).filter(Boolean);
    const [products, users, offers] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).select("title slug pricePaise status condition sellerType city images inventory deletedAt").lean(),
      User.find({ _id: { $in: otherIds } }).select("displayName photoUrl lastSeenAt status createdAt").lean(),
      Offer.find({ conversationId: { $in: conversations.map((conversation) => conversation._id) } }).sort({ createdAt: -1 }).lean(),
    ]);
    const productById = new Map(products.map((product) => [String(product._id), product]));
    const userById = new Map(users.map((user) => [String(user._id), user]));
    const latestOffer = new Map<string, (typeof offers)[number]>();
    for (const offer of offers) if (!latestOffer.has(String(offer.conversationId))) latestOffer.set(String(offer.conversationId), offer);
    let items = conversations.map((conversation) => {
      const { buyerId } = roles(conversation);
      const otherId = String(conversation.participantIds.find((id) => String(id) !== userId) || "");
      const unread = Number((conversation.unread as Record<string, number> | undefined)?.[userId] || 0);
      return {
        id: String(conversation._id),
        kind: conversation.kind || "listing",
        inspectionRequestId: conversation.inspectionRequestId ? String(conversation.inspectionRequestId) : null,
        role: conversation.kind === "inspection" ? "inspection" : buyerId === userId ? "buying" : "selling",
        product: productSummary(productById.get(String(conversation.productId))),
        other: userSummary(userById.get(otherId)),
        lastPreview: conversation.lastPreview || "",
        lastMessageAt: conversation.lastMessageAt || conversation.updatedAt,
        lastFromMe: String(conversation.lastSenderId || "") === userId,
        unread,
        important: (conversation.importantFor || []).some((id) => String(id) === userId),
        blocked: (conversation.blockedBy || []).length > 0,
        offer: presentOffer(latestOffer.get(String(conversation._id))),
      };
    });
    if (box === "buying" || box === "selling" || box === "inspection") items = items.filter((item) => item.role === box);
    if (filter === "unread") items = items.filter((item) => item.unread > 0);
    if (filter === "offers") items = items.filter((item) => item.offer);
    if (q) items = items.filter((item) => `${item.product?.title || ""} ${item.other.name}`.toLowerCase().includes(q));
    sendData(res, items);
  }),
);

/** Open (or reopen) the buyer's chat with the seller about a listing. */
chat.post(
  "/conversations",
  asyncHandler(async (req, res) => {
    const body = z.object({ productId: z.string(), message: z.string().trim().min(1).max(4000).optional() }).parse(req.body);
    const userId = me(req);
    if (!Types.ObjectId.isValid(body.productId)) throw notFound("Listing not found.");
    const product = await Product.findOne({ _id: body.productId, deletedAt: null });
    if (!product || !["active", "reserved", "sold"].includes(product.status)) throw notFound("Listing not found.");
    const sellerUserId = String(product.sellerUserId);
    if (sellerUserId === userId) throw new AppError(400, "OWN_LISTING", "This is your own listing.");
    let conversation =
      (await Conversation.findOne({ buyerId: userId, sellerUserId, productId: product._id })) ||
      (await Conversation.findOne({ productId: product._id, participantIds: { $all: [userId, sellerUserId] } }).sort({ createdAt: -1 }));
    if (!conversation) {
      conversation = await Conversation.create({
        participantIds: [userId, sellerUserId],
        buyerId: userId,
        sellerUserId,
        productId: product._id,
        lastMessageAt: new Date(),
        lastPreview: "",
      });
      const enquiry = await Enquiry.create({
        buyerId: userId,
        sellerUserId,
        businessId: product.businessId,
        productId: product._id,
        subject: product.title,
        conversationId: conversation._id,
      });
      conversation.enquiryId = enquiry._id;
    } else {
      if (!conversation.buyerId) conversation.buyerId = new Types.ObjectId(userId);
      if (!conversation.sellerUserId) conversation.sellerUserId = new Types.ObjectId(sellerUserId);
      conversation.hiddenFor = (conversation.hiddenFor || []).filter((id) => String(id) !== userId) as never;
    }
    await conversation.save();
    if (body.message) {
      assertNotBlocked(conversation, userId);
      await postMessage(conversation, userId, { body: body.message });
    }
    sendData(res, { id: String(conversation._id) }, undefined, 201);
  }),
);

chat.get(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const conversation = await loadConversation(req.params.id, userId);
    const { buyerId, sellerUserId } = roles(conversation);
    const otherId = userId === buyerId ? sellerUserId : buyerId;
    const [product, other, offer] = await Promise.all([
      Product.findById(conversation.productId).lean(),
      User.findById(otherId).select("displayName photoUrl lastSeenAt status createdAt sharePhone phone").lean(),
      Offer.findOne({ conversationId: conversation._id }).sort({ createdAt: -1 }).lean(),
    ]);
    const blockedBy = (conversation.blockedBy || []).map(String);
    let canCall = false;
    if (userId === buyerId && product) {
      const business = product.businessId ? await Business.findById(product.businessId).select("phone").lean() : null;
      canCall = Boolean(business?.phone || (other?.sharePhone && other.phone));
    }
    const inspection = conversation.inspectionRequestId
      ? await InspectionRequest.findById(conversation.inspectionRequestId).select("number status mode appointmentAt").lean()
      : null;
    sendData(res, {
      id: String(conversation._id),
      kind: conversation.kind || "listing",
      inspection: inspection
        ? { id: String(inspection._id), number: inspection.number, status: inspection.status, mode: inspection.mode, appointmentAt: inspection.appointmentAt || null }
        : null,
      role: conversation.kind === "inspection" ? "inspection" : userId === buyerId ? "buying" : "selling",
      product: productSummary(product),
      other: userSummary(other),
      important: (conversation.importantFor || []).some((id) => String(id) === userId),
      blockedByMe: blockedBy.includes(userId),
      blockedByOther: blockedBy.some((id) => id !== userId),
      canCall,
      offer: presentOffer(offer),
      offerHoldHours: OFFER_HOLD_HOURS,
    });
  }),
);

chat.get(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const conversation = await loadConversation(req.params.id, userId);
    const filter: Record<string, unknown> = { conversationId: conversation._id };
    if (req.query.before) filter.createdAt = { $lt: new Date(String(req.query.before)) };
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const rows = (await Message.find(filter).sort({ createdAt: -1 }).limit(limit).lean()).reverse();
    const offers = await Offer.find({ _id: { $in: rows.map((row) => row.offerId).filter(Boolean) } }).lean();
    const offerById = new Map(offers.map((offer) => [String(offer._id), offer]));
    sendData(
      res,
      rows.map((row) => presentMessage(row, row.offerId ? offerById.get(String(row.offerId)) : null)),
      { hasMore: rows.length === limit },
    );
  }),
);

chat.post(
  "/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const body = z
      .object({ body: z.string().trim().max(4000).optional(), imageKey: z.string().max(300).optional(), orderId: z.string().optional() })
      .refine((value) => value.body || value.imageKey, "Write a message or attach a photo.")
      .parse(req.body);
    const conversation = await loadConversation(req.params.id, userId);
    assertNotBlocked(conversation, userId);
    let orderId: string | undefined;
    if (body.orderId) {
      // Only an order between these two people can be referenced.
      const { buyerId, sellerUserId } = roles(conversation);
      const order = Types.ObjectId.isValid(body.orderId)
        ? await Order.findOne({ _id: body.orderId, buyerId, "subOrders.sellerUserId": sellerUserId }).select("number").lean()
        : null;
      if (!order) throw new AppError(400, "INVALID_ORDER", "That order is not part of this conversation.");
      orderId = String(order._id);
      body.body = body.body || `Order ${order.number}`;
    }
    if (body.imageKey) {
      if (!body.imageKey.startsWith(`public/chat_image/${userId}/`) || body.imageKey.includes("..")) {
        throw new AppError(400, "INVALID_IMAGE", "Upload the photo again before sending.");
      }
      const message = await postMessage(conversation, userId, {
        kind: "image",
        body: body.body || "Photo",
        imageUrl: mediaUrl(body.imageKey),
        preview: body.body ? `📷 ${body.body}` : "📷 Photo",
      });
      sendData(res, message, undefined, 201);
      return;
    }
    sendData(res, await postMessage(conversation, userId, { body: body.body!, orderId }), undefined, 201);
  }),
);

/** Mark the other side's messages as read and tell them (read receipts). */
chat.post(
  "/conversations/:id/read",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const conversation = await loadConversation(req.params.id, userId);
    await Message.updateMany({ conversationId: conversation._id, readBy: { $ne: userId } }, { $addToSet: { readBy: userId } });
    const unread = conversation.unread || new Map<string, number>();
    if (unread.get(userId)) {
      unread.set(userId, 0);
      conversation.unread = unread;
      await conversation.save();
    }
    for (const id of conversation.participantIds) {
      emitToUser(String(id), "chat:read", { conversationId: String(conversation._id), readerId: userId, at: new Date().toISOString() });
    }
    sendData(res, { read: true });
  }),
);

chat.patch(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const body = z.object({ important: z.boolean() }).parse(req.body);
    const conversation = await loadConversation(req.params.id, userId);
    const others = (conversation.importantFor || []).filter((id) => String(id) !== userId);
    conversation.importantFor = (body.important ? [...others, new Types.ObjectId(userId)] : others) as never;
    await conversation.save();
    sendData(res, { important: body.important });
  }),
);

/** Delete from my inbox only. The other person keeps their copy. */
chat.delete(
  "/conversations/:id",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const conversation = await loadConversation(req.params.id, userId);
    if (!(conversation.hiddenFor || []).some((id) => String(id) === userId)) conversation.hiddenFor.push(new Types.ObjectId(userId));
    conversation.unread?.set(userId, 0);
    await conversation.save();
    sendData(res, { deleted: true });
  }),
);

chat.post(
  "/conversations/:id/block",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const body = z.object({ blocked: z.boolean() }).parse(req.body);
    const conversation = await loadConversation(req.params.id, userId);
    const others = (conversation.blockedBy || []).filter((id) => String(id) !== userId);
    conversation.blockedBy = (body.blocked ? [...others, new Types.ObjectId(userId)] : others) as never;
    await conversation.save();
    await audit(req, body.blocked ? "chat.blocked" : "chat.unblocked", "Conversation", String(conversation._id));
    emitConversation(conversation);
    sendData(res, { blocked: body.blocked });
  }),
);

chat.post(
  "/conversations/:id/report",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const body = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
    const conversation = await loadConversation(req.params.id, userId);
    await SupportTicket.create({ userId, subject: "Chat report", body: `Conversation ${conversation._id}: ${body.reason}` });
    await audit(req, "chat.reported", "Conversation", String(conversation._id), { reason: body.reason });
    sendData(res, { reported: true }, undefined, 201);
  }),
);

/** Either side can name a price. A new offer replaces any pending one. */
chat.post(
  "/conversations/:id/offers",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const body = z.object({ amountPaise: z.number().int().positive() }).parse(req.body);
    const conversation = await loadConversation(req.params.id, userId);
    assertNotBlocked(conversation, userId);
    if (conversation.kind === "inspection") throw new AppError(400, "NO_OFFERS", "Offers are not available in inspection chats.");
    const { buyerId, sellerUserId } = roles(conversation);
    const product = await Product.findById(conversation.productId);
    if (!product || product.deletedAt || product.status !== "active" || product.inventory?.state !== "available") {
      throw new AppError(409, "UNAVAILABLE", "This device is no longer available for offers.");
    }
    if (body.amountPaise > product.pricePaise) throw new AppError(400, "OFFER_TOO_HIGH", "An offer can't be higher than the listed price.");
    if (body.amountPaise < Math.ceil(product.pricePaise * 0.1)) throw new AppError(400, "OFFER_TOO_LOW", "That offer is too low for this listing.");
    await Offer.updateMany({ conversationId: conversation._id, status: "pending" }, { status: "superseded", respondedAt: new Date() });
    const offer = await Offer.create({
      conversationId: conversation._id,
      productId: product._id,
      buyerId,
      sellerUserId,
      createdBy: userId,
      amountPaise: body.amountPaise,
      listPricePaise: product.pricePaise,
      status: "pending",
    });
    const label = userId === buyerId ? "Offered" : "Counter-offer";
    const message = await postMessage(conversation, userId, {
      kind: "offer",
      body: `${label} ${formatInr(body.amountPaise)}`,
      offerId: offer._id,
    });
    sendData(res, message, undefined, 201);
  }),
);

chat.get(
  "/offers/:id",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound("Offer not found.");
    const offer = await Offer.findById(req.params.id).lean();
    if (!offer || (String(offer.buyerId) !== userId && String(offer.sellerUserId) !== userId)) throw notFound("Offer not found.");
    sendData(res, presentOffer(offer));
  }),
);

chat.post(
  "/offers/:id/respond",
  asyncHandler(async (req, res) => {
    const userId = me(req);
    const body = z.object({ action: z.enum(["accept", "reject", "withdraw"]) }).parse(req.body);
    if (!Types.ObjectId.isValid(req.params.id)) throw notFound("Offer not found.");
    const offer = await Offer.findById(req.params.id);
    if (!offer) throw notFound("Offer not found.");
    const conversation = await loadConversation(String(offer.conversationId), userId);
    if (offer.status !== "pending") throw new AppError(409, "OFFER_CLOSED", "This offer is no longer open.");
    const madeByMe = String(offer.createdBy) === userId;
    if (body.action === "withdraw" ? !madeByMe : madeByMe) {
      throw new AppError(403, "FORBIDDEN", body.action === "withdraw" ? "Only the person who made the offer can withdraw it." : "Wait for the other person to respond to your offer.");
    }
    if (body.action === "accept") {
      assertNotBlocked(conversation, userId);
      const product = await Product.findById(offer.productId).select("status inventory deletedAt");
      if (!product || product.deletedAt || product.status !== "active" || product.inventory?.state !== "available") {
        throw new AppError(409, "UNAVAILABLE", "This device is no longer available.");
      }
    }
    offer.status = body.action === "accept" ? "accepted" : body.action === "reject" ? "rejected" : "withdrawn";
    offer.respondedAt = new Date();
    if (body.action === "accept") offer.expiresAt = new Date(Date.now() + OFFER_HOLD_HOURS * 60 * 60 * 1000);
    await offer.save();
    const amount = formatInr(offer.amountPaise);
    const text =
      body.action === "accept"
        ? `Offer of ${amount} accepted. The buyer can check out at this price for ${OFFER_HOLD_HOURS} hours.`
        : body.action === "reject"
          ? `Offer of ${amount} declined.`
          : `Offer of ${amount} withdrawn.`;
    await postMessage(conversation, userId, { kind: "system", body: text });
    emitConversation(conversation);
    sendData(res, presentOffer(offer.toObject()));
  }),
);

/** Reveal the seller's number only if they chose to share it (or the showroom lists one). */
chat.get(
  "/contact/:productId",
  asyncHandler(async (req, res) => {
    if (!Types.ObjectId.isValid(req.params.productId)) throw notFound("Listing not found.");
    const product = await Product.findOne({ _id: req.params.productId, deletedAt: null }).select("sellerUserId businessId title").lean();
    if (!product) throw notFound("Listing not found.");
    const [seller, business] = await Promise.all([
      User.findById(product.sellerUserId).select("displayName phone sharePhone").lean(),
      product.businessId ? Business.findById(product.businessId).select("name phone").lean() : null,
    ]);
    const phone = business?.phone || (seller?.sharePhone && seller.phone ? seller.phone : null);
    if (phone) await audit(req, "contact.revealed", "Product", String(product._id));
    sendData(res, { name: business?.name || seller?.displayName || "Seller", phone, ownListing: String(product.sellerUserId) === me(req) });
  }),
);
