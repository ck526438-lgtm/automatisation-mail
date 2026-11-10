/**
 * Client de l'API, côté serveur uniquement. La session de l'utilisateur est lue dans un cookie httpOnly
 * et transmise à l'API : aucune clé ni aucun jeton n'est exposé au navigateur.
 */
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const SESSION_COOKIE = "am_session";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function setSession(token: string, expiresAt: string | Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Appel authentifié par la session de l'utilisateur. Sans session valide : retour à la connexion. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await sessionToken();
  if (!token) redirect("/connexion");
  try {
    return await request<T>(path, init, token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) redirect("/connexion?expire=1");
    throw e;
  }
}

/** Appel public (connexion, inscription, invitation). */
export function publicApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init);
}

async function request<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; issues?: { message: string }[] };
    throw new ApiError(res.status, body.issues?.[0]?.message ?? body.error ?? res.statusText, body.code);
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

/** Variante qui renvoie l'erreur au lieu de lever (API arrêtée en développement). */
export async function tryApi<T>(path: string): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await api<T>(path), error: null };
  } catch (e) {
    // Les redirections de Next (connexion expirée) doivent remonter.
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")) throw e;
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export type Role = "owner" | "admin" | "member";

export interface Me {
  user: { id: string; email: string; name: string | null; role: Role } | null;
  role: Role;
  org: { id: string; name: string; postalAddress: string; timezone: string };
}

export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  occurredAt: string;
}

export interface Campaign {
  id: string;
  name: string;
  type: "cold" | "nurture" | "newsletter";
  status: "draft" | "running" | "paused" | "completed";
  pauseReason: string | null;
  enrollments: Record<string, number>;
  createdAt: string;
}

export interface Contact {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  status: string;
  source: string;
  createdAt: string;
}

export interface Account {
  id: string;
  email: string;
  fromName: string;
  provider: string;
  dailyLimit: number;
  healthScore: number;
  paused: boolean;
  warmupEnabled: boolean;
  warmupDay: number;
  sentToday: number;
  todayPlan: { warmup: number; campaign: number };
  needsReconnect: boolean;
  inboxSync: boolean;
  lastSyncAt: string | null;
  syncError: string | null;
}

export interface ProtocolResult {
  status: "ok" | "warning" | "missing" | "error";
  record?: string;
  details: string[];
}

export interface DomainReport {
  domain: string;
  spf: ProtocolResult;
  dkim: ProtocolResult;
  dmarc: ProtocolResult;
  mx: ProtocolResult;
  sendable: boolean;
}

export interface CampaignStats {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  rates: { open: number; click: number; reply: number; bounce: number; unsubscribe: number };
}
