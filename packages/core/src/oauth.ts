/**
 * Connexion des boîtes Google Workspace et Microsoft 365 en OAuth 2.0 (code d'autorisation).
 * Les appels HTTP passent par un `fetch` injectable pour pouvoir tester sans réseau.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OAuthProvider = "gmail" | "outlook";

export interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Paramètres supplémentaires de la page d'autorisation */
  extraAuthParams: Record<string, string>;
}

export const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  gmail: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // gmail.readonly sert à détecter réponses et rebonds. C'est un scope « restreint » :
    // l'application doit passer la vérification de sécurité Google avant d'être ouverte au public.
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"],
    // offline + consent : garantit un refresh_token à chaque connexion.
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  outlook: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "openid", "email", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/Mail.Read"],
    extraAuthParams: { prompt: "select_account" },
  },
};

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OAuthState {
  orgId: string;
  provider: OAuthProvider;
  /** Expiration (ms depuis l'époque) */
  exp: number;
  nonce: string;
}

/** State signé HMAC : lie la connexion à l'organisation et protège contre les attaques CSRF. */
export function signState(s: Omit<OAuthState, "exp" | "nonce">, secret: string, ttlMs = 15 * 60_000, now = Date.now()): string {
  const full: OAuthState = { ...s, exp: now + ttlMs, nonce: randomBytes(9).toString("base64url") };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  const sig = createHmac("sha256", `oauth:${secret}`).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(token: string, secret: string, now = Date.now()): OAuthState | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", `oauth:${secret}`).update(body).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
    if (typeof s.exp !== "number" || s.exp < now) return null;
    if (s.provider !== "gmail" && s.provider !== "outlook") return null;
    return s;
  } catch {
    return null;
  }
}

export function buildAuthUrl(provider: OAuthProvider, client: OAuthClient, state: string, loginHint?: string): string {
  const cfg = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
    ...cfg.extraAuthParams,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${cfg.authUrl}?${params}`;
}

export interface TokenSet {
  accessToken: string;
  /** Absent lors d'un rafraîchissement Google : on conserve alors l'ancien */
  refreshToken?: string;
  expiresAt: Date;
  scope?: string;
}

export class OAuthError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
  }
  /** Le jeton de rafraîchissement est révoqué ou expiré : l'utilisateur doit reconnecter la boîte. */
  get needsReconnect(): boolean {
    return this.code === "invalid_grant";
  }
}

type Fetch = typeof fetch;

async function tokenRequest(provider: OAuthProvider, client: OAuthClient, params: Record<string, string>, f: Fetch, now: number): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params });
  if (provider === "outlook") body.set("scope", PROVIDERS.outlook.scopes.join(" "));
  const res = await f(PROVIDERS[provider].tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    throw new OAuthError(String(json.error_description ?? json.error ?? `HTTP ${res.status}`), json.error as string | undefined, res.status);
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    // Marge de 60 s pour ne jamais utiliser un jeton sur le point d'expirer.
    expiresAt: new Date(now + Math.max(0, expiresIn - 60) * 1000),
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

export function exchangeCode(provider: OAuthProvider, client: OAuthClient, code: string, f: Fetch = fetch, now = Date.now()): Promise<TokenSet> {
  return tokenRequest(provider, client, { grant_type: "authorization_code", code, redirect_uri: client.redirectUri }, f, now);
}

export function refreshAccessToken(provider: OAuthProvider, client: OAuthClient, refreshToken: string, f: Fetch = fetch, now = Date.now()): Promise<TokenSet> {
  return tokenRequest(provider, client, { grant_type: "refresh_token", refresh_token: refreshToken }, f, now);
}

/** Adresse e-mail de la boîte connectée, lue auprès du fournisseur. */
export async function fetchMailboxIdentity(provider: OAuthProvider, accessToken: string, f: Fetch = fetch): Promise<{ email: string; name?: string }> {
  const url = provider === "gmail" ? "https://gmail.googleapis.com/gmail/v1/users/me/profile" : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName";
  const res = await f(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as Record<string, string | undefined>;
  if (!res.ok) throw new OAuthError(`Impossible de lire le profil de la boîte (HTTP ${res.status})`, undefined, res.status);
  const email = provider === "gmail" ? json.emailAddress : json.mail ?? json.userPrincipalName;
  if (!email) throw new OAuthError("Le fournisseur n'a pas renvoyé d'adresse e-mail");
  return { email: email.toLowerCase(), name: json.displayName };
}
