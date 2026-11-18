import type { NextFunction, Request, Response } from "express";
import type { ApiMeta } from "../shared";

export function sendData<T>(res: Response, data: T, meta?: ApiMeta, status = 200): void {
  res.status(status).json({ success: true, data, meta });
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

export function pageParams(query: Request["query"]): { page: number; limit: number; skip: number } {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(48, Math.max(1, Number(query.limit) || 12));
  return { page, limit, skip: (page - 1) * limit };
}
