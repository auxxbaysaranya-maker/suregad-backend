import type { Request } from "express";
import { AuditLog } from "../models/engagement.model";

export async function audit(
  req: Request | undefined,
  action: string,
  entityType: string,
  entityId: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await AuditLog.create({
    actorId: req?.user?._id,
    action,
    entityType,
    entityId,
    meta,
    ip: req?.ip,
  });
}
