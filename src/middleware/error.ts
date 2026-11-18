import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../common/errors";
import { logger } from "../config/logger";

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Route not found." } });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Check the highlighted fields.",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    });
    return;
  }
  if (error instanceof AppError) {
    res.status(error.status).json({
      success: false,
      error: { code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  if ((error as { code?: number }).code === 11000) {
    res.status(409).json({
      success: false,
      error: { code: "DUPLICATE", message: "That record already exists." },
    });
    return;
  }
  logger.error({ err: error }, "Unhandled error");
  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
}
