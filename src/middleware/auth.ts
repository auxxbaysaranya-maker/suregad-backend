import type { NextFunction, Request, Response } from "express";
import { Role, User } from "../models/user.model";
import { BusinessEmployee } from "../models/profiles.model";
import { verifyIdentity } from "../integrations/firebase";
import { AppError, forbidden, unauthenticated } from "../common/errors";
import { BuyerProfile } from "../models/profiles.model";

const cache = new Map<string, { permissions: string[]; at: number }>();

export async function permissionsFor(roles: string[], grants: { permissions: string[] }[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const role of roles) {
    const cached = cache.get(role);
    const fresh = cached && Date.now() - cached.at < 60_000 ? cached : null;
    let permissions = fresh?.permissions;
    if (!permissions) {
      const doc = await Role.findOne({ key: role });
      permissions = doc?.permissions || [];
      cache.set(role, { permissions, at: Date.now() });
    }
    if (permissions.includes("*")) return new Set(["*"]);
    permissions.forEach((permission) => set.add(permission));
  }
  for (const grant of grants) {
    for (const permission of grant.permissions || []) {
      if (permission.startsWith("admin.")) continue;
      set.add(permission);
    }
  }
  return set;
}

export function clearPermissionCache(): void {
  cache.clear();
}

export async function requireUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) throw unauthenticated();
    const identity = await verifyIdentity(header.slice(7).trim());
    const user = await User.findOne({ firebaseUid: identity.uid, deletedAt: null });
    if (!user) throw new AppError(401, "USER_NOT_FOUND", "Sign in again to create your SureGad profile.");
    if (user.status === "suspended") {
      throw new AppError(403, "ACCOUNT_SUSPENDED", user.suspendedReason || "This account is suspended.");
    }
    if (user.status === "deleted") throw unauthenticated("This account has been deleted.");
    if (user.tokenValidAfter && identity.authTime && identity.authTime * 1000 < user.tokenValidAfter.getTime()) {
      throw new AppError(401, "SESSION_REVOKED", "This session was revoked. Sign in again.");
    }
    req.user = user as Express.Request["user"];
    req.emailVerified = identity.emailVerified !== false;
    req.permissions = await permissionsFor(user.roles, user.employeeGrants || []);
    next();
  } catch (error) {
    next(error);
  }
}

export function requirePermission(...required: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const granted = req.permissions;
    if (!req.user || !granted) return next(unauthenticated());
    if (granted.has("*") || required.every((permission) => granted.has(permission))) return next();
    return next(forbidden());
  };
}

export async function ensureBuyerProfile(userId: string): Promise<void> {
  await BuyerProfile.updateOne({ userId }, { $setOnInsert: { userId, addresses: [], wishlist: [] } }, { upsert: true });
}

export function assertBusinessPermission(req: Request, businessId: string, permission: string): void {
  if (req.permissions?.has("*")) return;
  const ownsRole = req.user?.roles.includes("business_seller");
  const grant = req.user?.employeeGrants?.find((item) => String(item.businessId) === businessId);
  if ((grant?.permissions || []).includes(permission)) return;
  if (ownsRole && req.permissions?.has(permission)) return;
  throw forbidden();
}

export async function linkEmployeeInvites(user: {
  _id: unknown;
  email?: string | null;
  roles: string[];
  employeeGrants: { businessId?: unknown; permissions?: string[] }[];
}): Promise<void> {
  if (!user.email) return;
  const invites = await BusinessEmployee.find({ email: user.email.toLowerCase(), status: "invited" });
  if (!invites.length) return;
  for (const invite of invites) {
    invite.userId = user._id as never;
    invite.status = "active";
    await invite.save();
    const permissions = invite.permissions.filter((permission) => !permission.startsWith("admin."));
    user.employeeGrants.push({ businessId: invite.businessId, permissions: permissions });
  }
  if (!user.roles.includes("business_employee")) user.roles.push("business_employee");
  await User.updateOne(
    { _id: user._id },
    { roles: user.roles, employeeGrants: user.employeeGrants },
  );
}
