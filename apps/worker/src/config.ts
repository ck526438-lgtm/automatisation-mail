export const config = {
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "0".repeat(64),
  trackingSecret: process.env.TRACKING_SECRET ?? "change-me",
  /** URL publique de l'API, sert de domaine de tracking par défaut */
  publicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:4000",
  webUrl: process.env.WEB_URL ?? "http://localhost:3000",
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS ?? 15_000),
  schedulerBatch: Number(process.env.SCHEDULER_BATCH ?? 200),
  sendConcurrency: Number(process.env.SEND_CONCURRENCY ?? 5),
  /** Écart minimal / maximal entre deux envois d'une même boîte, en secondes */
  minGapSeconds: Number(process.env.MIN_GAP_SECONDS ?? 60),
  maxGapSeconds: Number(process.env.MAX_GAP_SECONDS ?? 300),
  /** Fréquence de lecture des boîtes (réponses, rebonds) */
  inboxSyncIntervalMs: Number(process.env.INBOX_SYNC_INTERVAL_MS ?? 120_000),
  google: { clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "" },
  microsoft: { clientId: process.env.MICROSOFT_CLIENT_ID ?? "", clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "" },
};
