import { User } from "../models/user.model";
import { ensureEmailUser, firebaseConfigured } from "../integrations/firebase";
import { logger } from "../config/logger";

/** Demo accounts that should be able to sign in through Firebase (same password as the panel demo). */
const DEMO_EMAILS = [
  "admin@suregad.dev",
  "store@suregad.dev",
  "seller@suregad.dev",
  "partner@suregad.dev",
  "buyer@suregad.dev",
  "seller@suregad.com",
  "partner@suregad.com",
];
const DEMO_PASSWORD = "123456";

/**
 * Creates a Firebase Authentication login for each demo account that exists in MongoDB and links it
 * (MongoDB keeps roles and approvals). Existing Firebase users are reused; their passwords are not changed.
 */
export async function ensureFirebaseDemoLogins() {
  if (!firebaseConfigured()) throw new Error("Firebase Admin is not configured (FIREBASE_SERVICE_ACCOUNT_PATH).");
  const linked: string[] = [];
  for (const email of DEMO_EMAILS) {
    const user = await User.findOne({ email, status: "active" });
    if (!user) continue;
    const uid = await ensureEmailUser({ email, password: DEMO_PASSWORD, name: user.displayName });
    if (!uid) continue;
    if (user.firebaseUid !== uid) {
      const clash = await User.findOne({ firebaseUid: uid, _id: { $ne: user._id } }).select("email");
      if (clash) {
        logger.warn({ email }, "Firebase uid already linked to another SureGad user; skipped");
        continue;
      }
      user.firebaseUid = uid;
    }
    user.set("emailVerified", true);
    await user.save();
    linked.push(email);
  }
  logger.info({ linked }, "Firebase demo logins ready");
  return linked;
}
