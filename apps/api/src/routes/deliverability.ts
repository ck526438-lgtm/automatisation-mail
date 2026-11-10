import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkDomain, encryptSecret, warmupPlan } from "@am/core";
import { and, eq, sendingAccounts, sendingDomains, sql } from "@am/db";
import type { AppDeps } from "../app.js";
import { config } from "../config.js";

export function registerDeliverabilityRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get("/domains", async (req) => db.select().from(sendingDomains).where(eq(sendingDomains.orgId, req.orgId)));

  /** Ajoute un domaine et lance immédiatement la vérification SPF / DKIM / DMARC / MX. */
  app.post("/domains", async (req, reply) => {
    const body = z.object({
      domain: z.string().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "Nom de domaine invalide"),
      dkimSelectors: z.array(z.string()).optional(),
      trackingDomain: z.string().optional(),
    }).parse(req.body);
    const report = await checkDomain(body.domain, { dkimSelectors: body.dkimSelectors });
    const values = {
      orgId: req.orgId, domain: report.domain, trackingDomain: body.trackingDomain,
      spfOk: report.spf.status === "ok", dkimOk: report.dkim.status === "ok", dmarcOk: report.dmarc.status !== "missing" && report.dmarc.status !== "error",
      lastReport: report, lastCheckedAt: new Date(),
    };
    const [d] = await db.insert(sendingDomains).values(values)
      .onConflictDoUpdate({ target: [sendingDomains.orgId, sendingDomains.domain], set: values }).returning();
    return reply.status(201).send(d);
  });

  /** Vérification ponctuelle sans enregistrement (formulaire de l'interface). */
  app.get("/dns-check", async (req) => {
    const { domain } = z.object({ domain: z.string().min(3) }).parse(req.query);
    return checkDomain(domain);
  });

  app.get("/accounts", async (req) => {
    const rows = await db.select({
      id: sendingAccounts.id, email: sendingAccounts.email, fromName: sendingAccounts.fromName, provider: sendingAccounts.provider,
      dailyLimit: sendingAccounts.dailyLimit, healthScore: sendingAccounts.healthScore, paused: sendingAccounts.paused,
      warmupEnabled: sendingAccounts.warmupEnabled, warmupStartedAt: sendingAccounts.warmupStartedAt,
      needsReconnect: sendingAccounts.needsReconnect, lastSyncAt: sendingAccounts.lastSyncAt, syncError: sendingAccounts.syncError,
      inboxSync: sql<boolean>`(${sendingAccounts.provider} in ('gmail','outlook') or ${sendingAccounts.imapHost} is not null)`,
      // Colonne qualifiée explicitement : dans une sous-requête, Drizzle écrirait « id » sans table.
      sentToday: sql<number>`(select count(*)::int from messages m where m.sending_account_id = "sending_accounts"."id" and m.sent_at >= date_trunc('day', now()))`,
    }).from(sendingAccounts).where(eq(sendingAccounts.orgId, req.orgId));
    return rows.map((a) => {
      const day = Math.floor((Date.now() - a.warmupStartedAt.getTime()) / 86_400_000);
      return { ...a, warmupDay: day, todayPlan: a.warmupEnabled ? warmupPlan(day, a.dailyLimit) : { warmup: 0, campaign: a.dailyLimit } };
    });
  });

  /** Ajoute une boîte SMTP. Le mot de passe est chiffré et n'est jamais renvoyé. */
  app.post("/accounts", async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      fromName: z.string().default(""),
      smtpHost: z.string(),
      smtpPort: z.number().int().default(587),
      smtpSecure: z.boolean().default(false),
      smtpUser: z.string().default(""),
      smtpPassword: z.string().default(""),
      dailyLimit: z.number().int().min(1).max(2000).default(50),
      warmupEnabled: z.boolean().default(true),
      // IMAP facultatif : permet de détecter réponses et rebonds dans la boîte SMTP.
      imapHost: z.string().optional(),
      imapPort: z.number().int().default(993),
      imapSecure: z.boolean().default(true),
    }).parse(req.body);
    const domain = body.email.split("@")[1]!.toLowerCase();
    const [d] = await db.select({ id: sendingDomains.id }).from(sendingDomains)
      .where(and(eq(sendingDomains.orgId, req.orgId), eq(sendingDomains.domain, domain)));
    const [a] = await db.insert(sendingAccounts).values({
      orgId: req.orgId, domainId: d?.id, email: body.email, fromName: body.fromName, provider: "smtp",
      smtpHost: body.smtpHost, smtpPort: body.smtpPort, smtpSecure: body.smtpSecure, smtpUser: body.smtpUser,
      credentialsEnc: encryptSecret(body.smtpPassword, config.encryptionKey), dailyLimit: body.dailyLimit, warmupEnabled: body.warmupEnabled,
      imapHost: body.imapHost, imapPort: body.imapHost ? body.imapPort : null, imapSecure: body.imapSecure,
    }).returning({ id: sendingAccounts.id, email: sendingAccounts.email });
    return reply.status(201).send(a);
  });

  app.patch<{ Params: { id: string } }>("/accounts/:id", async (req, reply) => {
    const body = z.object({ paused: z.boolean().optional(), dailyLimit: z.number().int().min(1).max(2000).optional(), fromName: z.string().optional() }).parse(req.body);
    const [a] = await db.update(sendingAccounts).set(body)
      .where(and(eq(sendingAccounts.id, req.params.id), eq(sendingAccounts.orgId, req.orgId))).returning({ id: sendingAccounts.id });
    if (!a) return reply.status(404).send({ error: "Compte introuvable" });
    return a;
  });
}
