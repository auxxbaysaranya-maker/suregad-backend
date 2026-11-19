import http from "http";
import { Server } from "socket.io";
import { createApp } from "./app";
import mongoose from "mongoose";
import { connectDb } from "./config/db";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { seedSystemData } from "./seed/run";
import { startNotificationWorker } from "./services/notification.service";
import { releaseExpiredReservations } from "./services/commerce.service";
import { expireOffers } from "./services/inspection.service";
import { startShowroomJobs } from "./services/promotion.service";
import { migrateShowrooms } from "./seed/showroom-migration";
import { restoreDemoDocuments } from "./seed/demo-applicants";
import { verifyIdentity } from "./integrations/firebase";
import { User } from "./models/user.model";
import { emitToUser, markConnected, markDisconnected, setIo } from "./realtime/io";
import { Conversation } from "./models/engagement.model";

/** Tell everyone this user chats with that they came online or went offline. */
async function broadcastPresence(userId: string, online: boolean) {
  if (mongoose.connection.readyState !== 1) return;
  const conversations = await Conversation.find({ participantIds: userId }).select("participantIds").limit(300).lean();
  const others = new Set<string>();
  for (const conversation of conversations) {
    for (const participant of conversation.participantIds) if (String(participant) !== userId) others.add(String(participant));
  }
  const payload = { userId, online, lastSeenAt: online ? null : new Date().toISOString() };
  for (const other of others) emitToUser(other, "chat:presence", payload);
}

async function main() {
  const app = createApp();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: env.clientOrigins, credentials: true } });
  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token || "");
      const identity = await verifyIdentity(token);
      const user = await User.findOne({ firebaseUid: identity.uid, status: "active" });
      if (!user) {
        next(new Error("unauthorized"));
        return;
      }
      socket.data.userId = String(user._id);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  io.on("connection", (socket) => {
    const userId = String(socket.data.userId);
    socket.join(`user:${userId}`);
    if (markConnected(userId)) void broadcastPresence(userId, true).catch((error) => logger.warn({ err: error }, "presence broadcast failed"));
    socket.on("chat:typing", async (payload: { conversationId?: string; typing?: boolean }) => {
      try {
        if (!payload?.conversationId || !mongoose.isValidObjectId(payload.conversationId)) return;
        const conversation = await Conversation.findOne({ _id: payload.conversationId, participantIds: userId }).select("participantIds blockedBy").lean();
        if (!conversation || conversation.blockedBy?.length) return;
        for (const participant of conversation.participantIds) {
          if (String(participant) !== userId) {
            emitToUser(String(participant), "chat:typing", { conversationId: payload.conversationId, userId, typing: Boolean(payload.typing) });
          }
        }
      } catch (error) {
        logger.warn({ err: error }, "typing relay failed");
      }
    });
    socket.on("disconnect", () => {
      if (!markDisconnected(userId)) return;
      void User.updateOne({ _id: userId }, { lastSeenAt: new Date() })
        .then(() => broadcastPresence(userId, false))
        .catch((error) => logger.warn({ err: error }, "presence update failed"));
    });
  });
  setIo(io);
  await connectDb();
  if (mongoose.connection.readyState === 1) await seedSystemData();
  startNotificationWorker();
  if (mongoose.connection.readyState === 1) await migrateShowrooms().catch((error) => logger.error({ err: error }, "Showroom migration failed"));
  if (mongoose.connection.readyState === 1) await restoreDemoDocuments().catch((error) => logger.warn({ err: error }, "Demo document restore failed"));
  startShowroomJobs();
  setInterval(() => {
    if (mongoose.connection.readyState !== 1) return;
    releaseExpiredReservations().catch((error) => logger.error(error));
    expireOffers().catch((error) => logger.error(error));
  }, 60_000);
  server.listen(env.port, () => {
    logger.info({ port: env.port }, "SureGad API listening");
  });
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    logger.error(error);
    process.exit(1);
  });
}
