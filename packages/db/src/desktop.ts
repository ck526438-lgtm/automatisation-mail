/**
 * Démarrage de l'application Windows : un poste = une organisation et un propriétaire,
 * connecté automatiquement (pas d'écran de connexion sur son propre PC).
 */
import { generateApiKey, hashApiKey } from "./index.js";
import { newToken } from "@am/core";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { organizations, sessions, users } from "./schema.js";

const DESKTOP_AGENT = "Automatisation Mail (Windows)";

export async function ensureDesktopOwner(db: Db, defaults: { orgName: string; userName: string; email: string }): Promise<{ userId: string; orgId: string }> {
  const [owner] = await db.select().from(users).where(eq(users.role, "owner")).limit(1);
  if (owner) return { userId: owner.id, orgId: owner.orgId };
  const [org] = await db.insert(organizations).values({ name: defaults.orgName, apiKeyHash: hashApiKey(generateApiKey()) }).returning();
  // Pas de mot de passe : l'application ouvre la session elle-même. Il peut en définir un dans Équipe & réglages.
  const [user] = await db.insert(users).values({ orgId: org!.id, email: defaults.email, name: defaults.userName, role: "owner", passwordHash: null }).returning();
  return { userId: user!.id, orgId: org!.id };
}

/** Ouvre une session pour l'utilisateur local et renvoie le jeton à placer dans le cookie de la fenêtre. */
export async function openDesktopSession(db: Db, userId: string, ttlMs = 365 * 86_400_000): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = newToken("ses");
  const expiresAt = new Date(Date.now() + ttlMs);
  // Une seule session « application » à la fois : celle du lancement précédent est remplacée.
  await db.delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.userAgent, DESKTOP_AGENT)));
  await db.insert(sessions).values({ userId, tokenHash: hash, expiresAt, userAgent: DESKTOP_AGENT });
  return { token, expiresAt };
}
