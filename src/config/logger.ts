import pino from "pino";
import { env } from "./env";

export const logger = pino({
  level: env.isTest ? "silent" : env.isProduction ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "privateKey",
      "keySecret",
      "webhookSecret",
      "apiKey",
      "password",
      "imei",
      "serialNumber",
    ],
    remove: true,
  },
});
