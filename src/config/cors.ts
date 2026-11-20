import { env, isAllowedOrigin } from "./env";
import { logger } from "./logger";

const warned = new Set<string>();

/**
 * Origin check shared by Express and Socket.IO. Requests without an Origin header
 * (server-to-server, curl, health checks) are allowed; browsers must be on CORS_ORIGINS.
 * A blocked origin is logged once so a missing entry is easy to spot in the host's logs.
 */
export function corsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  if (!origin || isAllowedOrigin(origin)) return callback(null, true);
  if (!warned.has(origin)) {
    warned.add(origin);
    logger.warn({ origin, allowed: env.clientOrigins }, "CORS: origin not allowed. Add it to CORS_ORIGINS in the server environment.");
  }
  return callback(null, false);
}
