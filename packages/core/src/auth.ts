/**
 * Mots de passe, jetons de session et rôles.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

// Paramètres scrypt (N = 2^15) : environ 50 à 100 ms par vérification sur un serveur courant.
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEYLEN = 32;

/** Format : scrypt$N$r$p$<sel>$<empreinte>, en base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEYLEN, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Empreinte utilisée quand l'e-mail n'existe pas, pour que la réponse prenne le même temps. */
export const DUMMY_PASSWORD_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export interface PasswordCheck {
  ok: boolean;
  reason?: string;
}

const COMMON = new Set(["motdepasse", "password", "azertyuiop", "qwertyuiop", "1234567890", "0123456789", "motdepasse1", "password123", "abidjan2026", "automatisation"]);

export function checkPasswordStrength(password: string, email = ""): PasswordCheck {
  if (password.length < 10) return { ok: false, reason: "Au moins 10 caractères" };
  if (password.length > 200) return { ok: false, reason: "200 caractères au maximum" };
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return { ok: false, reason: "Mot de passe trop courant" };
  if (/^(.)\1+$/.test(password)) return { ok: false, reason: "Un seul caractère répété" };
  const local = email.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return { ok: false, reason: "Ne doit pas contenir votre adresse e-mail" };
  return { ok: true };
}

/** Jeton opaque (envoyé au client) et son empreinte (seule stockée en base). */
export function newToken(prefix = "ses"): { token: string; hash: string } {
  const token = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type Role = "owner" | "admin" | "member";

const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}

/**
 * Un utilisateur peut attribuer un rôle ou retirer quelqu'un seulement s'il a un rang au moins égal
 * au rôle visé et au rôle actuel de la personne. Seul un propriétaire peut nommer un propriétaire.
 */
export function canManage(actor: Role, targetCurrent: Role, targetNew?: Role): boolean {
  if (!hasRole(actor, "admin")) return false;
  if (RANK[targetCurrent] > RANK[actor]) return false;
  if (targetNew && RANK[targetNew] > RANK[actor]) return false;
  return true;
}

/**
 * Limitation des tentatives de connexion, en mémoire (une instance d'API).
 * Avec plusieurs instances, remplacer par un compteur Redis.
 */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max = 5, private readonly windowMs = 15 * 60_000) {}

  /** Renvoie le nombre de secondes à attendre, ou 0 si la tentative est autorisée. */
  check(key: string, now = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, recent);
    if (recent.length < this.max) return 0;
    return Math.ceil((recent[0]! + this.windowMs - now) / 1000);
  }

  fail(key: string, now = Date.now()): void {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.hits.delete(this.hits.keys().next().value!);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
