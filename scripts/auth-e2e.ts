/**
 * End-to-end checks of Firebase sign-in against the running local API (http://localhost:4000)
 * and the real Firebase project. Creates throwaway accounts and deletes them afterwards.
 * Run: node scripts/with-system-ca.mjs tsx scripts/auth-e2e.ts
 */
import fs from "fs";
import admin from "firebase-admin";
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { connectDb } from "../src/config/db";
import { User } from "../src/models/user.model";
import { Business, BuyerProfile, SellerProfile } from "../src/models/profiles.model";
import { DeviceToken } from "../src/models/device-token.model";
import { Notification } from "../src/models/engagement.model";
import { sendPushToUsers } from "../src/services/push.service";

const API = "http://localhost:4000/api/v1";
const WEB_API_KEY = process.env.E2E_FIREBASE_WEB_API_KEY || "";
let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
};

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(API + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = (await response.json().catch(() => ({}))) as { data?: any; error?: { code?: string; message?: string } };
  return { status: response.status, ...json };
}

async function identity(action: string, body: Record<string, unknown>) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${WEB_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await response.json()) as { idToken?: string; localId?: string; email?: string; error?: { message?: string } };
}

const createdUids: string[] = [];
const createdEmails: string[] = [];

async function main() {
  if (!WEB_API_KEY) throw new Error("Set E2E_FIREBASE_WEB_API_KEY");
  const app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(env.firebase.serviceAccountPath, "utf8"))) }, "e2e");
  const auth = admin.auth(app);
  await connectDb();
  const stamp = Date.now().toString(36);

  // 1. Email/password sign-up through Firebase, then the SureGad session.
  const email = `e2e.buyer.${stamp}@example.com`;
  const signUp = await identity("signUp", { email, password: "Test-pass-2026!", returnSecureToken: true });
  if (signUp.error) {
    check("Firebase email/password sign-up", false, signUp.error.message);
    return;
  }
  createdUids.push(signUp.localId!);
  createdEmails.push(email);
  check("Firebase email/password sign-up", Boolean(signUp.idToken));
  const session = await call("POST", "/auth/session", undefined, { token: signUp.idToken, name: "E2E Buyer" });
  check("session creates the MongoDB user as a buyer", session.status === 200 && session.data?.roles?.join() === "buyer" && session.data?.displayName === "E2E Buyer", `${session.status} ${session.error?.code || ""}`);
  check("profile reports the email as not verified yet", session.data?.emailVerified === false);
  const again = await call("POST", "/auth/session", undefined, { token: signUp.idToken });
  check("signing in again reuses the same user (no duplicate)", again.data?.id === session.data?.id && (await User.countDocuments({ firebaseUid: signUp.localId })) === 1);
  const me = await call("GET", "/auth/me", signUp.idToken);
  check("protected API accepts the Firebase ID token", me.status === 200);

  // 2. Bad tokens.
  const forged = await call("GET", "/auth/me", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl");
  check("forged token rejected", forged.status === 401, forged.error?.code);
  const tampered = await call("GET", "/auth/me", signUp.idToken!.slice(0, -4) + "AAAA");
  check("tampered token rejected", tampered.status === 401, tampered.error?.code);
  const none = await call("GET", "/auth/me");
  check("no token rejected", none.status === 401, none.error?.code);

  // 3. Role escalation attempts.
  await call("PATCH", "/auth/me", signUp.idToken, { roles: ["super_admin"], displayName: "E2E Buyer" });
  const after = await User.findOne({ firebaseUid: signUp.localId }).lean();
  check("PATCH /auth/me cannot change roles", after?.roles.join() === "buyer");
  const adminAttempt = await call("GET", "/admin/metrics", signUp.idToken);
  check("customer blocked from admin API", adminAttempt.status === 403, String(adminAttempt.status));
  const sellerAttempt = await call("GET", "/showroom/dashboard", signUp.idToken);
  check("customer blocked from showroom API", sellerAttempt.status === 403 || sellerAttempt.status === 404, String(sellerAttempt.status));
  const enrolAdmin = await call("POST", "/auth/panel-enroll", signUp.idToken, { panel: "admin", name: "E2E" });
  check("cannot enrol in the admin panel", enrolAdmin.status === 400, String(enrolAdmin.status));
  const enrolSeller = await call("POST", "/auth/panel-enroll", signUp.idToken, { panel: "showroom", name: "E2E Showroom" });
  const business = await Business.findOne({ ownerId: after?._id }).lean();
  check("seller sign-up starts a draft showroom (not approved)", enrolSeller.status === 200 && enrolSeller.data?.roles.includes("business_seller") && business?.verificationStatus === "draft", `${enrolSeller.status} ${enrolSeller.error?.code || ""} ${enrolSeller.error?.message || ""} business=${business?.verificationStatus}`);
  const stillBlocked = await call("GET", "/showroom/dashboard", signUp.idToken);
  check("unapproved showroom still blocked from seller tools", stillBlocked.status === 403, stillBlocked.error?.code);

  // 4. Account takeover protection: unverified email matching an existing account.
  const existing = await User.findOne({ email: "buyer@suregad.dev" }).lean();
  if (existing) {
    const takeover = await identity("signUp", { email: "buyer@suregad.dev", password: "Takeover-2026!", returnSecureToken: true });
    if (takeover.localId) createdUids.push(takeover.localId);
    const takeoverSession = takeover.idToken ? await call("POST", "/auth/session", undefined, { token: takeover.idToken }) : null;
    const unchanged = await User.findById(existing._id).lean();
    check("unverified email cannot claim an existing account", takeoverSession?.status === 409 && takeoverSession.error?.code === "VERIFY_EMAIL_TO_LINK" && unchanged?.firebaseUid === existing.firebaseUid, `${takeoverSession?.status} ${takeoverSession?.error?.code}`);
  }

  // 5. Device tokens.
  const fakeToken = `e2e${stamp}:` + "A".repeat(150);
  const reg = await call("POST", "/notifications/fcm-token", signUp.idToken, { token: fakeToken, app: "marketplace" });
  check("device token registered for the signed-in user", reg.status === 200 && (await DeviceToken.countDocuments({ token: fakeToken, userId: after?._id })) === 1);
  const regAgain = await call("POST", "/notifications/fcm-token", signUp.idToken, { token: fakeToken, app: "marketplace" });
  check("same token twice stays one record", regAgain.status === 200 && (await DeviceToken.countDocuments({ token: fakeToken })) === 1);
  const junk = await call("POST", "/notifications/fcm-token", signUp.idToken, { token: "short", app: "marketplace" });
  check("malformed token rejected", junk.status === 400);

  const email2 = `e2e.other.${stamp}@example.com`;
  const other = await identity("signUp", { email: email2, password: "Test-pass-2026!", returnSecureToken: true });
  createdUids.push(other.localId!);
  createdEmails.push(email2);
  await call("POST", "/auth/session", undefined, { token: other.idToken });
  const steal = await call("DELETE", "/notifications/fcm-token", other.idToken, { token: fakeToken });
  check("another user cannot remove someone else's token", steal.data?.removed === false && (await DeviceToken.countDocuments({ token: fakeToken })) === 1);

  // 6. Real FCM send: Firebase rejects the fake token and the service removes it.
  const push = await sendPushToUsers([after!._id], { title: "E2E", body: "Push test", path: "/account" });
  check("FCM send reaches Firebase and cleans up the dead token", push.failed === 1 && push.removed === 1 && (await DeviceToken.countDocuments({ token: fakeToken })) === 0, JSON.stringify(push));

  const token2 = `e2f${stamp}:` + "B".repeat(150);
  await call("POST", "/notifications/fcm-token", signUp.idToken, { token: token2, app: "panel" });
  const out = await call("POST", "/auth/logout", signUp.idToken, { pushToken: token2 });
  check("logout removes this device's token", out.status === 200 && (await DeviceToken.countDocuments({ token: token2 })) === 0);

  // 7. Password reset with Firebase action codes.
  const link = await auth.generatePasswordResetLink(email);
  const oobCode = new URL(link).searchParams.get("oobCode")!;
  const bad = await identity("resetPassword", { oobCode: "not-a-real-code", newPassword: "New-pass-2026!" });
  check("invalid reset code rejected", bad.error?.message === "INVALID_OOB_CODE", bad.error?.message);
  const reset = await identity("resetPassword", { oobCode, newPassword: "New-pass-2026!" });
  check("password reset with a valid code", reset.email === email, reset.error?.message);
  const oldLogin = await identity("signInWithPassword", { email, password: "Test-pass-2026!", returnSecureToken: true });
  const newLogin = await identity("signInWithPassword", { email, password: "New-pass-2026!", returnSecureToken: true });
  check("old password stops working, new password signs in", Boolean(oldLogin.error) && Boolean(newLogin.idToken), oldLogin.error?.message);
  const reused = await identity("resetPassword", { oobCode, newPassword: "Another-pass-2026!" });
  check("a reset code works only once", Boolean(reused.error), reused.error?.message);

  // 8. Disabled account.
  await auth.updateUser(signUp.localId!, { disabled: true });
  const disabled = await call("POST", "/auth/session", undefined, { token: newLogin.idToken });
  check("disabled Firebase account cannot start a session", disabled.status === 403 && disabled.error?.code === "ACCOUNT_DISABLED", `${disabled.status} ${disabled.error?.code}`);

  // 9. Email verification flag follows Firebase.
  await auth.updateUser(other.localId!, { emailVerified: true });
  const otherFresh = await identity("signInWithPassword", { email: email2, password: "Test-pass-2026!", returnSecureToken: true });
  const verified = await call("POST", "/auth/session", undefined, { token: otherFresh.idToken });
  check("verified email reflected in the profile", verified.data?.emailVerified === true);
}

main()
  .catch((error) => {
    failed++;
    console.error("ERROR", error instanceof Error ? error.message : error);
  })
  .finally(async () => {
    // Cleanup: Firebase users, MongoDB users and anything attached to them.
    try {
      const app = admin.app("e2e");
      for (const uid of createdUids) await admin.auth(app).deleteUser(uid).catch(() => undefined);
      const users = await User.find({ firebaseUid: { $in: createdUids } }).select("_id").lean();
      const ids = users.map((user) => user._id);
      await Promise.all([
        User.deleteMany({ _id: { $in: ids } }),
        BuyerProfile.deleteMany({ userId: { $in: ids } }),
        SellerProfile.deleteMany({ userId: { $in: ids } }),
        Business.deleteMany({ ownerId: { $in: ids } }),
        DeviceToken.deleteMany({ userId: { $in: ids } }),
        Notification.deleteMany({ userId: { $in: ids } }),
      ]);
      console.log(`cleanup: removed ${createdUids.length} Firebase users and ${ids.length} MongoDB users`);
    } catch (error) {
      console.error("cleanup failed", error);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    await mongoose.disconnect();
    process.exit(failed ? 1 : 0);
  });
