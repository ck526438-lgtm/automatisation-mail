/**
 * Client de l'API, utilisé côté serveur uniquement : la clé API ne part jamais dans le navigateur.
 */
import "server-only";

const BASE = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const KEY = process.env.API_KEY ?? process.env.API_DEV_KEY ?? "dev-key-change-me";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "x-api-key": KEY, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>;
}

/** Variante qui renvoie null au lieu de lever (API arrêtée en développement). */
export async function tryApi<T>(path: string): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await api<T>(path), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
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
