/**
 * Test helper for the Firebase UI checks.
 *   reset-code <email>  → prints a real password-reset oobCode for a test account
 *   cleanup             → deletes Firebase + MongoDB data of all e2e.* test accounts (example.com)
 * Run: node scripts/with-system-ca.mjs tsx scripts/e2e-firebase-users.ts <command> [email]
 */
import fs from "fs";
import admin from "firebase-admin";
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { connectDb } from "../src/config/db";
import { User } from "../src/models/user.model";
import { Business, BuyerProfile, PartnerProfile, SellerProfile } from "../src/models/profiles.model";
import { DeviceToken } from "../src/models/device-token.model";
import { Notification } from "../src/models/engagement.model";

const TEST_EMAIL = /^e2e\.[a-z]+\.[a-z0-9]+@example\.com$/;

async function main() {
  const [command, email] = process.argv.slice(2);
  const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(env.firebase.serviceAccountPath, "utf8"))) }, "e2e-helper");
  const auth = admin.auth(app);
  if (command === "reset-code") {
    if (!email || !TEST_EMAIL.test(email)) throw new Error("Only e2e.*@example.com test accounts.");
    const link = await auth.generatePasswordResetLink(email);
    console.log(`OOB=${new URL(link).searchParams.get("oobCode")}`);
    return;
  }
  if (command === "cleanup") {
    const uids: string[] = [];
    let page: string | undefined;
    do {
      const result = await auth.listUsers(1000, page);
      for (const user of result.users) if (user.email && TEST_EMAIL.test(user.email)) uids.push(user.uid);
      page = result.pageToken;
    } while (page);
    for (const uid of uids) await auth.deleteUser(uid);
    await connectDb();
    const users = await User.find({ $or: [{ firebaseUid: { $in: uids } }, { email: TEST_EMAIL }] }).select("_id").lean();
    const ids = users.map((user) => user._id);
    await Promise.all([
      User.deleteMany({ _id: { $in: ids } }),
      BuyerProfile.deleteMany({ userId: { $in: ids } }),
      SellerProfile.deleteMany({ userId: { $in: ids } }),
      PartnerProfile.deleteMany({ userId: { $in: ids } }),
      Business.deleteMany({ ownerId: { $in: ids } }),
      DeviceToken.deleteMany({ userId: { $in: ids } }),
      Notification.deleteMany({ userId: { $in: ids } }),
    ]);
    console.log(`cleanup: ${uids.length} Firebase users, ${ids.length} MongoDB users removed`);
    await mongoose.disconnect();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
