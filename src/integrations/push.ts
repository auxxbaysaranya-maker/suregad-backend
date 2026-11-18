import webpush from "web-push";
import { env } from "../config/env";
import { logger } from "../config/logger";

let configured = false;

function ready() {
  if (!env.vapid.publicKey || !env.vapid.privateKey) return false;
  if (!configured) {
    webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
    configured = true;
  }
  return true;
}

export async function sendWebPush(
  subscriptions: { endpoint: string; keys?: { p256dh?: string; auth?: string } }[],
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  if (!ready()) return;
  await Promise.all(
    subscriptions.map(async (subscription) => {
      if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) return;
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
          JSON.stringify(payload),
        );
      } catch (error) {
        logger.warn({ err: error }, "Web push delivery failed");
      }
    }),
  );
}
