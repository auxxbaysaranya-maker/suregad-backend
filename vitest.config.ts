import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    fileParallelism: false,
    hookTimeout: 600000,
    testTimeout: 30000,
    env: {
      NODE_ENV: "test",
      ALLOW_DEV_AUTH: "true",
      DEV_AUTH_SECRET: "test-secret-test-secret-test-secret",
      DATA_ENCRYPTION_KEY: "test-encryption-key-32-characters-min",
      PAYMENT_PROVIDER: "mock",
      RAZORPAY_WEBHOOK_SECRET: "whsec-test-secret",
      CLIENT_ORIGIN: "http://localhost:5173",
    },
  },
});
