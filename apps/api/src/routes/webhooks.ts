/**
 * Webhooks entrants : rebonds, plaintes et réponses.
 * Format normalisé, plus un adaptateur Amazon SES (via SNS).
 * Protégés par l'en-tête x-webhook-secret si WEBHOOK_SECRET est défini.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, handleBounce, handleReply, isAutoReply, messages, recordEvent } from "@am/db";
import type { AppDeps } from "../app.js";
import { config } from "../config.js";

export function registerWebhookRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.register(async (hooks) => {
    hooks.addHook("onRequest", async (req, reply) => {
      if (config.webhookSecret && req.headers["x-webhook-secret"] !== config.webhookSecret) {
        return reply.status(401).send({ error: "Secret de webhook invalide" });
      }
    });

    /** { messageId | messageIdHeader, code?, enhanced?, message? } */
    hooks.post("/bounce", async (req, reply) => {
      const body = z.object({
        messageId: z.string().uuid().optional(),
        messageIdHeader: z.string().optional(),
        code: z.number().int().optional(),
        enhanced: z.string().optional(),
        message: z.string().optional(),
      }).refine((b) => b.messageId || b.messageIdHeader, "messageId ou messageIdHeader requis").parse(req.body);
      const verdict = await handleBounce(db, { messageId: body.messageId, messageIdHeader: body.messageIdHeader?.replace(/[<>]/g, "") }, body);
      if (!verdict) return reply.status(404).send({ error: "Message introuvable" });
      return verdict;
    });

    hooks.post("/complaint", async (req, reply) => {
      const body = z.object({ messageIdHeader: z.string() }).parse(req.body);
      const [msg] = await db.select().from(messages).where(eq(messages.messageIdHeader, body.messageIdHeader.replace(/[<>]/g, ""))).limit(1);
      if (!msg) return reply.status(404).send({ error: "Message introuvable" });
      await recordEvent(db, { orgId: msg.orgId, type: "complaint", messageId: msg.id, contactId: msg.contactId, campaignId: msg.campaignId, nodeId: msg.nodeId });
      return { ok: true };
    });

    /** Réponse entrante (parse inbound de Postmark/Mailgun, ou synchro de boîte). */
    hooks.post("/inbound", async (req, reply) => {
      const body = z.object({
        from: z.string(),
        subject: z.string().optional(),
        text: z.string().optional(),
        inReplyTo: z.string().optional(),
        references: z.string().optional(),
        headers: z.record(z.string()).default({}),
      }).parse(req.body);
      const refs = [body.inReplyTo, ...(body.references?.split(/\s+/) ?? [])].filter((r): r is string => Boolean(r));
      const msg = await handleReply(db, {
        inReplyTo: refs, from: body.from, subject: body.subject, snippet: body.text,
        autoReply: isAutoReply(body.headers, body.subject),
      });
      if (!msg) return reply.status(404).send({ error: "Aucun message d'origine trouvé" });
      return { ok: true, messageId: msg.id };
    });

    /** Amazon SES → SNS : notifications Bounce et Complaint. */
    hooks.post("/ses", async (req) => {
      const raw = typeof req.body === "string" ? JSON.parse(req.body) : req.body as Record<string, unknown>;
      if (raw.Type === "SubscriptionConfirmation") {
        req.log.warn({ url: raw.SubscribeURL }, "Confirmez l'abonnement SNS en ouvrant SubscribeURL");
        return { ok: true };
      }
      const n = typeof raw.Message === "string" ? JSON.parse(raw.Message) : raw;
      const headerId = (n.mail?.headers as { name: string; value: string }[] | undefined)?.find((h) => h.name.toLowerCase() === "message-id")?.value?.replace(/[<>]/g, "");
      if (!headerId) return { ok: true, ignored: "pas de Message-ID" };
      if (n.notificationType === "Bounce") {
        for (const r of n.bounce?.bouncedRecipients ?? []) {
          await handleBounce(db, { messageIdHeader: headerId }, {
            enhanced: r.status, message: r.diagnosticCode ?? `${n.bounce.bounceType}/${n.bounce.bounceSubType}`,
            code: n.bounce.bounceType === "Permanent" ? 550 : 450,
          });
        }
      } else if (n.notificationType === "Complaint") {
        const [msg] = await db.select().from(messages).where(eq(messages.messageIdHeader, headerId)).limit(1);
        if (msg) await recordEvent(db, { orgId: msg.orgId, type: "complaint", messageId: msg.id, contactId: msg.contactId, campaignId: msg.campaignId, nodeId: msg.nodeId });
      }
      return { ok: true };
    });
  }, { prefix: "/webhooks" });
}
