import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import { AppError } from "../common/errors";
import { asyncHandler, sendData } from "../common/http";
import { signDevToken } from "../integrations/firebase";

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
    const token = signDevToken({
      uid: body.uid || `dev:${body.email || body.name.toLowerCase().replace(/\s+/g, "-")}`,
      name: body.name,
      email: body.email,
    });
    sendData(res, { token, developmentOnly: true });
  }),
);
