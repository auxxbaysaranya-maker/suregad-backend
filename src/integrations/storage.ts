import { DeleteObjectCommand, PutObjectCommand, S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import { AppError } from "../common/errors";
import { randomId } from "../common/crypto";
import { logger } from "../config/logger";

const PUBLIC_PURPOSES = new Set(["product_image", "product_video", "business_logo", "business_banner", "avatar", "chat_image"]);
const PRIVATE_PURPOSES = new Set([
  "seller_document",
  "partner_document",
  "inspection_evidence",
  "inspection_report",
  "business_document",
]);

const ALLOWED_TYPES: Record<string, string[]> = {
  product_image: ["image/jpeg", "image/png", "image/webp"],
  product_video: ["video/mp4", "video/webm"],
  business_logo: ["image/jpeg", "image/png", "image/webp"],
  business_banner: ["image/jpeg", "image/png", "image/webp"],
  avatar: ["image/jpeg", "image/png", "image/webp"],
  chat_image: ["image/jpeg", "image/png", "image/webp"],
  seller_document: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  partner_document: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  business_document: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  inspection_evidence: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
  inspection_report: ["application/pdf"],
};

const MAX_BYTES: Record<string, number> = {
  product_image: 8 * 1024 * 1024,
  product_video: 80 * 1024 * 1024,
  inspection_evidence: 20 * 1024 * 1024,
  default: 10 * 1024 * 1024,
};

export function storageMode(): "cloudinary" | "s3" | "local" | "not_configured" {
  if (env.cloudinary.cloudName && env.cloudinary.apiKey && env.cloudinary.apiSecret) return "cloudinary";
  if (env.s3.bucket && env.s3.accessKeyId && env.s3.secretAccessKey) return "s3";
  if (env.isProduction) return "not_configured";
  return "local";
}

function cloudinaryClient() {
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
  return cloudinary;
}

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);
const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);

/**
 * How a storage key maps onto Cloudinary. Keys look like "public/product_image/<user>/<id>.jpg" and are
 * the stable identifier saved in MongoDB (ownership checks rely on the path). In Cloudinary:
 *  - images and videos: public_id = key without the extension (Cloudinary adds the format on delivery);
 *  - documents (PDF): "raw" resource whose public_id keeps the extension;
 *  - private/... keys use the "authenticated" delivery type (signed URLs only), public/... use "upload".
 * Keys without an extension (seeded remote images) are images.
 */
export function cloudinaryAsset(key: string) {
  const match = /.([a-z0-9]{2,5})$/i.exec(key);
  const ext = match?.[1]?.toLowerCase() || "";
  const resourceType: "image" | "video" | "raw" = !ext || IMAGE_EXT.has(ext) ? "image" : VIDEO_EXT.has(ext) ? "video" : "raw";
  const publicId = resourceType === "raw" || !match ? key : key.slice(0, -match[0].length);
  const deliveryType: "authenticated" | "upload" = key.startsWith("private/") ? "authenticated" : "upload";
  return { publicId, resourceType, deliveryType, format: resourceType === "raw" ? undefined : ext || undefined };
}

function cloudinaryUrl(key: string, signed: boolean) {
  const asset = cloudinaryAsset(key);
  return cloudinaryClient().url(asset.publicId, {
    secure: true,
    resource_type: asset.resourceType,
    type: asset.deliveryType,
    ...(asset.format ? { format: asset.format } : {}),
    ...(signed || asset.deliveryType === "authenticated" ? { sign_url: true } : {}),
  });
}

function client(): S3Client {
  return new S3Client({
    region: env.s3.region,
    endpoint: env.s3.endpoint || undefined,
    forcePathStyle: env.s3.forcePathStyle,
    credentials: { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey },
  });
}

export function uploadDir(): string {
  return path.resolve(process.cwd(), "uploads");
}

export async function signUpload(input: {
  purpose: string;
  contentType: string;
  size: number;
  userId: string;
}): Promise<{
  key: string;
  uploadUrl: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  fields?: Record<string, string>;
  publicUrl?: string;
}> {
  const allowed = ALLOWED_TYPES[input.purpose];
  if (!allowed) throw new AppError(400, "INVALID_PURPOSE", "Unknown upload purpose.");
  if (!allowed.includes(input.contentType)) {
    throw new AppError(400, "INVALID_FILE_TYPE", "This file type is not allowed for the selected upload.");
  }
  const max = MAX_BYTES[input.purpose] || MAX_BYTES.default;
  if (input.size <= 0 || input.size > max) {
    throw new AppError(400, "FILE_TOO_LARGE", `File exceeds the ${Math.round(max / (1024 * 1024))}MB limit.`);
  }
  const visibility = PRIVATE_PURPOSES.has(input.purpose) ? "private" : "public";
  const ext = input.contentType.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  const key = `${visibility}/${input.purpose}/${input.userId}/${randomId()}.${ext}`;
  const mode = storageMode();
  if (mode === "not_configured") {
    throw new AppError(503, "STORAGE_NOT_CONFIGURED", "Object storage is not configured. Set Cloudinary or S3 credentials.");
  }
  if (mode === "cloudinary") {
    const client = cloudinaryClient();
    const timestamp = Math.round(Date.now() / 1000);
    const { publicId, resourceType, deliveryType } = cloudinaryAsset(key);
    const params = { timestamp, public_id: publicId, type: deliveryType };
    const signature = client.utils.api_sign_request(params, env.cloudinary.apiSecret);
    return {
      key,
      uploadUrl: `https://api.cloudinary.com/v1_1/${env.cloudinary.cloudName}/${resourceType}/upload`,
      method: "POST",
      headers: {},
      fields: {
        api_key: env.cloudinary.apiKey,
        timestamp: String(timestamp),
        signature,
        public_id: publicId,
        type: deliveryType,
      },
      publicUrl: visibility === "public" ? cloudinaryUrl(key, false) : undefined,
    };
  }
  if (mode === "s3") {
    const command = new PutObjectCommand({
      Bucket: env.s3.bucket,
      Key: key,
      ContentType: input.contentType,
    });
    const uploadUrl = await getSignedUrl(client(), command, { expiresIn: 600 });
    const publicUrl =
      visibility === "public" && env.s3.publicBaseUrl ? `${env.s3.publicBaseUrl.replace(/\/$/, "")}/${key}` : undefined;
    return { key, uploadUrl, method: "PUT", headers: { "Content-Type": input.contentType }, publicUrl };
  }
  return {
    key,
    uploadUrl: `/api/v1/uploads/local`,
    method: "POST",
    headers: {},
    publicUrl: visibility === "public" ? `${env.apiPublicUrl}/media/${key}` : undefined,
  };
}

export async function saveLocalUpload(key: string, bytes: Buffer): Promise<void> {
  if (key.includes("..") || !/^(public|private)\//.test(key)) {
    throw new AppError(400, "INVALID_KEY", "Upload key is not allowed.");
  }
  const target = path.join(uploadDir(), key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
}

export async function readLocalUpload(key: string): Promise<Buffer> {
  if (key.includes("..")) throw new AppError(400, "INVALID_KEY", "Upload key is not allowed.");
  return fs.readFile(path.join(uploadDir(), key));
}

export async function signedDownload(key: string): Promise<string> {
  const mode = storageMode();
  if (mode === "cloudinary") {
    return cloudinaryUrl(key, true);
  }
  if (mode !== "s3") return "";
  const command = new GetObjectCommand({ Bucket: env.s3.bucket, Key: key });
  return getSignedUrl(client(), command, { expiresIn: 300 });
}

export function mediaUrl(key?: string | null): string | undefined {
  if (!key) return undefined;
  if (key.startsWith("http")) return key;
  if (storageMode() === "cloudinary") return cloudinaryUrl(key, false);
  if (storageMode() === "s3" && env.s3.publicBaseUrl && key.startsWith("public/")) {
    return `${env.s3.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }
  return `${env.apiPublicUrl}/media/${key}`;
}

export async function uploadRemoteImage(sourceUrl: string, publicId: string): Promise<{ key: string; url: string }> {
  if (storageMode() !== "cloudinary") return { key: sourceUrl, url: sourceUrl };
  const result = await cloudinaryClient().uploader.upload(sourceUrl, {
    public_id: publicId,
    overwrite: true,
    resource_type: "image",
  });
  return { key: result.public_id, url: result.secure_url };
}
/** Store a file generated on the server (seeds, generated reports) under a storage key. */
export async function storeServerFile(key: string, bytes: Buffer, contentType: string): Promise<void> {
  const mode = storageMode();
  if (mode === "cloudinary") {
    const asset = cloudinaryAsset(key);
    await cloudinaryClient().uploader.upload(`data:${contentType};base64,${bytes.toString("base64")}`, {
      public_id: asset.publicId,
      type: asset.deliveryType,
      resource_type: asset.resourceType,
      overwrite: true,
    });
    return;
  }
  if (mode === "s3") {
    await client().send(new PutObjectCommand({ Bucket: env.s3.bucket, Key: key, Body: bytes, ContentType: contentType }));
    return;
  }
  await saveLocalUpload(key, bytes);
}

/** Whether a stored file exists (used before attaching an upload to a record). */
export async function storedFileExists(key: string): Promise<boolean> {
  const mode = storageMode();
  try {
    if (mode === "cloudinary") {
      const asset = cloudinaryAsset(key);
      await cloudinaryClient().api.resource(asset.publicId, { resource_type: asset.resourceType, type: asset.deliveryType });
      return true;
    }
    if (mode === "local") {
      await fs.access(path.join(uploadDir(), key));
      return true;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Permanently removes stored files. Best effort: a storage failure is logged and never fails the
 * request that removed the file from its record. Remote URLs (seed images) are skipped.
 * Callers must check the key is no longer referenced anywhere (see files.service).
 */
export async function deleteStoredFiles(keys: (string | null | undefined)[]): Promise<number> {
  const mode = storageMode();
  let removed = 0;
  for (const key of new Set(keys.filter((value): value is string => Boolean(value)))) {
    if (/^https?:/i.test(key) || key.includes("..")) continue;
    try {
      if (mode === "cloudinary") {
        const asset = cloudinaryAsset(key);
        const result = (await cloudinaryClient().uploader.destroy(asset.publicId, { resource_type: asset.resourceType, type: asset.deliveryType, invalidate: true })) as { result?: string };
        if (result.result === "ok") removed += 1;
      } else if (mode === "s3") {
        await client().send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }));
        removed += 1;
      } else if (mode === "local") {
        await fs.rm(path.join(uploadDir(), key), { force: true });
        removed += 1;
      }
    } catch (error) {
      logger.warn({ key, reason: (error as Error).message }, "Stored file could not be deleted");
    }
  }
  return removed;
}

/** Delivery URL for a stored image: built from the key so it follows the active storage (Cloudinary). */
export function storedImageUrl(image: { key?: string | null; url?: string | null }): string | undefined {
  if (image.key && !/^https?:/i.test(image.key)) return mediaUrl(image.key);
  return image.url || mediaUrl(image.key);
}
