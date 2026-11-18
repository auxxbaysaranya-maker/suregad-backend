import { Types } from "mongoose";
import { Conversation, Message, Offer } from "../models/engagement.model";
import { emitToUser, isOnline } from "../realtime/io";
import { notify } from "./notification.service";
import { AppError, forbidden, notFound } from "../common/errors";

export const OFFER_HOLD_HOURS = 48;

type ConversationDoc = InstanceType<typeof Conversation>;
type OfferLike = {
  _id: unknown;
  amountPaise: number;
  listPricePaise: number;
  status: string;
  createdBy: unknown;
  buyerId: unknown;
  sellerUserId: unknown;
  productId: unknown;
  expiresAt?: Date | null;
  respondedAt?: Date | null;
  orderId?: unknown;
  createdAt?: Date;
};

/** Buyer and seller ids, including threads created before those fields existed. */
export function roles(conversation: { buyerId?: unknown; sellerUserId?: unknown; participantIds: unknown[] }) {
  const buyerId = String(conversation.buyerId || conversation.participantIds[0]);
  const sellerUserId = String(conversation.sellerUserId || conversation.participantIds[1]);
  return { buyerId, sellerUserId };
}

export async function loadConversation(id: string, userId: string): Promise<ConversationDoc> {
  if (!Types.ObjectId.isValid(id)) throw notFound("Conversation not found.");
  const conversation = await Conversation.findById(id);
  if (!conversation) throw notFound("Conversation not found.");
  if (!conversation.participantIds.some((participant) => String(participant) === userId)) throw forbidden();
  return conversation;
}

export function presentOffer(offer: OfferLike | null | undefined) {
  if (!offer) return null;
  const expired = offer.status === "accepted" && offer.expiresAt && offer.expiresAt < new Date();
  return {
    id: String(offer._id),
    amountPaise: offer.amountPaise,
    listPricePaise: offer.listPricePaise,
    status: expired ? "expired" : offer.status,
    createdBy: String(offer.createdBy),
    buyerId: String(offer.buyerId),
    sellerUserId: String(offer.sellerUserId),
    productId: String(offer.productId),
    expiresAt: offer.expiresAt || null,
    respondedAt: offer.respondedAt || null,
    orderId: offer.orderId ? String(offer.orderId) : null,
    createdAt: offer.createdAt,
  };
}

export function presentMessage(
  message: { _id: unknown; conversationId: unknown; senderId: unknown; kind?: string | null; body: string; imageUrl?: string | null; offerId?: unknown; readBy?: unknown[]; createdAt?: Date },
  offer?: OfferLike | null,
) {
  return {
    id: String(message._id),
    conversationId: String(message.conversationId),
    senderId: String(message.senderId),
    kind: message.kind || "text",
    body: message.body,
    imageUrl: message.imageUrl || null,
    offer: presentOffer(offer),
    readBy: (message.readBy || []).map(String),
    createdAt: message.createdAt,
  };
}

/**
 * Store a message, bump the thread, raise the other side's unread count and push it live.
 * System messages count as unread for both sides.
 */
export async function postMessage(
  conversation: ConversationDoc,
  senderId: string,
  input: { kind?: "text" | "image" | "offer" | "system"; body: string; imageUrl?: string; offerId?: unknown; preview?: string },
) {
  const kind = input.kind || "text";
  const message = await Message.create({
    conversationId: conversation._id,
    senderId,
    kind,
    body: input.body,
    imageUrl: input.imageUrl,
    offerId: input.offerId,
    readBy: kind === "system" ? [] : [senderId],
  });
  const participants = conversation.participantIds.map(String);
  const recipients = participants.filter((id) => kind === "system" || id !== senderId);
  conversation.lastMessageAt = message.createdAt;
  conversation.lastPreview = (input.preview || input.body).slice(0, 140);
  conversation.lastSenderId = new Types.ObjectId(senderId);
  const unread = conversation.unread || new Map<string, number>();
  for (const id of recipients) unread.set(id, (unread.get(id) || 0) + 1);
  conversation.unread = unread;
  conversation.hiddenFor = [] as never;
  await conversation.save();
  const offer = input.offerId ? await Offer.findById(input.offerId).lean() : null;
  const payload = presentMessage(message.toObject(), offer);
  for (const id of participants) emitToUser(id, "chat:message", { conversationId: String(conversation._id), message: payload });
  for (const id of recipients) {
    if (id === senderId || isOnline(id)) continue;
    await notify({
      userId: id,
      event: kind === "offer" ? "chat.offer" : "message.created",
      title: kind === "offer" ? "New offer" : "New message",
      body: conversation.lastPreview,
      data: { conversationId: String(conversation._id) },
    });
  }
  return payload;
}

export function assertNotBlocked(conversation: ConversationDoc, userId: string) {
  const blockedBy = (conversation.blockedBy || []).map(String);
  if (blockedBy.includes(userId)) throw new AppError(403, "CHAT_BLOCKED", "You blocked this user. Unblock them to send messages.");
  if (blockedBy.length) throw new AppError(403, "CHAT_BLOCKED", "You can't reply to this conversation.");
}

/** Called after a paid order: any accepted offer tied to it becomes "purchased" and the thread gets a notice. */
export async function markOffersPurchased(orderId: unknown, orderNumber: string) {
  const offers = await Offer.find({ orderId, status: "accepted" });
  for (const offer of offers) {
    offer.status = "purchased";
    await offer.save();
    const conversation = await Conversation.findById(offer.conversationId);
    if (conversation) {
      await postMessage(conversation, String(offer.buyerId), {
        kind: "system",
        body: `Order ${orderNumber} was paid at the agreed price. The seller will confirm pickup or delivery.`,
      });
    }
  }
}
