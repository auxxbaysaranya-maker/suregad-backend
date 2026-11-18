import crypto from "crypto";
import admin from "firebase-admin";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../common/errors";

export interface AuthIdentity {
  uid: string;
  email?: string;
  phone?: string;
  name?: string;
  picture?: string;
  authTime?: number;
}

let appReady = false;

export function firebaseConfigured(): boolean {
  return Boolean(
    (env.firebase.projectId && env.firebase.clientEmail && env.firebase.privateKey) ||
      env.firebase.credentialsPath,
  );
}

function adminAuth() {
  if (!firebaseConfigured()) return null;
  if (!appReady) {
    if (env.firebase.credentialsPath && !env.firebase.privateKey) {
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    } else {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: env.firebase.projectId,
          clientEmail: env.firebase.clientEmail,
          privateKey: env.firebase.privateKey.replace(/\\n/g, "\n"),
        }),
      });
    }
    appReady = true;
  }
  return admin.auth();
}

export async function sendFirebasePush(tokens: string[], payload: { title: string; body: string; url?: string }): Promise<void> {
  if (!adminAuth() || tokens.length === 0) return;
  try {
    await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      webpush: { fcmOptions: { link: payload.url || "/account" } },
    });
  } catch (error) {
    logger.warn({ err: error }, "Firebase push was not delivered");
  }
}

export function signDevToken(input: {
  uid: string;
  email?: string;
  phone?: string;
  name?: string;
}): string {
  if (!env.allowDevAuth || !env.devAuthSecret) {
    throw new AppError(403, "DEV_AUTH_DISABLED", "Development authentication is disabled.");
  }
  const body = Buffer.from(
    JSON.stringify({ ...input, exp: Date.now() + 12 * 60 * 60 * 1000 }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", env.devAuthSecret).update(body).digest("base64url");
  return `dev.${body}.${sig}`;
}

function verifyDevToken(token: string): AuthIdentity | null {
  if (!token.startsWith("dev.")) return null;
  if (!env.allowDevAuth || !env.devAuthSecret) {
    throw new AppError(403, "DEV_AUTH_DISABLED", "Development authentication is disabled.");
  }
  const [, body, sig] = token.split(".");
  if (!body || !sig) throw new AppError(401, "INVALID_TOKEN", "Development token is malformed.");
  const expected = crypto.createHmac("sha256", env.devAuthSecret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new AppError(401, "INVALID_TOKEN", "Development token signature is invalid.");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
    uid: string;
    email?: string;
    phone?: string;
    name?: string;
    exp: number;
  };
  if (!payload.exp || payload.exp < Date.now()) {
    throw new AppError(401, "TOKEN_EXPIRED", "Development token has expired.");
  }
  return { uid: payload.uid, email: payload.email, phone: payload.phone, name: payload.name };
}

export async function ensureEmailUser(input: { email: string; password: string; name: string }): Promise<string | null> {
  const auth = adminAuth();
  if (!auth) return null;
  try {
    const existing = await auth.getUserByEmail(input.email);
    return existing.uid;
  } catch {
    const created = await auth.createUser({
      email: input.email,
      password: input.password,
      displayName: input.name,
      emailVerified: true,
    });
    return created.uid;
  }
}

export async function verifyIdentity(token: string): Promise<AuthIdentity> {
  if (token.startsWith("dev.")) {
    const identity = verifyDevToken(token);
    if (!identity) throw new AppError(401, "INVALID_TOKEN", "Invalid token.");
    return identity;
  }
  const auth = adminAuth();
  if (!auth) {
    throw new AppError(
      503,
      "AUTH_NOT_CONFIGURED",
      "Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.",
    );
  }
  try {
    const decoded = await auth.verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email,
      phone: decoded.phone_number,
      name: decoded.name,
      picture: decoded.picture,
      authTime: decoded.auth_time,
    };
  } catch {
    throw new AppError(401, "INVALID_TOKEN", "Firebase ID token could not be verified.");
  }
}
