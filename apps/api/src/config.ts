export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  publicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:4000",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "0".repeat(64),
  trackingSecret: process.env.TRACKING_SECRET ?? "change-me",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
};

if (process.env.NODE_ENV === "production") {
  for (const [k, bad] of [["ENCRYPTION_KEY", "0".repeat(64)], ["TRACKING_SECRET", "change-me"]] as const) {
    if (!process.env[k] || process.env[k] === bad) throw new Error(`${k} doit être défini en production`);
  }
}
