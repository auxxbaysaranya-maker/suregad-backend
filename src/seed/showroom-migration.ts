import { Business } from "../models/profiles.model";
import { Product } from "../models/catalog.model";
import { PlatformSetting } from "../models/engagement.model";
import { InventoryMovement, InventoryUnit, nextCode } from "../models/showroom.model";
import { ensureBusinessSubscription } from "../services/showroom.service";
import { syncListingStock } from "../services/inventory.service";
import { logger } from "../config/logger";

const KEY = "migration.showroom.v1";

/**
 * Brings showrooms created before the showroom role onto the new model. Runs once.
 * - "pending" applications become "submitted"; non-draft showrooms get an SG-SH code.
 * - Approved showrooms get the free business plan if they have none.
 * - Existing single-device showroom listings become stock-tracked listings with one unit,
 *   carrying the listing's encrypted IMEI/serial across unchanged.
 */
export async function migrateShowrooms(): Promise<void> {
  if (await PlatformSetting.exists({ key: KEY })) return;
  await Business.updateMany({ verificationStatus: "pending" }, { $set: { verificationStatus: "submitted" } });
  const businesses = await Business.find({ deletedAt: null });
  let units = 0;
  for (const business of businesses) {
    let changed = false;
    if (!business.code && business.verificationStatus !== "draft") {
      business.code = await nextCode("SH");
      changed = true;
    }
    for (const doc of business.documents) {
      if (!doc.kind) {
        doc.kind = "other";
        changed = true;
      }
    }
    if (!business.statusHistory.length) {
      business.statusHistory.push({ status: business.verificationStatus, note: "Migrated", at: business.createdAt || new Date() } as never);
      changed = true;
    }
    if (changed) await business.save();
    if (business.verificationStatus === "approved") await ensureBusinessSubscription(business._id);

    const products = await Product.find({ businessId: business._id, stockTracked: { $ne: true } });
    for (const product of products) {
      if (!product.listingCode) product.listingCode = await nextCode("LIST");
      const convertible = !product.deletedAt && ["active", "pending_review", "draft", "rejected"].includes(product.status) && product.inventory?.state === "available";
      if (convertible && !(await InventoryUnit.exists({ productId: product._id }))) {
        const id = product.identifier || {};
        const unit = await InventoryUnit.create({
          code: await nextCode("UNIT"),
          businessId: business._id,
          productId: product._id,
          status: "AVAILABLE",
          condition: product.condition,
          imeiHash: id.imeiHash && !id.imeiHash.startsWith("archived:") ? id.imeiHash : undefined,
          imeiLast4: id.imeiLast4,
          imeiCipher: id.imeiCipher,
          serialHash: id.serialHash && !id.serialHash.startsWith("archived:") ? id.serialHash : undefined,
          serialLast4: id.serialLast4,
          serialCipher: id.serialCipher,
          colour: (product.specs as { colour?: string })?.colour,
          storageGb: (product.specs as { storageGb?: number })?.storageGb,
          ramGb: (product.specs as { ramGb?: number })?.ramGb,
          pricePaise: product.pricePaise,
        });
        await InventoryMovement.create({ businessId: business._id, unitId: unit._id, productId: product._id, to: "AVAILABLE", reason: "migrated_from_listing" });
        product.stockTracked = true;
        // A migrated single device is "low stock" by definition; don't flood the owner with alerts.
        product.lowStockNotifiedAt = new Date();
        product.priceHistory.push({ pricePaise: product.pricePaise, reason: "migrated", at: new Date() } as never);
        units += 1;
      }
      await product.save();
      if (product.stockTracked) await syncListingStock(product._id);
    }
  }
  await PlatformSetting.create({ key: KEY, value: { at: new Date(), businesses: businesses.length, units } });
  logger.info({ businesses: businesses.length, units }, "Showroom migration complete");
}
