import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import type { Db } from "@am/db";
import { makeAuthHook } from "./auth.js";
import { registerPublicAuthRoutes, registerTeamRoutes } from "./routes/auth.js";
import { config } from "./config.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerCampaignRoutes } from "./routes/campaigns.js";
import { registerDeliverabilityRoutes } from "./routes/deliverability.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerTrackingRoutes } from "./routes/tracking.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerOAuthCallbackRoute, registerOAuthStartRoute } from "./routes/oauth.js";

export interface AppDeps {
  db: Db;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // maxParamLength : les jetons signés de clic contiennent l'URL cible et dépassent les 100 caractères par défaut.
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 20 * 1024 * 1024, routerOptions: { maxParamLength: 4096 } });
  await app.register(cors, { origin: config.corsOrigin.split(",") });
  app.decorateRequest("orgId", "");
  app.decorateRequest("userId", null);
  app.decorateRequest("role", "member");
  app.decorateRequest("actor", "");

  // Le corps CSV brut est accepté pour l'import de contacts.
  app.addContentTypeParser(["text/csv", "text/plain"], { parseAs: "string" }, (_req, body, done) => done(null, body));
  // Désinscription en un clic (RFC 8058) : Gmail et Yahoo envoient « List-Unsubscribe=One-Click »
  // en formulaire encodé ou multipart. Le contenu n'est pas utilisé, seul le jeton de l'URL compte.
  app.addContentTypeParser(["application/x-www-form-urlencoded", "multipart/form-data"], { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: err.message });
  });

  app.get("/health", async () => ({ ok: true, service: "automatisation-mail-api" }));

  // Routes publiques (tracking, désinscription, webhooks entrants)
  registerTrackingRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerOAuthCallbackRoute(app, deps);
  registerPublicAuthRoutes(app, deps);

  // Routes authentifiées : session utilisateur ou clé API d'organisation
  await app.register(async (v1) => {
    v1.addHook("onRequest", makeAuthHook(deps.db));
    registerContactRoutes(v1, deps);
    registerCampaignRoutes(v1, deps);
    registerDeliverabilityRoutes(v1, deps);
    registerContentRoutes(v1, deps);
    registerOAuthStartRoute(v1);
    registerTeamRoutes(v1, deps);
  }, { prefix: "/v1" });

  return app;
}
