import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import mongoSanitize from "express-mongo-sanitize";
import path from "path";
import { env } from "./config/env";
import { api } from "./routes";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { uploadDir } from "./integrations/storage";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(
    cors({
      origin: env.clientOrigins,
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: env.isTest ? 10000 : 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buffer) => {
        req.rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(mongoSanitize());
  app.use("/media", (req, res, next) => {
    const key = decodeURIComponent(req.path.replace(/^\//, ""));
    if (!key.startsWith("public/") || key.includes("..")) {
      res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Media not found." } });
      return;
    }
    res.sendFile(path.join(uploadDir(), key), (error) => {
      if (error) next();
    });
  });
  app.use("/api/v1", api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
