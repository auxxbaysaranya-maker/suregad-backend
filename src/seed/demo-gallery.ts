import { Product } from "../models/catalog.model";
import { logger } from "../config/logger";
import { laptopImages, phoneImages } from "./demo";

const PHOTOS_PER_DEMO_LISTING = 4;

/**
 * Gives every demo listing (slug "demo-*") several photos so the product gallery can be tried.
 * Keeps each listing's current cover photo and adds others from the same category.
 * Idempotent: listings that already have enough photos are left alone. Real listings are never touched.
 */
export async function ensureDemoGallery(): Promise<number> {
  const products = await Product.find({ slug: /^demo-\d+$/, deletedAt: null }).select("slug categorySlug images");
  let updated = 0;
  for (const product of products) {
    const current = (product.images || []).filter((image) => image.url || image.key);
    if (current.length >= PHOTOS_PER_DEMO_LISTING) continue;
    const pool = product.categorySlug === "laptops" ? laptopImages : phoneImages;
    const index = Number(product.slug.replace("demo-", "")) || 0;
    const have = new Set(current.map((image) => image.url || image.key));
    const extra: string[] = [];
    for (let step = 0; step < pool.length && current.length + extra.length < PHOTOS_PER_DEMO_LISTING; step += 1) {
      const url = pool[(index + step) % pool.length]!;
      if (!have.has(url) && !extra.includes(url)) extra.push(url);
    }
    const images = [
      ...current.map((image, sort) => ({ key: image.key || image.url, url: image.url || image.key, sort })),
      ...extra.map((url, offset) => ({ key: url, url, sort: current.length + offset })),
    ];
    product.set("images", images);
    await product.save();
    updated += 1;
  }
  logger.info({ updated }, "Demo listings now have multiple photos.");
  return updated;
}
