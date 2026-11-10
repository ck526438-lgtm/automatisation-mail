/**
 * Connexion d'une boîte Google Workspace ou Microsoft 365.
 *   GET /v1/oauth/:provider/start     (authentifié) → URL de la page de consentement
 *   GET /oauth/:provider/callback     (public)      → échange du code, création ou mise à jour de la boîte
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  buildAuthUrl, encryptSecret, exchangeCode, fetchMailboxIdentity, OAuthError, signState, verifyState,
  type OAuthClient, type OAuthProvider,
} from "@am/core";
import { and, eq, sendingAccounts, sendingDomains } from "@am/db";
import type { AppDeps } from "../app.js";
import { config } from "../config.js";

const providerSchema = z.enum(["gmail", "outlook"]);

export function oauthClient(provider: OAuthProvider): OAuthClient | null {
  const c = provider === "gmail" ? config.google : config.microsoft;
  if (!c.clientId || !c.clientSecret) return null;
  return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: `${config.publicUrl}/oauth/${provider}/callback` };
}

const NAMES: Record<OAuthProvider, string> = { gmail: "Google", outlook: "Microsoft" };

export function registerOAuthStartRoute(app: FastifyInstance) {
  app.get<{ Params: { provider: string }; Querystring: { loginHint?: string } }>("/oauth/:provider/start", async (req, reply) => {
    const provider = providerSchema.parse(req.params.provider);
    const client = oauthClient(provider);
    if (!client) {
      const env = provider === "gmail" ? "GOOGLE" : "MICROSOFT";
      return reply.status(501).send({ error: `Connexion ${NAMES[provider]} non configurée : renseignez ${env}_CLIENT_ID et ${env}_CLIENT_SECRET (voir docs/oauth.md)` });
    }
    const state = signState({ orgId: req.orgId, provider }, config.trackingSecret);
    return { url: buildAuthUrl(provider, client, state, req.query.loginHint) };
  });
}

export function registerOAuthCallbackRoute(app: FastifyInstance, { db }: AppDeps) {
  const back = (reply: FastifyReply, params: Record<string, string>) =>
    reply.redirect(`${config.webUrl}/boites?${new URLSearchParams(params)}`, 302);

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    "/oauth/:provider/callback",
    async (req, reply) => {
      const provider = providerSchema.safeParse(req.params.provider);
      if (!provider.success) return reply.status(404).send({ error: "Fournisseur inconnu" });
      const p = provider.data;
      if (req.query.error) return back(reply, { erreur: req.query.error === "access_denied" ? "Connexion annulée" : (req.query.error_description ?? req.query.error) });

      const state = req.query.state ? verifyState(req.query.state, config.trackingSecret) : null;
      if (!state || state.provider !== p) return back(reply, { erreur: "Lien de connexion expiré ou invalide, recommencez" });
      const client = oauthClient(p);
      if (!client || !req.query.code) return back(reply, { erreur: "Connexion non configurée" });

      try {
        const tokens = await exchangeCode(p, client, req.query.code);
        if (!tokens.refreshToken) {
          return back(reply, { erreur: `${NAMES[p]} n'a pas accordé l'accès hors ligne : retirez l'application des autorisations du compte puis reconnectez-la` });
        }
        const me = await fetchMailboxIdentity(p, tokens.accessToken);
        const domain = me.email.split("@")[1]!;
        const [d] = await db.select({ id: sendingDomains.id }).from(sendingDomains)
          .where(and(eq(sendingDomains.orgId, state.orgId), eq(sendingDomains.domain, domain)));
        const values = {
          orgId: state.orgId,
          domainId: d?.id ?? null,
          email: me.email,
          provider: p,
          oauthAccessEnc: encryptSecret(tokens.accessToken, config.encryptionKey),
          oauthRefreshEnc: encryptSecret(tokens.refreshToken, config.encryptionKey),
          oauthExpiresAt: tokens.expiresAt,
          needsReconnect: false,
          paused: false,
          syncError: null,
        };
        const [existing] = await db.select({ id: sendingAccounts.id }).from(sendingAccounts)
          .where(and(eq(sendingAccounts.orgId, state.orgId), eq(sendingAccounts.email, me.email)));
        if (existing) {
          // Reconnexion : on garde l'historique de warm-up et les réglages.
          await db.update(sendingAccounts).set(values).where(eq(sendingAccounts.id, existing.id));
        } else {
          // Gmail et Microsoft 365 recommandent des volumes prudents : 50/jour par défaut, warm-up activé.
          await db.insert(sendingAccounts).values({ ...values, fromName: me.name ?? "", dailyLimit: 50, warmupEnabled: true });
        }
        return back(reply, { connecte: me.email });
      } catch (err) {
        req.log.error({ err }, "Échec de la connexion OAuth");
        return back(reply, { erreur: err instanceof OAuthError ? `${NAMES[p]} : ${err.message}` : "Erreur pendant la connexion, réessayez" });
      }
    },
  );
}
