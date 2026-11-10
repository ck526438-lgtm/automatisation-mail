/**
 * Authentification des requêtes /v1 :
 *   - session utilisateur (interface) : en-tête `Authorization: Bearer ses_…`
 *   - clé API d'organisation (intégrations) : en-tête `x-api-key: am_…`, droits d'administrateur
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { hashToken, hasRole, type Role } from "@am/core";
import { and, auditLogs, eq, gte, hashApiKey, organizations, sessions, sql, users, type Db } from "@am/db";

declare module "fastify" {
  interface FastifyRequest {
    orgId: string;
    userId: string | null;
    role: Role;
    /** Libellé de l'auteur pour le journal d'audit */
    actor: string;
  }
}

export const SESSION_TTL_MS = 30 * 86_400_000;
/** On ne réécrit last_seen_at qu'au plus toutes les 10 minutes. */
const TOUCH_EVERY_MS = 10 * 60_000;

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export function makeAuthHook(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : bearer?.startsWith("am_") ? bearer : undefined;

    if (bearer && bearer.startsWith("ses_")) {
      const [row] = await db.select({
        sessionId: sessions.id, lastSeenAt: sessions.lastSeenAt, userId: users.id, orgId: users.orgId, role: users.role, email: users.email,
      }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, hashToken(bearer)), gte(sessions.expiresAt, new Date()))).limit(1);
      if (!row) return reply.status(401).send({ error: "Session expirée, reconnectez-vous", code: "session_expired" });
      if (Date.now() - row.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
        // Session glissante : chaque utilisation prolonge l'expiration.
        await db.update(sessions).set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) }).where(eq(sessions.id, row.sessionId));
      }
      req.orgId = row.orgId;
      req.userId = row.userId;
      req.role = row.role;
      req.actor = row.email;
      return;
    }

    if (apiKey) {
      const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.apiKeyHash, hashApiKey(apiKey))).limit(1);
      if (!org) return reply.status(401).send({ error: "Clé API invalide" });
      req.orgId = org.id;
      req.userId = null;
      req.role = "admin";
      req.actor = "clé API";
      return;
    }

    return reply.status(401).send({ error: "Authentification requise (session ou en-tête x-api-key)" });
  };
}

export function requireRole(req: FastifyRequest, role: Role): void {
  if (!hasRole(req.role, role)) {
    const label = { owner: "propriétaire", admin: "administrateur", member: "membre" }[role];
    throw new HttpError(403, `Action réservée au rôle ${label} ou supérieur`);
  }
}

export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw new HttpError(403, "Action réservée à un utilisateur connecté, pas à une clé API");
  return req.userId;
}

export async function audit(db: Db, req: FastifyRequest | { orgId: string; actor: string }, action: string, target?: string, meta: Record<string, unknown> = {}) {
  await db.insert(auditLogs).values({ orgId: req.orgId, actor: req.actor, action, target, meta });
}

export async function ownerCount(db: Db, orgId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.orgId, orgId), eq(users.role, "owner")));
  return r?.n ?? 0;
}
