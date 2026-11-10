/**
 * Comptes utilisateurs : inscription, connexion, invitations, équipe et clé API.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "@am/db";
import { z } from "zod";
import {
  AttemptLimiter, canManage, checkPasswordStrength, DUMMY_PASSWORD_HASH, hashPassword, hashToken, newToken, verifyPassword, type Role,
} from "@am/core";
import nodemailer from "nodemailer";
import {
  and, auditLogs, desc, eq, generateApiKey, getSystemSmtp, gte, hashApiKey, invitations, isNull, ne, organizations,
  passwordResets, queueSystemEmail, saveSystemSmtp, sessions, systemTemplates, users, type Db,
} from "@am/db";
import type { AppDeps } from "../app.js";
import { audit, HttpError, ownerCount, requireRole, requireUser, SESSION_TTL_MS } from "../auth.js";
import { config } from "../config.js";

const email = z.string().trim().toLowerCase().email("Adresse e-mail invalide");
const role = z.enum(["owner", "admin", "member"]);
const INVITE_TTL_MS = 7 * 86_400_000;
const RESET_TTL_MS = 3_600_000;

function strongPassword(password: string, mail: string) {
  const c = checkPasswordStrength(password, mail);
  if (!c.ok) throw new HttpError(422, `Mot de passe trop faible : ${c.reason}`);
}

async function openSession(db: Db, userId: string, req: FastifyRequest) {
  const { token, hash } = newToken("ses");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ userId, tokenHash: hash, expiresAt, ip: req.ip, userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  return { token, expiresAt };
}

const publicUser = (u: typeof users.$inferSelect) => ({ id: u.id, email: u.email, name: u.name, role: u.role, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, hasPassword: Boolean(u.passwordHash) });

/** Routes publiques : /auth/* */
export function registerPublicAuthRoutes(app: FastifyInstance, { db }: AppDeps) {
  const byIp = new AttemptLimiter(30, 15 * 60_000);
  const byAccount = new AttemptLimiter(5, 15 * 60_000);

  app.register(async (r) => {
    r.post("/signup", async (req, reply) => {
      if (!config.allowSignup) throw new HttpError(403, "Les inscriptions sont fermées : demandez une invitation");
      const body = z.object({ orgName: z.string().trim().min(2).max(120), name: z.string().trim().min(1).max(120), email, password: z.string() }).parse(req.body);
      strongPassword(body.password, body.email);
      const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
      if (taken) throw new HttpError(409, "Un compte existe déjà avec cette adresse : connectez-vous");
      const passwordHash = await hashPassword(body.password);
      const result = await db.transaction(async (tx) => {
        const [org] = await tx.insert(organizations).values({ name: body.orgName, apiKeyHash: hashApiKey(generateApiKey()) }).returning();
        const [user] = await tx.insert(users).values({ orgId: org!.id, email: body.email, name: body.name, role: "owner", passwordHash }).returning();
        return { org: org!, user: user! };
      });
      const session = await openSession(db, result.user.id, req);
      await audit(db, { orgId: result.org.id, actor: body.email }, "signup", result.org.name);
      return reply.status(201).send({ ...session, user: publicUser(result.user), org: { id: result.org.id, name: result.org.name } });
    });

    r.post("/login", async (req, reply) => {
      const body = z.object({ email, password: z.string().max(200) }).parse(req.body);
      const ipKey = req.ip;
      const accountKey = `${req.ip}|${body.email}`;
      const wait = Math.max(byIp.check(ipKey), byAccount.check(accountKey));
      if (wait > 0) return reply.status(429).header("retry-after", String(wait)).send({ error: `Trop de tentatives : réessayez dans ${Math.ceil(wait / 60)} min` });

      const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
      // Même calcul que l'adresse existe ou non : la durée de réponse ne révèle pas les comptes.
      const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!user || !ok) {
        byIp.fail(ipKey);
        byAccount.fail(accountKey);
        return reply.status(401).send({ error: "E-mail ou mot de passe incorrect" });
      }
      byAccount.reset(accountKey);
      const session = await openSession(db, user.id, req);
      await audit(db, { orgId: user.orgId, actor: user.email }, "login", undefined, { ip: req.ip });
      return { ...session, user: publicUser(user) };
    });

    r.post("/logout", async (req) => {
      const token = req.headers.authorization?.match(/^Bearer\s+(ses_\S+)$/i)?.[1];
      if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
      return { ok: true };
    });

    /** Toujours la même réponse, que le compte existe ou non. */
    const forgotLimiter = new AttemptLimiter(5, 60 * 60_000);
    r.post("/forgot", async (req, reply) => {
      const body = z.object({ email }).parse(req.body);
      if (forgotLimiter.check(`${req.ip}|${body.email}`) > 0) return reply.status(429).send({ error: "Trop de demandes : réessayez plus tard" });
      forgotLimiter.fail(`${req.ip}|${body.email}`);
      const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
      if (user) {
        const { token, hash } = newToken("rst");
        await db.insert(passwordResets).values({ userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + RESET_TTL_MS) });
        await queueSystemEmail(db, { to: user.email, kind: "password_reset", orgId: user.orgId,
          ...systemTemplates.passwordReset({ name: user.name ?? user.email, link: `${config.webUrl}/reinitialisation/${token}` }) });
        await audit(db, { orgId: user.orgId, actor: user.email }, "password.reset_request", undefined, { ip: req.ip });
      }
      return { ok: true };
    });

    r.post("/reset", async (req) => {
      const body = z.object({ token: z.string(), password: z.string() }).parse(req.body);
      const [row] = await db.select().from(passwordResets).where(eq(passwordResets.tokenHash, hashToken(body.token))).limit(1);
      if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) throw new HttpError(410, "Lien expiré ou déjà utilisé : refaites une demande");
      const [user] = await db.select().from(users).where(eq(users.id, row.userId));
      if (!user) throw new HttpError(410, "Compte introuvable");
      strongPassword(body.password, user.email);
      const claimed = await db.update(passwordResets).set({ usedAt: new Date() })
        .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt))).returning({ id: passwordResets.id });
      if (claimed.length === 0) throw new HttpError(410, "Lien déjà utilisé");
      await db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, user.id));
      // Toutes les sessions existantes sont fermées : seule la personne qui a le nouveau mot de passe garde l'accès.
      await db.delete(sessions).where(eq(sessions.userId, user.id));
      await queueSystemEmail(db, { to: user.email, kind: "password_changed", orgId: user.orgId, ...systemTemplates.passwordChanged({ name: user.name ?? user.email }) });
      await audit(db, { orgId: user.orgId, actor: user.email }, "password.reset");
      return { ok: true };
    });

    r.get<{ Params: { token: string } }>("/invitation/:token", async (req) => {
      const inv = await validInvitation(db, req.params.token);
      const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, inv.orgId));
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
      return { email: inv.email, role: inv.role, orgName: org?.name ?? "", accountExists: Boolean(existing) };
    });

    r.post("/accept-invite", async (req, reply) => {
      const body = z.object({ token: z.string(), name: z.string().trim().min(1).max(120), password: z.string() }).parse(req.body);
      const inv = await validInvitation(db, body.token);
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, inv.email));
      if (existing) throw new HttpError(409, "Cette adresse a déjà un compte, dans une autre organisation");
      strongPassword(body.password, inv.email);
      const passwordHash = await hashPassword(body.password);
      const user = await db.transaction(async (tx) => {
        // Le marquage conditionnel empêche d'utiliser deux fois le même lien en parallèle.
        const claimed = await tx.update(invitations).set({ acceptedAt: new Date() })
          .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt))).returning({ id: invitations.id });
        if (claimed.length === 0) throw new HttpError(410, "Invitation déjà utilisée");
        const [u] = await tx.insert(users).values({ orgId: inv.orgId, email: inv.email, name: body.name, role: inv.role, passwordHash }).returning();
        return u!;
      });
      const session = await openSession(db, user.id, req);
      await audit(db, { orgId: inv.orgId, actor: user.email }, "invitation.accept", user.email, { role: user.role });
      return reply.status(201).send({ ...session, user: publicUser(user) });
    });
  }, { prefix: "/auth" });
}

async function validInvitation(db: Db, token: string) {
  const [inv] = await db.select().from(invitations).where(eq(invitations.tokenHash, hashToken(token))).limit(1);
  if (!inv) throw new HttpError(404, "Invitation introuvable");
  if (inv.acceptedAt) throw new HttpError(410, "Invitation déjà utilisée");
  if (inv.expiresAt.getTime() < Date.now()) throw new HttpError(410, "Invitation expirée : demandez-en une nouvelle");
  return inv;
}

/** Routes authentifiées : /v1/me, /v1/users, /v1/invitations, /v1/api-key, /v1/audit */
export function registerTeamRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get("/me", async (req) => {
    const [org] = await db.select({ id: organizations.id, name: organizations.name, postalAddress: organizations.postalAddress, timezone: organizations.timezone })
      .from(organizations).where(eq(organizations.id, req.orgId));
    if (!req.userId) return { user: null, role: req.role, org, mode: config.mode, canManagePlatform: false };
    const [u] = await db.select().from(users).where(eq(users.id, req.userId));
    return { user: publicUser(u!), role: req.role, org, mode: config.mode, canManagePlatform: canManagePlatform(req.role, u!.email) };
  });

  app.patch("/me", async (req) => {
    const userId = requireUser(req);
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), currentPassword: z.string().optional(), newPassword: z.string().optional() }).parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    if (body.newPassword) {
      // Compte local de l'application sans mot de passe : il peut en définir un directement.
      if (u!.passwordHash && !(await verifyPassword(body.currentPassword ?? "", u!.passwordHash))) throw new HttpError(403, "Mot de passe actuel incorrect");
      strongPassword(body.newPassword, u!.email);
      await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, userId));
      // Changement de mot de passe : toutes les autres sessions sont fermées.
      const current = hashToken(req.headers.authorization?.split(" ")[1] ?? "");
      await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, current)));
      await audit(db, req, "password.change", u!.email);
      await queueSystemEmail(db, { to: u!.email, kind: "password_changed", orgId: u!.orgId, ...systemTemplates.passwordChanged({ name: u!.name ?? u!.email }) });
    }
    if (body.name) await db.update(users).set({ name: body.name }).where(eq(users.id, userId));
    return { ok: true };
  });

  /** Paramètres de l'organisation : nom et adresse postale (obligatoire en pied de message). */
  app.patch("/org", async (req) => {
    requireRole(req, "admin");
    const body = z.object({ name: z.string().trim().min(2).max(120).optional(), postalAddress: z.string().trim().max(300).optional(), timezone: z.string().optional() }).parse(req.body);
    if (body.timezone) {
      try { new Intl.DateTimeFormat("fr", { timeZone: body.timezone }); } catch { throw new HttpError(422, "Fuseau horaire inconnu"); }
    }
    await db.update(organizations).set(body).where(eq(organizations.id, req.orgId));
    await audit(db, req, "org.update", undefined, body);
    return { ok: true };
  });

  app.get("/users", async (req) => {
    const rows = await db.select().from(users).where(eq(users.orgId, req.orgId)).orderBy(users.createdAt);
    return rows.map(publicUser);
  });

  app.patch<{ Params: { id: string } }>("/users/:id", async (req) => {
    requireRole(req, "admin");
    const body = z.object({ role }).parse(req.body);
    const [target] = await db.select().from(users).where(and(eq(users.id, req.params.id), eq(users.orgId, req.orgId)));
    if (!target) throw new HttpError(404, "Utilisateur introuvable");
    if (!canManage(req.role, target.role, body.role)) throw new HttpError(403, "Vous ne pouvez pas attribuer ce rôle à cette personne");
    if (target.role === "owner" && body.role !== "owner" && (await ownerCount(db, req.orgId)) <= 1) {
      throw new HttpError(409, "L'organisation doit garder au moins un propriétaire");
    }
    await db.update(users).set({ role: body.role }).where(eq(users.id, target.id));
    await audit(db, req, "user.role", target.email, { from: target.role, to: body.role });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/users/:id", async (req, reply) => {
    requireRole(req, "admin");
    const [target] = await db.select().from(users).where(and(eq(users.id, req.params.id), eq(users.orgId, req.orgId)));
    if (!target) throw new HttpError(404, "Utilisateur introuvable");
    if (target.id === req.userId) throw new HttpError(409, "Vous ne pouvez pas vous retirer vous-même");
    if (!canManage(req.role, target.role)) throw new HttpError(403, "Vous ne pouvez pas retirer cette personne");
    if (target.role === "owner" && (await ownerCount(db, req.orgId)) <= 1) throw new HttpError(409, "L'organisation doit garder au moins un propriétaire");
    await db.delete(users).where(eq(users.id, target.id)); // les sessions partent en cascade
    await audit(db, req, "user.remove", target.email);
    return reply.status(204).send();
  });

  app.get("/invitations", async (req) => {
    requireRole(req, "admin");
    return db.select({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt, createdAt: invitations.createdAt })
      .from(invitations).where(and(eq(invitations.orgId, req.orgId), isNull(invitations.acceptedAt), gte(invitations.expiresAt, new Date())))
      .orderBy(desc(invitations.createdAt));
  });

  /** Crée une invitation et renvoie le lien à transmettre (l'envoi par e-mail est laissé à l'utilisateur). */
  app.post("/invitations", async (req, reply) => {
    requireRole(req, "admin");
    const body = z.object({ email, role: role.default("member") }).parse(req.body);
    if (!canManage(req.role, "member", body.role)) throw new HttpError(403, "Vous ne pouvez pas inviter avec ce rôle");
    const [existing] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.email, body.email));
    if (existing) throw new HttpError(409, existing.orgId === req.orgId ? "Cette personne fait déjà partie de l'équipe" : "Cette adresse a déjà un compte dans une autre organisation");
    // Une seule invitation active par adresse : la précédente est remplacée.
    await db.delete(invitations).where(and(eq(invitations.orgId, req.orgId), eq(invitations.email, body.email), isNull(invitations.acceptedAt)));
    const { token, hash } = newToken("inv");
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    const [inv] = await db.insert(invitations).values({ orgId: req.orgId, email: body.email, role: body.role, tokenHash: hash, invitedBy: req.userId, expiresAt }).returning({ id: invitations.id });
    await audit(db, req, "invitation.create", body.email, { role: body.role });
    const link = `${config.webUrl}/invitation/${token}`;
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, req.orgId));
    const [inviter] = req.userId ? await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, req.userId)) : [];
    await queueSystemEmail(db, { to: body.email, kind: "invitation", orgId: req.orgId,
      ...systemTemplates.invitation({ orgName: org?.name ?? "", inviter: inviter?.name ?? inviter?.email ?? "Votre équipe", role: body.role, link }) });
    const emailConfigured = Boolean(await getSystemSmtp(db, config.encryptionKey));
    return reply.status(201).send({ id: inv!.id, email: body.email, role: body.role, expiresAt, link, emailConfigured });
  });

  app.delete<{ Params: { id: string } }>("/invitations/:id", async (req, reply) => {
    requireRole(req, "admin");
    await db.delete(invitations).where(and(eq(invitations.id, req.params.id), eq(invitations.orgId, req.orgId)));
    return reply.status(204).send();
  });

  /** Nouvelle clé API d'organisation : l'ancienne cesse immédiatement de fonctionner. Affichée une seule fois. */
  app.post("/api-key/rotate", async (req) => {
    requireRole(req, "owner");
    requireUser(req);
    const apiKey = generateApiKey();
    await db.update(organizations).set({ apiKeyHash: hashApiKey(apiKey) }).where(eq(organizations.id, req.orgId));
    await audit(db, req, "api_key.rotate");
    return { apiKey };
  });

  const requirePlatform = async (req: FastifyRequest) => {
    const userId = requireUser(req);
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!canManagePlatform(req.role, u?.email ?? "")) throw new HttpError(403, "Réglage réservé à l'administrateur de la plateforme");
  };

  /** SMTP dédié aux e-mails système. Le mot de passe n'est jamais renvoyé. */
  app.get("/system-smtp", async (req) => {
    await requirePlatform(req);
    const c = await getSystemSmtp(db, config.encryptionKey);
    const { rows } = await db.execute<{ pending: number; failed: number }>(sql`
      select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'failed')::int as failed from system_emails`);
    return {
      configured: Boolean(c), source: c?.source ?? null,
      host: c?.host ?? "", port: c?.port ?? 587, secure: c?.secure ?? false, user: c?.user ?? "", from: c?.from ?? "", hasPassword: Boolean(c?.pass),
      queue: rows[0] ?? { pending: 0, failed: 0 },
    };
  });

  const smtpBody = z.object({
    host: z.string().trim().min(3), port: z.coerce.number().int().min(1).max(65535), secure: z.coerce.boolean(),
    user: z.string().trim().default(""), pass: z.string().optional(), from: z.string().trim().min(3),
  });

  app.put("/system-smtp", async (req) => {
    await requirePlatform(req);
    const current = await getSystemSmtp(db, config.encryptionKey);
    if (current?.source === "env") throw new HttpError(409, "Configuration fixée par les variables d'environnement du serveur");
    const body = smtpBody.parse(req.body);
    await saveSystemSmtp(db, config.encryptionKey, body);
    await audit(db, req, "system_smtp.update", body.host);
    return { ok: true };
  });

  /** Envoie un e-mail de test à l'utilisateur connecté, avec la configuration enregistrée. */
  app.post("/system-smtp/test", async (req) => {
    await requirePlatform(req);
    const c = await getSystemSmtp(db, config.encryptionKey);
    if (!c) throw new HttpError(409, "Aucun SMTP configuré");
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, req.userId!));
    const t = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15_000 });
    try {
      await t.verify();
      await t.sendMail({ from: c.from, to: u!.email, subject: "Test d'envoi — Automatisation Mail", text: "La configuration des e-mails système fonctionne." });
    } catch (err) {
      throw new HttpError(502, `Le serveur SMTP a refusé : ${(err as Error).message}`);
    }
    return { ok: true, to: u!.email };
  });

  app.get("/audit", async (req) => {
    requireRole(req, "admin");
    return db.select().from(auditLogs).where(eq(auditLogs.orgId, req.orgId)).orderBy(desc(auditLogs.occurredAt)).limit(200);
  });
}

/** Application locale : le propriétaire règle tout. Serveur : seulement les adresses listées dans PLATFORM_ADMINS. */
function canManagePlatform(role: Role, email: string): boolean {
  if (config.mode === "desktop") return role === "owner";
  return config.platformAdmins.includes(email.toLowerCase());
}

export type { Role };
