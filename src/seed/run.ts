import { Role } from "../models/user.model";
import { Brand, Category } from "../models/catalog.model";
import { SubscriptionPlan } from "../models/commerce.model";
import { InspectionPlan } from "../models/inspection.model";
import { PlatformSetting } from "../models/engagement.model";
import { brandSeeds, categorySeeds, inspectionPlanSeeds, planSeeds, platformSeed, roleSeeds } from "./data";

export async function seedSystemData(): Promise<void> {
  for (const role of roleSeeds) {
    await Role.updateOne({ key: role.key }, { $setOnInsert: role }, { upsert: true });
  }
  for (const category of categorySeeds) {
    await Category.updateOne({ slug: category.slug }, { $setOnInsert: category }, { upsert: true });
  }
  for (const brand of brandSeeds) {
    await Brand.updateOne({ slug: brand.slug }, { $setOnInsert: brand }, { upsert: true });
  }
  for (const plan of planSeeds) {
    await SubscriptionPlan.updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true });
  }
  for (const plan of inspectionPlanSeeds) {
    await InspectionPlan.updateOne({ code: plan.code }, { $setOnInsert: plan }, { upsert: true });
  }
  await PlatformSetting.updateOne({ key: "platform" }, { $setOnInsert: { key: "platform", value: platformSeed } }, { upsert: true });
}
