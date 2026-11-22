import type { Types } from "mongoose";
import { DeviceToken } from "../models/device-token.model";
import { firebaseMessaging } from "../integrations/firebase";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../common/errors";

export type PushApp = "marketplace" | "panel";
const MAX_DEVICES_PER_USER = 15;

/** FCM web tokens are long base64url-ish strings, sometimes with a ":" separator. */
const TOKEN_PATTERN = /^[A-Za-z0-9_:-]{100,4096}$/;

export function assertValidPushToken(token: string) {
  if (!TOKEN_PATTERN.test(token)) throw new AppError(400, "INVALID_PUSH_TOKEN", "That push token is not valid.");
}

/**
 * Save the device token for the signed-in user. The token comes from Firebase on this device,
 * so the most recent signed-in account owns it (a shared device moves to whoever signs in).
 */
export async function registerDeviceToken(userId: Types.ObjectId | string, token: string, app: PushApp, userAgent?: string) {
  assertValidPushToken(token);
  await DeviceToken.findOneAndUpdate(
    { token },
    { $set: { userId, app, userAgent: userAgent?.slice(0, 300), lastSeenAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  // Keep the newest devices only.
  const extra = await DeviceToken.find({ userId }).sort({ lastSeenAt: -1 }).skip(MAX_DEVICES_PER_USER).select("_id");
  if (extra.length) await DeviceToken.deleteMany({ _id: { $in: extra.map((row) => row._id) } });
}

/** Remove a token, only if it belongs to this user (sign-out on this device). */
export async function unregisterDeviceToken(userId: Types.ObjectId | string, token: string) {
  const result = await DeviceToken.deleteOne({ token, userId });
  return result.deletedCount > 0;
}

export interface PushPayload {
  title: string;
  body: string;
  /** In-app path, e.g. "/chat/123". Turned into an absolute link for the device's app. */
  path?: string;
  /** Path to use on the seller/partner/admin panel, when it differs. */
  panelPath?: string;
  /** Notifications with the same tag replace each other on the device. */
  tag?: string;
}

const DEAD_TOKEN_CODES = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);

/**
 * Send a push to every registered device of the given users. Data-only messages: the service
 * worker shows the notification and opens `url` on click, so nothing is shown twice.
 * Tokens Firebase reports as gone are deleted. Returns delivery counts.
 */
export async function sendPushToUsers(userIds: (Types.ObjectId | string)[], payload: PushPayload) {
  const messaging = firebaseMessaging();
  if (!messaging || !userIds.length) return { sent: 0, failed: 0, removed: 0 };
  const devices = await DeviceToken.find({ userId: { $in: userIds } }).select("token app").lean();
  if (!devices.length) return { sent: 0, failed: 0, removed: 0 };
  const messages = devices.map((device) => {
    const base = device.app === "panel" ? env.panelUrl : env.appUrl;
    const path = (device.app === "panel" ? payload.panelPath || "/" : payload.path || "/account").replace(/^\/*/, "/");
    return {
      token: device.token,
      data: { title: payload.title.slice(0, 120), body: payload.body.slice(0, 400), url: `${base}${path}`, tag: payload.tag || "suregad" },
      webpush: { headers: { Urgency: "high", TTL: String(60 * 60 * 24) } },
    };
  });
  let sent = 0;
  let failed = 0;
  const dead: string[] = [];
  for (let start = 0; start < messages.length; start += 500) {
    const batch = messages.slice(start, start + 500);
    try {
      const response = await messaging.sendEach(batch);
      response.responses.forEach((result, index) => {
        if (result.success) sent += 1;
        else {
          failed += 1;
          if (DEAD_TOKEN_CODES.has(result.error?.code || "")) dead.push(batch[index]!.token);
        }
      });
    } catch (error) {
      failed += batch.length;
      logger.warn({ err: error }, "Push delivery failed");
    }
  }
  if (dead.length) await DeviceToken.deleteMany({ token: { $in: dead } });
  return { sent, failed, removed: dead.length };
}

/** Links for common notification data, per app. */
export function pushPaths(data: Record<string, unknown> | undefined): Pick<PushPayload, "path" | "panelPath"> {
  const value = (key: string) => (typeof data?.[key] === "string" ? (data[key] as string) : "");
  if (value("conversationId")) return { path: `/chat/${value("conversationId")}`, panelPath: "/" };
  if (value("orderId")) return { path: "/account/orders", panelPath: `/seller/orders?open=${value("orderId")}` };
  if (value("requestId")) return { path: "/account/inspections", panelPath: "/" };
  if (value("ticketId")) return { path: "/account/support", panelPath: "/" };
  if (value("businessId")) return { path: "/account", panelPath: "/" };
  return { path: "/account", panelPath: "/" };
}
