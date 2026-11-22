import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { Notification } from "../models/engagement.model";
import { User } from "../models/user.model";
import { sendEmail, sendSms, sendWhatsApp } from "../integrations/channels";
import { sendWebPush } from "../integrations/push";
import { pushPaths, sendPushToUsers } from "./push.service";
import { emitToUser } from "../realtime/io";

type NotifyInput = {
  userId: string;
  event: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

type UserPrefs = { email: boolean; sms: boolean; whatsapp: boolean; push: boolean };

type Delivery = NotifyInput & {
  email?: string;
  phone?: string;
  prefs: UserPrefs;
  pushSubscriptions?: { endpoint: string; keys?: { p256dh?: string; auth?: string } }[];
};

let queue: Queue | null = null;
let workerStarted = false;

function redis() {
  if (!env.redisUrl) return null;
  return new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
}

export function startNotificationWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const connection = redis();
  if (!connection) {
    logger.warn("REDIS_URL is not set. Notification side-channels run in-process.");
    return;
  }
  queue = new Queue("notifications", { connection });
  new Worker(
    "notifications",
    async (job) => {
      await deliverExternal(job.data as Delivery);
    },
    { connection },
  );
}

async function deliverExternal(input: Delivery) {
  if (input.prefs.email && input.email) {
    await sendEmail({ to: input.email, subject: input.title, body: input.body });
  }
  if (input.prefs.sms && input.phone) await sendSms({ to: input.phone, body: input.body });
  if (input.prefs.whatsapp && input.phone) await sendWhatsApp({ to: input.phone, body: input.body });
  if (input.prefs.push && input.pushSubscriptions?.length) {
    await sendWebPush(input.pushSubscriptions, { title: input.title, body: input.body, url: "/account" });
  }
  // Firebase Cloud Messaging to every registered device (stale tokens are removed by the push service).
  if (input.prefs.push) {
    await sendPushToUsers([input.userId], { title: input.title, body: input.body, tag: input.event, ...pushPaths(input.data) });
  }
}

export async function notify(input: NotifyInput): Promise<void> {
  const user = await User.findById(input.userId);
  if (!user || user.status !== "active") return;
  const prefs = user.notificationPreferences || {
    inApp: true,
    email: true,
    sms: false,
    whatsapp: false,
    push: false,
  };
  if (prefs.inApp !== false) {
    const saved = await Notification.create({
      userId: user._id,
      event: input.event,
      title: input.title,
      body: input.body,
      data: input.data,
      channels: ["in_app"],
    });
    emitToUser(String(user._id), "notification", {
      id: String(saved._id),
      event: saved.event,
      title: saved.title,
      body: saved.body,
      data: saved.data,
      createdAt: saved.createdAt,
    });
  }
  const payload: Delivery = {
    ...input,
    email: user.email || undefined,
    phone: user.phone || undefined,
    prefs: {
      email: Boolean(prefs.email),
      sms: Boolean(prefs.sms),
      whatsapp: Boolean(prefs.whatsapp),
      push: Boolean(prefs.push),
    },
    pushSubscriptions: (user.pushSubscriptions || []).map((subscription) => ({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.keys?.p256dh || undefined, auth: subscription.keys?.auth || undefined },
    })),
  };
  if (queue) {
    await queue.add("deliver", payload);
  } else {
    setImmediate(() => {
      deliverExternal(payload).catch((error) => logger.error({ err: error }, "Notification delivery failed"));
    });
  }
}

export async function notifyMany(userIds: string[], input: Omit<NotifyInput, "userId">): Promise<void> {
  await Promise.all(userIds.map((userId) => notify({ ...input, userId })));
}

/** Audiences a super admin may message. "seller" covers individual and showroom sellers. */
export const BROADCAST_AUDIENCES = {
  customers: ["buyer"],
  sellers: ["individual_seller", "business_seller"],
  showrooms: ["business_seller"],
  partners: ["service_partner"],
} as const;

/** Notify every active user in an audience (in-app history + push). Batched to keep load steady. */
export async function notifyAudience(audience: keyof typeof BROADCAST_AUDIENCES, input: Omit<NotifyInput, "userId">): Promise<number> {
  const users = await User.find({ roles: { $in: [...BROADCAST_AUDIENCES[audience]] }, status: "active", deletedAt: null }).select("_id").lean();
  for (let start = 0; start < users.length; start += 50) {
    await notifyMany(users.slice(start, start + 50).map((user) => String(user._id)), input);
  }
  return users.length;
}
