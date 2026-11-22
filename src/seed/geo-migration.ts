import { Product } from "../models/catalog.model";
import { Business, PartnerProfile, SellerProfile } from "../models/profiles.model";
import { logger } from "../config/logger";

/**
 * Keeps geo data indexable on every start (cheap when there is nothing to fix):
 * removes half-empty GeoJSON points left by older code, then makes sure each 2dsphere index exists.
 */
export async function repairGeoData(): Promise<void> {
  const models = [Product, Business, SellerProfile, PartnerProfile] as const;
  let repaired = 0;
  for (const model of models) {
    const result = await (model as typeof Product).updateMany(
      { location: { $exists: true }, "location.coordinates.1": { $exists: false } },
      { $unset: { location: 1 } },
    );
    repaired += result.modifiedCount;
    await (model as typeof Product).createIndexes().catch((error) => logger.warn({ err: error, model: model.modelName }, "Index build failed"));
  }
  if (repaired) logger.info({ repaired }, "Removed incomplete map locations");
}
