import { env } from "../config/env";
import { logger } from "../config/logger";

export interface OutboundMessage {
  to: string;
  subject?: string;
  body: string;
}

export async function sendEmail(message: OutboundMessage): Promise<{ delivered: boolean; reason?: string }> {
  if (!env.smtp.host) {
    logger.info({ channel: "email" }, "Email provider is not configured. Message kept in-app only.");
    return { delivered: false, reason: "EMAIL_NOT_CONFIGURED" };
  }
  logger.info({ channel: "email", to: message.to }, "Email delivery requires an SMTP implementation against the configured host.");
  return { delivered: false, reason: "EMAIL_TRANSPORT_PENDING" };
}

export async function sendSms(message: OutboundMessage): Promise<{ delivered: boolean; reason?: string }> {
  if (!env.sms.provider || !env.sms.apiKey) {
    return { delivered: false, reason: "SMS_NOT_CONFIGURED" };
  }
  logger.info({ channel: "sms", provider: env.sms.provider }, "SMS provider is configured but the transport adapter is not bound yet.");
  return { delivered: false, reason: "SMS_TRANSPORT_PENDING" };
}

export async function sendWhatsApp(message: OutboundMessage): Promise<{ delivered: boolean; reason?: string }> {
  if (!env.whatsapp.provider || !env.whatsapp.apiKey) {
    return { delivered: false, reason: "WHATSAPP_NOT_CONFIGURED" };
  }
  logger.info({ channel: "whatsapp" }, "WhatsApp provider is configured but the transport adapter is not bound yet.");
  return { delivered: false, reason: "WHATSAPP_TRANSPORT_PENDING" };
}
