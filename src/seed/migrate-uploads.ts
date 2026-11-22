import fs from "fs/promises";
import path from "path";
import { logger } from "../config/logger";
import { Product } from "../models/catalog.model";
import { mediaUrl, storageMode, storeServerFile, storedFileExists, uploadDir } from "../integrations/storage";

const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
};

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : Promise.resolve([path.join(dir, entry.name)]))));
  return nested.flat();
}

/**
 * Copies files saved by the local development driver (server/uploads) to Cloudinary under the same
 * keys, then refreshes stored listing photo URLs. Safe to run again: files already in Cloudinary are skipped.
 */
export async function migrateLocalUploads() {
  if (storageMode() !== "cloudinary") throw new Error("Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET first.");
  const root = uploadDir();
  const files = await walk(root);
  let copied = 0;
  let skipped = 0;
  for (const file of files) {
    const key = path.relative(root, file).split(path.sep).join("/");
    const ext = key.split(".").pop()?.toLowerCase() || "";
    if (!/^(public|private)\//.test(key) || !TYPES[ext]) continue;
    if (await storedFileExists(key)) {
      skipped += 1;
      continue;
    }
    await storeServerFile(key, await fs.readFile(file), TYPES[ext]!);
    copied += 1;
  }
  const products = await Product.find({ "images.key": { $regex: "^public/" } }).select("images");
  let updated = 0;
  for (const product of products) {
    let changed = false;
    for (const image of product.images || []) {
      const url = image.key ? mediaUrl(image.key) : undefined;
      if (url && image.url !== url) {
        image.url = url;
        changed = true;
      }
    }
    if (changed) {
      await product.save();
      updated += 1;
    }
  }
  logger.info({ copied, alreadyThere: skipped, listingsUpdated: updated }, "Local uploads migrated to Cloudinary");
}
