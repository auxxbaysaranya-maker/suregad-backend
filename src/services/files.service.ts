import { Product } from "../models/catalog.model";
import { Order } from "../models/commerce.model";
import { deleteStoredFiles } from "../integrations/storage";
import { logger } from "../config/logger";

/**
 * Removes files from storage (Cloudinary in production) once nothing points at them any more.
 * Always called AFTER the record change is saved, and never throws: a failed clean-up only leaves
 * an unused file behind, it never breaks the user's action.
 */

function stored(keys: (string | null | undefined)[]) {
  return [...new Set(keys.filter((key): key is string => Boolean(key) && !/^https?:/i.test(key!)))];
}

/** Listing photos can be shared (duplicated listings, demo data), so only unreferenced ones go. */
export async function releaseProductImages(keys: (string | null | undefined)[]) {
  const candidates = stored(keys);
  if (!candidates.length) return;
  try {
    const inUse = new Set((await Product.distinct("images.key", { "images.key": { $in: candidates } })) as string[]);
    await deleteStoredFiles(candidates.filter((key) => !inUse.has(key)));
  } catch (error) {
    logger.warn({ reason: (error as Error).message }, "Listing photo clean-up failed");
  }
}

/** Files owned by exactly one record (logos, banners, documents) that were replaced or removed. */
export async function releaseFiles(keys: (string | null | undefined)[]) {
  const candidates = stored(keys);
  if (!candidates.length) return;
  try {
    await deleteStoredFiles(candidates);
  } catch (error) {
    logger.warn({ reason: (error as Error).message }, "File clean-up failed");
  }
}

/**
 * A deleted listing's photos are removed unless an order still shows them (order history keeps
 * linking to the listing). The archived record then no longer lists the removed photos.
 */
export async function releaseArchivedListingImages(productId: string) {
  try {
    const product = await Product.findById(productId).select("images deletedAt");
    if (!product?.deletedAt || !product.images?.length) return;
    const ordered = await Order.exists({ $or: [{ "items.productId": product._id }, { "subOrders.items.productId": product._id }] });
    if (ordered) return;
    const keys = product.images.map((image) => image.key);
    product.set("images", []);
    await product.save();
    await releaseProductImages(keys);
  } catch (error) {
    logger.warn({ productId, reason: (error as Error).message }, "Archived listing clean-up failed");
  }
}
