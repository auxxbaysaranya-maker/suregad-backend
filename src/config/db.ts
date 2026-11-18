import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "./logger";

function connectionCause(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current) && parts.length < 6) {
    seen.add(current);
    const entry = current as {
      message?: string;
      cause?: unknown;
      reason?: { servers?: Iterable<[string, { error?: { message?: string } }]> };
    };
    if (entry.reason?.servers) {
      for (const [, server] of entry.reason.servers) {
        if (server.error?.message) parts.push(server.error.message);
      }
    }
    if (entry.message && !entry.message.includes("isn't whitelisted")) parts.push(entry.message);
    current = entry.cause;
  }
  return parts.join(" | ") || (error instanceof Error ? error.message : "unknown");
}

export async function connectDb(uri = env.mongoUri): Promise<typeof mongoose | null> {
  if (!uri) {
    logger.warn("MONGODB_URI is not set. API will report database as disconnected.");
    return null;
  }
  mongoose.set("strictQuery", true);
  mongoose.set("bufferCommands", false);
  let target = "configured";
  try {
    const parsed = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, "https://"));
    target = `${parsed.hostname}${parsed.pathname || ""}`;
  } catch {
    target = "unparsed";
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
      logger.info({ target }, "Connected to MongoDB");
      return mongoose;
    } catch (error) {
      lastError = error;
      const cause = connectionCause(error);
      logger.warn({ attempt, cause }, "MongoDB connection attempt failed.");
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  logger.warn({ err: lastError }, "MongoDB is not reachable. The API will stay up and data routes will return DATABASE_UNAVAILABLE.");
  return null;
}

export async function disconnectDb(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
