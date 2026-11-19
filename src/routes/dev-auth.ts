import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { AppError } from "../common/errors";
import { asyncHandler, sendData } from "../common/http";
import { signDevToken } from "../integrations/firebase";
import { User } from "../models/user.model";
import { verifyPassword } from "../common/crypto";

export const devAuth = Router();

devAuth.post(
  "/auth/dev-login",
  asyncHandler(async (req, res) => {
    if (!env.allowDevAuth) throw new AppError(404, "NOT_FOUND", "Route not found.");
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z.string().email().optional(),
        uid: z.string().trim().min(3).max(80).optional(),
      })
      .parse(req.body);
    const uid = body.uid || `dev:${body.email || body.name.toLowerCase().replace(/\s+/g, "-")}`;
    // Never mint a token for an account protected by a password or holding admin/panel roles:
    // those accounts must sign in with their credentials.
    const existing = await User.findOne({ $or: [{ firebaseUid: uid }, ...(body.email ? [{ email: body.email.toLowerCase() }] : [])] })
      .select("passwordHash roles")
      .lean();
    if (existing && (existing.passwordHash || existing.roles?.some((role) => ["super_admin", "business_seller", "service_partner"].includes(role)))) {
      throw new AppError(403, "USE_PASSWORD", "This account signs in with its password.");
    }
    const token = signDevToken({
      uid,
      name: body.name,
      email: body.email,
    });
    sendData(res, { token, developmentOnly: true });
  }),
);

/** Email + password sign-in for accounts that have a password (demo and panel accounts), any role. */
devAuth.post(
  "/auth/password-login",
  asyncHandler(async (req, res) => {
    if (!env.allowDevAuth) throw new AppError(404, "NOT_FOUND", "Route not found.");
    const body = z.object({ email: z.string().email(), password: z.string().min(6).max(80) }).parse(req.body);
    const email = body.email.toLowerCase();
    const user = await User.findOne({ email, status: "active" }).select("passwordHash firebaseUid displayName");
    if (!user?.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      throw new AppError(401, "INVALID_LOGIN", "Email or password is incorrect.");
    }
    sendData(res, { token: signDevToken({ uid: user.firebaseUid, email, name: user.displayName }) });
  }),
);
