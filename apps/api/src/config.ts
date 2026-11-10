export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  publicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:4000",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  encryptionKey: process.env.ENCRYPTION_KEY ?? "0".repeat(64),
  trackingSecret: process.env.TRACKING_SECRET ?? "change-me",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  /** Adresse de l'interface, vers laquelle on revient après une connexion OAuth */
  webUrl: process.env.WEB_URL ?? "http://localhost:3000",
  /** Inscription libre (création d'organisation). Mettre à false pour n'accepter que les invitations. */
  allowSignup: (process.env.ALLOW_SIGNUP ?? "true") !== "false",
  /** « server » (SaaS multi-organisations) ou « desktop » (application Windows, un seul poste) */
  mode: (process.env.AM_MODE === "desktop" ? "desktop" : "server") as "desktop" | "server",
  /** Mode serveur : adresses autorisées à régler le SMTP des e-mails système (séparées par des virgules) */
  platformAdmins: (process.env.PLATFORM_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  google: { clientId: process.env.GOOGLE_CLIENT_ID ?? "", clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "" },
  microsoft: { clientId: process.env.MICROSOFT_CLIENT_ID ?? "", clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "" },
};

if (process.env.NODE_ENV === "production") {
  for (const [k, bad] of [["ENCRYPTION_KEY", "0".repeat(64)], ["TRACKING_SECRET", "change-me"]] as const) {
    if (!process.env[k] || process.env[k] === bad) throw new Error(`${k} doit être défini en production`);
  }
}
