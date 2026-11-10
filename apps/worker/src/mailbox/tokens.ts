/**
 * Jetons d'accès OAuth : lecture, rafraîchissement automatique et gestion des révocations.
 */
import { decryptSecret, encryptSecret, OAuthError, refreshAccessToken, type OAuthClient, type OAuthProvider } from "@am/core";
import { eq, notifyAdmins, sendingAccounts, systemTemplates, type Db } from "@am/db";
import { config } from "../config.js";

type Account = typeof sendingAccounts.$inferSelect;

export function oauthClient(provider: OAuthProvider): OAuthClient {
  const c = provider === "gmail" ? config.google : config.microsoft;
  if (!c.clientId || !c.clientSecret) {
    throw new Error(`OAuth ${provider === "gmail" ? "Google" : "Microsoft"} non configuré : renseignez ${provider === "gmail" ? "GOOGLE" : "MICROSOFT"}_CLIENT_ID et _CLIENT_SECRET`);
  }
  return { clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: `${config.publicUrl}/oauth/${provider}/callback` };
}

/** Erreur qui ne doit pas être réessayée : la boîte est déconnectée. */
export class MailboxDisconnectedError extends Error {}

const inflight = new Map<string, Promise<string>>();

/** Renvoie un jeton d'accès valide, en le rafraîchissant si besoin (un seul rafraîchissement à la fois par boîte). */
export async function accessTokenFor(db: Db, account: Account): Promise<string> {
  if (account.provider !== "gmail" && account.provider !== "outlook") throw new Error("Boîte non OAuth");
  if (account.needsReconnect) throw new MailboxDisconnectedError(`La boîte ${account.email} doit être reconnectée`);
  if (account.oauthAccessEnc && account.oauthExpiresAt && account.oauthExpiresAt.getTime() > Date.now()) {
    return decryptSecret(account.oauthAccessEnc, config.encryptionKey);
  }
  const running = inflight.get(account.id);
  if (running) return running;

  const provider = account.provider;
  const p = (async () => {
    if (!account.oauthRefreshEnc) throw new MailboxDisconnectedError(`Aucun jeton de rafraîchissement pour ${account.email}`);
    const refresh = decryptSecret(account.oauthRefreshEnc, config.encryptionKey);
    try {
      const t = await refreshAccessToken(provider, oauthClient(provider), refresh);
      await db.update(sendingAccounts).set({
        oauthAccessEnc: encryptSecret(t.accessToken, config.encryptionKey),
        oauthExpiresAt: t.expiresAt,
        // Microsoft renvoie un nouveau refresh_token à chaque fois ; Google généralement non.
        ...(t.refreshToken ? { oauthRefreshEnc: encryptSecret(t.refreshToken, config.encryptionKey) } : {}),
      }).where(eq(sendingAccounts.id, account.id));
      return t.accessToken;
    } catch (err) {
      if (err instanceof OAuthError && err.needsReconnect) {
        await db.update(sendingAccounts).set({ needsReconnect: true, paused: true, syncError: "Accès révoqué : reconnectez la boîte" })
          .where(eq(sendingAccounts.id, account.id));
        await notifyAdmins(db, account.orgId, "mailbox_reconnect",
          systemTemplates.mailboxReconnect({ email: account.email, link: `${config.webUrl}/boites` }));
        throw new MailboxDisconnectedError(`Accès révoqué pour ${account.email} : reconnexion nécessaire`);
      }
      throw err;
    }
  })();
  inflight.set(account.id, p);
  try {
    return await p;
  } finally {
    inflight.delete(account.id);
  }
}
