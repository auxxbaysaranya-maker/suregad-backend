import crypto from "crypto";
import Razorpay from "razorpay";
import { env } from "../config/env";
import { AppError } from "../common/errors";
import { randomId } from "../common/crypto";

export interface GatewayOrder {
  gatewayOrderId: string;
  amountPaise: number;
  currency: "INR";
  keyId?: string;
  provider: string;
}

export interface PaymentProvider {
  name: string;
  configured: boolean;
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean;
  refund(input: { paymentId: string; amountPaise: number }): Promise<{ refundId: string; status: string }>;
}

class RazorpayProvider implements PaymentProvider {
  name = "razorpay";
  configured = Boolean(env.razorpay.keyId && env.razorpay.keySecret && env.razorpay.webhookSecret);
  private sdk(): Razorpay {
    if (!this.configured) {
      throw new AppError(
        503,
        "PAYMENTS_NOT_CONFIGURED",
        "Razorpay keys are missing. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET.",
      );
    }
    return new Razorpay({ key_id: env.razorpay.keyId, key_secret: env.razorpay.keySecret });
  }
  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    const order = await this.sdk().orders.create({
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    return {
      gatewayOrderId: order.id,
      amountPaise: Number(order.amount),
      currency: "INR" as const,
      keyId: env.razorpay.keyId,
      provider: this.name,
    };
  }
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    const expected = crypto
      .createHmac("sha256", env.razorpay.keySecret)
      .update(`${input.orderId}|${input.paymentId}`)
      .digest("hex");
    return safeEqual(expected, input.signature);
  }
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !env.razorpay.webhookSecret) return false;
    const expected = crypto.createHmac("sha256", env.razorpay.webhookSecret).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  }
  async refund(input: { paymentId: string; amountPaise: number }) {
    const result = await this.sdk().payments.refund(input.paymentId, { amount: input.amountPaise });
    return { refundId: result.id, status: result.status || "processed" };
  }
}

class MockProvider implements PaymentProvider {
  name = "mock";
  configured = !env.isProduction && env.paymentProvider === "mock" && Boolean(env.devAuthSecret || env.razorpay.webhookSecret);
  private secret(): string {
    const secret = env.razorpay.webhookSecret || env.devAuthSecret;
    if (!secret || env.isProduction) {
      throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Mock payments are unavailable.");
    }
    return secret;
  }
  async createOrder(input: { amountPaise: number; receipt: string }) {
    this.secret();
    return {
      gatewayOrderId: `mock_order_${randomId(8)}`,
      amountPaise: input.amountPaise,
      currency: "INR" as const,
      provider: this.name,
    };
  }
  verifyCheckoutSignature(input: { orderId: string; paymentId: string; signature: string }): boolean {
    const expected = crypto.createHmac("sha256", this.secret()).update(`${input.orderId}|${input.paymentId}`).digest("hex");
    return safeEqual(expected, input.signature);
  }
  verifyWebhook(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = crypto.createHmac("sha256", this.secret()).update(rawBody).digest("hex");
    return safeEqual(expected, signature);
  }
  async refund(input: { paymentId: string; amountPaise: number }) {
    this.secret();
    return { refundId: `mock_rfnd_${randomId(6)}`, status: "processed" };
  }
}

function safeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function getPaymentProvider(): PaymentProvider {
  if (env.paymentProvider === "mock") {
    const mock = new MockProvider();
    if (!mock.configured) {
      throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Mock payments are disabled in this environment.");
    }
    return mock;
  }
  return new RazorpayProvider();
}

export function mockPaymentSignature(orderId: string, paymentId: string): string {
  const provider = getPaymentProvider();
  if (provider.name !== "mock") {
    throw new AppError(400, "NOT_MOCK", "Signature helper is only for the mock provider.");
  }
  const secret = env.razorpay.webhookSecret || env.devAuthSecret;
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}
