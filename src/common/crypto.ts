import crypto from "crypto";
import { env } from "../config/env";
import { AppError } from "./errors";

function key(): Buffer {
  if (!env.dataEncryptionKey || env.dataEncryptionKey.length < 32) {
    throw new AppError(
      503,
      "ENCRYPTION_NOT_CONFIGURED",
      "DATA_ENCRYPTION_KEY must be set (32+ characters) before storing device identifiers.",
    );
  }
  return crypto.createHash("sha256").update(env.dataEncryptionKey).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const [ivPart, tagPart, dataPart] = payload.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new AppError(500, "DECRYPT_FAILED", "Stored identifier is malformed.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 32).toString("base64url");
  return `${salt}.${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(".");
  if (!salt || !hash) return false;
  const next = crypto.scryptSync(password, salt, 32);
  const previous = Buffer.from(hash, "base64url");
  if (next.length !== previous.length) return false;
  return crypto.timingSafeEqual(next, previous);
}

export function hashIdentifier(plain: string): string {
  return crypto.createHmac("sha256", key()).update(plain.trim().toUpperCase()).digest("hex");
}

export function lastDigits(plain: string, count = 4): string {
  const clean = plain.replace(/\s+/g, "");
  return clean.slice(-count);
}

export function randomId(size = 12): string {
  return crypto.randomBytes(size).toString("hex");
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "item"}-${randomId(3)}`;
}
