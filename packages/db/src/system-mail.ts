/**
 * E-mails système : modèles, file d'envoi et configuration du SMTP dédié.
 * Ils partent d'une adresse de la plateforme, jamais d'une boîte de prospection,
 * pour ne pas mélanger leur réputation avec celle des campagnes.
 */
import { decryptSecret, encryptSecret } from "@am/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { platformSettings, systemEmails, users } from "./schema.js";

export interface SystemSmtp {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  /** Adresse expéditrice, ex. « Automatisation Mail <no-reply@exemple.ci> » */
  from: string;
  source: "env" | "settings";
}

const SETTINGS_KEY = "system_smtp";

/** Lit la configuration : variables d'environnement d'abord (serveur), sinon réglage enregistré (application). */
export async function getSystemSmtp(db: Db, encryptionKey: string): Promise<SystemSmtp | null> {
  const e = process.env;
  if (e.SYSTEM_SMTP_HOST && e.SYSTEM_SMTP_FROM) {
    return {
      host: e.SYSTEM_SMTP_HOST, port: Number(e.SYSTEM_SMTP_PORT ?? 587), secure: e.SYSTEM_SMTP_SECURE === "true",
      user: e.SYSTEM_SMTP_USER ?? "", pass: e.SYSTEM_SMTP_PASS ?? "", from: e.SYSTEM_SMTP_FROM, source: "env",
    };
  }
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, SETTINGS_KEY));
  if (!row) return null;
  const v = row.value as { host: string; port: number; secure: boolean; user: string; passEnc?: string; from: string };
  return { host: v.host, port: v.port, secure: v.secure, user: v.user, pass: v.passEnc ? decryptSecret(v.passEnc, encryptionKey) : "", from: v.from, source: "settings" };
}

export async function saveSystemSmtp(db: Db, encryptionKey: string, v: Omit<SystemSmtp, "source" | "pass"> & { pass?: string }): Promise<void> {
  const [existing] = await db.select().from(platformSettings).where(eq(platformSettings.key, SETTINGS_KEY));
  // Mot de passe laissé vide = on garde l'ancien.
  const passEnc = v.pass ? encryptSecret(v.pass, encryptionKey) : (existing?.value as { passEnc?: string } | undefined)?.passEnc;
  const value = { host: v.host, port: v.port, secure: v.secure, user: v.user, from: v.from, passEnc };
  await db.insert(platformSettings).values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: new Date() } });
}

// ---------------------------------------------------------------------------------------------
// Modèles

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(title: string, paragraphs: string[], button?: { label: string; url: string }, footnote?: string): Rendered {
  const text = [title, "", ...paragraphs, ...(button ? ["", `${button.label} : ${button.url}`] : []), ...(footnote ? ["", footnote] : []), "", "— Automatisation Mail"].join("\n");
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f6f8fb;font-family:Arial,Helvetica,sans-serif;color:#18233d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e7ef;border-radius:12px">
<tr><td style="padding:24px 28px 8px"><div style="font-weight:700;letter-spacing:.04em;color:#17407f">AUTOMATISATION <span style="color:#f2771f">MAIL</span></div></td></tr>
<tr><td style="padding:8px 28px 4px"><h1 style="font-size:20px;margin:8px 0 12px">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join("\n")}
${button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#1f5fbf;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${esc(button.label)}</a></p>
<p style="font-size:12px;color:#5d6882;word-break:break-all">Ou copiez ce lien : ${esc(button.url)}</p>` : ""}
${footnote ? `<p style="font-size:12px;color:#5d6882;margin-top:20px">${esc(footnote)}</p>` : ""}
</td></tr><tr><td style="padding:12px 28px 24px;font-size:12px;color:#5d6882">E-mail automatique envoyé par Automatisation Mail.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: title, text, html };
}

const ROLE_FR = { owner: "propriétaire", admin: "administrateur", member: "membre" } as const;

export const systemTemplates = {
  invitation: (v: { orgName: string; inviter: string; role: keyof typeof ROLE_FR; link: string }) =>
    layout(`${v.inviter} vous invite à rejoindre ${v.orgName}`, [
      `Vous êtes invité(e) à rejoindre l'équipe ${v.orgName} sur Automatisation Mail, avec le rôle ${ROLE_FR[v.role]}.`,
      "Cliquez sur le bouton ci-dessous pour choisir votre mot de passe et accéder au compte.",
    ], { label: "Rejoindre l'équipe", url: v.link }, "Ce lien est valable 7 jours et ne peut servir qu'une fois. Si vous ne connaissez pas l'expéditeur, ignorez ce message."),

  passwordReset: (v: { name: string; link: string }) =>
    layout("Réinitialisation de votre mot de passe", [
      `Bonjour ${v.name},`,
      "Une demande de réinitialisation du mot de passe a été faite pour votre compte.",
    ], { label: "Choisir un nouveau mot de passe", url: v.link }, "Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de la demande, ignorez ce message : votre mot de passe reste inchangé."),

  passwordChanged: (v: { name: string }) =>
    layout("Votre mot de passe a été modifié", [
      `Bonjour ${v.name},`,
      "Le mot de passe de votre compte vient d'être modifié et vos autres sessions ont été fermées.",
      "Si vous n'êtes pas à l'origine de ce changement, utilisez « Mot de passe oublié » immédiatement et prévenez votre administrateur.",
    ]),

  campaignPaused: (v: { campaign: string; reason: string; link: string }) =>
    layout(`Campagne mise en pause : ${v.campaign}`, [
      `La campagne « ${v.campaign} » a été mise en pause automatiquement pour protéger la réputation de vos boîtes d'envoi.`,
      `Raison : ${v.reason}.`,
      "Vérifiez la qualité de la liste de contacts avant de la relancer.",
    ], { label: "Voir la campagne", url: v.link }),

  mailboxReconnect: (v: { email: string; link: string }) =>
    layout(`Boîte à reconnecter : ${v.email}`, [
      `L'accès à la boîte ${v.email} a été retiré ou a expiré. Ses envois et la lecture de ses réponses sont suspendus.`,
      "Reconnectez-la pour reprendre les séquences là où elles s'étaient arrêtées.",
    ], { label: "Reconnecter la boîte", url: v.link }),
};

// ---------------------------------------------------------------------------------------------
// File

export async function queueSystemEmail(db: Db, e: { to: string; kind: string; orgId?: string | null } & Rendered): Promise<string> {
  const [row] = await db.insert(systemEmails).values({ to: e.to, kind: e.kind, orgId: e.orgId ?? null, subject: e.subject, text: e.text, html: e.html }).returning({ id: systemEmails.id });
  return row!.id;
}

/** Envoie la même alerte aux propriétaires et administrateurs de l'organisation, au plus une fois par 12 h et par sujet. */
export async function notifyAdmins(db: Db, orgId: string, kind: string, mail: Rendered): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from system_emails where org_id = ${orgId} and kind = ${kind} and subject = ${mail.subject}
    and created_at > now() - interval '12 hours'`);
  if ((rows[0]?.n ?? 0) > 0) return 0;
  const admins = await db.select({ email: users.email }).from(users).where(and(eq(users.orgId, orgId), inArray(users.role, ["owner", "admin"])));
  for (const a of admins) await queueSystemEmail(db, { to: a.email, kind, orgId, ...mail });
  return admins.length;
}
