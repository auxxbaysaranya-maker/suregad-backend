import crypto from "crypto";
import fs from "fs";
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
  /** False only for Firebase accounts whose email is not verified yet. */
  emailVerified?: boolean;
  /** Firebase sign-in method: "password", "google.com", "phone", or "dev" for development tokens. */
  provider?: string;
}

/**
 * Credentials, in order of preference:
 * 1. FIREBASE_SERVICE_ACCOUNT_PATH — the service-account JSON file (kept out of git).
 * 2. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY — for hosts that can't hold files.
 * 3. GOOGLE_APPLICATION_CREDENTIALS — Google's standard variable.
 * Problems are logged without ever printing key material.
 */
function loadCredential(): { credential: admin.credential.Credential; projectId?: string } | null {
  const file = env.firebase.serviceAccountPath;
  if (file) {
    if (!fs.existsSync(file)) {
      logger.error({ path: file }, "Firebase Admin: service account file not found. Set FIREBASE_SERVICE_ACCOUNT_PATH to the JSON from Firebase Console → Project settings → Service accounts.");
      return null;
    }
    let json: { type?: string; project_id?: string; client_email?: string; private_key?: string };
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      logger.error({ path: file }, "Firebase Admin: service account file is not valid JSON.");
      return null;
    }
    if (json.type !== "service_account" || !json.project_id || !json.client_email || !/BEGIN PRIVATE KEY/.test(json.private_key || "")) {
      logger.error({ path: file }, "Firebase Admin: service account file is missing type, project_id, client_email or private_key.");
      return null;
    }
    if (env.firebase.projectId && env.firebase.projectId !== json.project_id) {
      logger.error({ expected: env.firebase.projectId, file: json.project_id }, "Firebase Admin: FIREBASE_PROJECT_ID does not match the service account's project.");
      return null;
    }
    return { credential: admin.credential.cert(json as admin.ServiceAccount), projectId: json.project_id };
  }
  if (env.firebase.projectId && env.firebase.clientEmail && env.firebase.privateKey) {
    return {
      credential: admin.credential.cert({
        projectId: env.firebase.projectId,
        clientEmail: env.firebase.clientEmail,
        privateKey: env.firebase.privateKey.replace(/\\n/g, "\n"),
      }),
      projectId: env.firebase.projectId,
    };
  }
  if (env.firebase.credentialsPath) return { credential: admin.credential.applicationDefault(), projectId: env.firebase.projectId || undefined };
  return null;
}

let firebaseApp: admin.app.App | null | undefined;

/** The one Firebase Admin app for this process (initialised on first use), or null when not configured. */
export function getFirebaseApp(): admin.app.App | null {
  if (firebaseApp !== undefined) return firebaseApp;
  const loaded = loadCredential();
  if (!loaded) {
    firebaseApp = null;
    return null;
  }
  const existing = admin.apps.find((app) => app?.name === "[DEFAULT]");
  firebaseApp = existing || admin.initializeApp({ credential: loaded.credential, projectId: loaded.projectId });
  logger.info({ projectId: firebaseApp.options.projectId }, "Firebase Admin initialised");
  return firebaseApp;
}

export function firebaseConfigured(): boolean {
  return Boolean(getFirebaseApp());
}

function adminAuth() {
  const app = getFirebaseApp();
  return app ? admin.auth(app) : null;
}

export function firebaseMessaging() {
  const app = getFirebaseApp();
  return app ? admin.messaging(app) : null;
}

/** Revoke a user's Firebase refresh tokens (sign out everywhere). No-op for development accounts. */
export async function revokeFirebaseSessions(uid: string): Promise<void> {
  const auth = adminAuth();
  if (!auth || uid.startsWith("dev:")) return;
  await auth.revokeRefreshTokens(uid).catch((error) => logger.warn({ err: error, uid }, "Could not revoke Firebase sessions"));
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
  return { uid: payload.uid, email: payload.email, phone: payload.phone, name: payload.name, emailVerified: true };
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

/**
 * Verify a Firebase ID token (or a development token when ALLOW_DEV_AUTH is on).
 * `checkRevoked` also rejects tokens of disabled accounts and revoked sessions; it costs a
 * round trip to Firebase, so it is used when a session starts rather than on every request.
 */
export async function verifyIdentity(token: string, options: { checkRevoked?: boolean } = {}): Promise<AuthIdentity> {
  if (token.startsWith("dev.")) {
    const identity = verifyDevToken(token);
    if (!identity) throw new AppError(401, "INVALID_TOKEN", "Invalid token.");
    return { ...identity, provider: "dev" };
  }
  const auth = adminAuth();
  if (!auth) {
    throw new AppError(503, "AUTH_NOT_CONFIGURED", "Sign-in is temporarily unavailable. Please try again later.");
  }
  try {
    const decoded = await auth.verifyIdToken(token, Boolean(options.checkRevoked));
    return {
      uid: decoded.uid,
      email: decoded.email,
      phone: decoded.phone_number,
      name: decoded.name,
      picture: decoded.picture,
      authTime: decoded.auth_time,
      emailVerified: decoded.email ? Boolean(decoded.email_verified) : true,
      provider: decoded.firebase?.sign_in_provider,
    };
  } catch (error) {
    const code = (error as { code?: string }).code || "";
    if (code === "auth/id-token-expired") throw new AppError(401, "TOKEN_EXPIRED", "Your session expired. Sign in again.");
    if (code === "auth/id-token-revoked") throw new AppError(401, "SESSION_REVOKED", "You were signed out. Sign in again.");
    if (code === "auth/user-disabled") throw new AppError(403, "ACCOUNT_DISABLED", "This account has been disabled.");
    throw new AppError(401, "INVALID_TOKEN", "Your session could not be verified. Sign in again.");
  }
}
