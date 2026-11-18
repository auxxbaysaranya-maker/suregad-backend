import { connectDb, disconnectDb } from "../config/db";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { seedSystemData } from "./run";
import { demoPassword, seedDemoData } from "./demo";

async function main() {
  if (!env.mongoUri) throw new Error("MONGODB_URI is required to seed configuration.");
  await connectDb();
  if (process.argv.includes("--demo")) {
    await seedDemoData();
    logger.info({ password: demoPassword }, "Demo users are ready. Firebase email sign-in uses this password when Firebase Admin is configured. Local sign-in uses the same email.");
  } else {
    await seedSystemData();
    logger.info("System configuration seed completed. No users or transactions were created.");
  }
  await disconnectDb();
}

main().catch((error) => {
  logger.error(error);
  process.exit(1);
});
