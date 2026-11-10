/**
 * Routes publiques de tracking et de désinscription.
 *   GET  /o/:token.gif  pixel d'ouverture
 *   GET  /c/:token      redirection de clic
 *   GET  /u/:token      page de désinscription
 *   POST /u/:token      désinscription en un clic (RFC 8058, appelée par Gmail/Yahoo)
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isLikelyBotClick, isLikelyBotOpen, verifyToken, type TrackingPayload } from "@am/core";
import { eq, messages, recordEvent } from "@am/db";
import type { AppDeps } from "../app.js";
import { config } from "../config.js";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export function registerTrackingRoutes(app: FastifyInstance, { db }: AppDeps) {
  const load = async (token: string, type: TrackingPayload["t"]) => {
    const payload = verifyToken(token, config.trackingSecret);
    if (!payload || payload.t !== type) return null;
    const [msg] = await db.select().from(messages).where(eq(messages.id, payload.m)).limit(1);
    return msg ? { payload, msg } : null;
  };
  const meta = (req: FastifyRequest) => ({ ua: req.headers["user-agent"] ?? "", ip: req.ip });

  app.get<{ Params: { token: string } }>("/o/:token", async (req, reply) => {
    const found = await load(req.params.token.replace(/\.gif$/, ""), "o");
    if (found?.msg.sentAt) {
      const m = meta(req);
      await recordEvent(db, {
        orgId: found.msg.orgId, type: "open", messageId: found.msg.id, contactId: found.msg.contactId,
        campaignId: found.msg.campaignId, nodeId: found.msg.nodeId, meta: m, isBot: isLikelyBotOpen(found.msg.sentAt, new Date(), m.ua),
      });
    }
    return reply.header("Cache-Control", "no-store, max-age=0").type("image/gif").send(GIF);
  });

  app.get<{ Params: { token: string } }>("/c/:token", async (req, reply) => {
    const found = await load(req.params.token, "c");
    if (!found?.payload.u) return reply.status(404).send("Lien invalide");
    if (found.msg.sentAt) {
      const m = meta(req);
      await recordEvent(db, {
        orgId: found.msg.orgId, type: "click", messageId: found.msg.id, contactId: found.msg.contactId,
        campaignId: found.msg.campaignId, nodeId: found.msg.nodeId, meta: { ...m, url: found.payload.u },
        isBot: isLikelyBotClick(found.msg.sentAt, new Date(), m.ua),
      });
    }
    return reply.redirect(found.payload.u, 302);
  });

  const unsubscribe = async (token: string) => {
    const found = await load(token, "u");
    if (!found) return false;
    await recordEvent(db, {
      orgId: found.msg.orgId, type: "unsubscribe", messageId: found.msg.id, contactId: found.msg.contactId,
      campaignId: found.msg.campaignId, nodeId: found.msg.nodeId,
    });
    return true;
  };

  app.post<{ Params: { token: string } }>("/u/:token", async (req, reply) => {
    const ok = await unsubscribe(req.params.token);
    return reply.status(ok ? 200 : 404).send(ok ? { ok: true } : { error: "Lien invalide" });
  });

  // Le GET affiche une confirmation (les scanners de liens suivent les GET : on désinscrit seulement sur confirmation).
  app.get<{ Params: { token: string }; Querystring: { confirm?: string } }>("/u/:token", async (req, reply) => {
    const valid = verifyToken(req.params.token, config.trackingSecret)?.t === "u";
    if (!valid) return reply.status(404).type("text/html").send(page("Lien invalide", "<p>Ce lien de désinscription n'est pas valide.</p>"));
    if (req.query.confirm === "1") {
      await unsubscribe(req.params.token);
      return reply.type("text/html").send(page("Désinscription confirmée", "<p>Vous ne recevrez plus de messages de cet expéditeur.</p>"));
    }
    return reply.type("text/html").send(page("Se désinscrire",
      `<p>Confirmez-vous ne plus vouloir recevoir de messages de cet expéditeur ?</p><p><a class="btn" href="?confirm=1">Oui, me désinscrire</a></p>`));
  });
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;color:#1d2b4f}h1{font-size:22px}.btn{display:inline-block;background:#1f5fbf;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}
