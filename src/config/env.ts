import dotenv from "dotenv";
import fs from "fs";
import path from "path";

/**
 * The folder holding package.json (and .env). Found by walking up from the running script and
 * the working directory, so it works for `tsx src/server.ts`, the bundled `dist/server.cjs`, and tests.
 * (import.meta is not available in the CommonJS bundle.)
 */
function findServerRoot(): string {
  const starts = [process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : "", process.cwd()].filter(Boolean);
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 6; depth += 1) {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

const serverRoot = findServerRoot();

if (process.env.NODE_ENV !== "test") {
  // Real environment variables (e.g. set on Render) win over the .env file.
  dotenv.config({ path: path.join(serverRoot, ".env"), override: false, quiet: true });
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

const nodeEnv = process.env.NODE_ENV || "development";

/** The published SureGad web app (GitHub Pages). Always allowed to call this API. */
const PUBLISHED_WEB_APP = "https://auxxbaysaranya-maker.github.io/suregad-frontend";

const isLocal = (value?: string) => !value || /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(value);
/** Render sets RENDER_EXTERNAL_URL; prefer it over a value still pointing at localhost. */
const hostUrl = process.env.RENDER_EXTERNAL_URL;

const appUrl = !isLocal(process.env.APP_URL) ? process.env.APP_URL! : hostUrl ? PUBLISHED_WEB_APP : process.env.APP_URL || "http://localhost:5173";

const clientOrigins = [
  ...(process.env.CLIENT_ORIGIN || "http://localhost:5173").split(","),
  new URL(PUBLISHED_WEB_APP).origin,
  new URL(appUrl).origin,
]
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter((origin, index, all) => origin && all.indexOf(origin) === index);

export const env = {
  nodeEnv,
  isProduction: nodeEnv === "production",
  isTest: nodeEnv === "test",
  port: Number(process.env.PORT || 4000),
  clientOrigins,
  appUrl,
  apiPublicUrl: !isLocal(process.env.API_PUBLIC_URL) ? process.env.API_PUBLIC_URL! : hostUrl || process.env.API_PUBLIC_URL || "http://localhost:4000",
  mongoUri: process.env.MONGODB_URI || "",
  redisUrl: process.env.REDIS_URL || "",
  adminBootstrapEmails: (process.env.ADMIN_BOOTSTRAP_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY || "",
  allowDevAuth: !bool(String(nodeEnv === "production")) && bool(process.env.ALLOW_DEV_AUTH),
  devAuthSecret: process.env.DEV_AUTH_SECRET || "",
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || "",
    privateKey: process.env.FIREBASE_PRIVATE_KEY || "",
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
    apiSecret: process.env.CLOUDINARY_API_SECRET || "",
  },
  s3: {
    endpoint: process.env.S3_ENDPOINT || "",
    region: process.env.S3_REGION || "ap-south-1",
    bucket: process.env.S3_BUCKET || "",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || "",
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE),
  },
  paymentProvider: process.env.PAYMENT_PROVIDER || "razorpay",
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  },
  ai: {
    provider: process.env.AI_PROVIDER || "openai",
    apiKey: process.env.AI_API_KEY || "",
    baseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
    model: process.env.AI_MODEL || "gpt-4o-mini",
    monthlyTokenBudget: Number(process.env.AI_MONTHLY_TOKEN_BUDGET || 200000),
  },
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "SureGad <noreply@suregad.com>",
  },
  sms: {
    provider: process.env.SMS_PROVIDER || "",
    apiKey: process.env.SMS_API_KEY || "",
    senderId: process.env.SMS_SENDER_ID || "SUREGD",
  },
  whatsapp: {
    provider: process.env.WHATSAPP_PROVIDER || "",
    apiKey: process.env.WHATSAPP_API_KEY || "",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "mailto:support@suregad.com",
  },
};

export function integrationStatus() {
  const firebaseConfigured = Boolean(
    (env.firebase.projectId && env.firebase.clientEmail && env.firebase.privateKey) ||
      env.firebase.credentialsPath,
  );
  const paymentsConfigured =
    env.paymentProvider === "razorpay"
      ? Boolean(env.razorpay.keyId && env.razorpay.keySecret && env.razorpay.webhookSecret)
      : env.paymentProvider === "mock" && !env.isProduction;
  return {
    environment: env.nodeEnv,
    database: Boolean(env.mongoUri),
    redis: Boolean(env.redisUrl),
    firebaseAdmin: firebaseConfigured,
    devAuth: env.allowDevAuth && Boolean(env.devAuthSecret),
    payments: paymentsConfigured
      ? env.isProduction
        ? "razorpay"
        : env.paymentProvider
      : "not_configured",
    storage:
      env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret
        ? "cloudinary"
        : env.s3.bucket && env.s3.accessKeyId
          ? "s3"
          : env.isProduction
            ? "not_configured"
            : "local",
    webPush: Boolean(env.vapid.publicKey && env.vapid.privateKey),
    ai: Boolean(env.ai.apiKey),
    email: Boolean(env.smtp.host),
    sms: Boolean(env.sms.provider && env.sms.apiKey),
    whatsapp: Boolean(env.whatsapp.provider && env.whatsapp.apiKey),
    encryption: Boolean(env.dataEncryptionKey && env.dataEncryptionKey.length >= 32),
  };
}
