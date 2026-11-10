/**
 * Envoi des e-mails système en attente par le SMTP dédié (invitations, mot de passe, alertes).
 */
import nodemailer, { type Transporter } from "nodemailer";
import { eq, getSystemSmtp, sql, systemEmails, type Db, type SystemSmtp } from "@am/db";
import { config } from "./config.js";
import type { Log } from "./jobs.js";

const MAX_ATTEMPTS = 6;
let cached: { key: string; transporter: Transporter } | null = null;

function transporter(c: SystemSmtp): Transporter {
  const key = [c.host, c.port, c.secure, c.user, c.pass].join("|");
  if (cached?.key !== key) {
    cached = { key, transporter: nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined }) };
  }
  return cached.transporter;
}

/** Envoie les e-mails dus. Sans SMTP configuré, ils restent en attente et partiront dès la configuration. */
export async function deliverSystemEmails(db: Db, log: Log, batch = 20): Promise<number> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select id from system_emails where status = 'pending' and next_attempt_at <= now() order by created_at limit ${batch}`);
  if (rows.length === 0) return 0;
  const smtp = await getSystemSmtp(db, config.encryptionKey);
  if (!smtp) return 0;
  let sent = 0;
  for (const { id } of rows) {
    const [m] = await db.select().from(systemEmails).where(eq(systemEmails.id, id));
    if (!m || m.status !== "pending") continue;
    try {
      await transporter(smtp).sendMail({
        from: smtp.from, to: m.to, subject: m.subject, text: m.text, html: m.html,
        headers: { "Auto-Submitted": "auto-generated", "X-AM-System": m.kind },
      });
      await db.update(systemEmails).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(systemEmails.id, id));
      sent++;
      log(`E-mail système « ${m.kind} » envoyé à ${m.to}`);
    } catch (err) {
      const attempts = m.attempts + 1;
      const e = err as Error & { responseCode?: number };
      // Refus définitif (adresse invalide) ou trop d'échecs : on abandonne.
      const permanent = Boolean(e.responseCode && e.responseCode >= 500 && e.responseCode !== 535);
      await db.update(systemEmails).set({
        attempts, error: e.message.slice(0, 500),
        status: permanent || attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** attempts),
      }).where(eq(systemEmails.id, id));
      log(`E-mail système vers ${m.to} en échec (tentative ${attempts})`, e.message);
    }
  }
  return sent;
}

/** Envoi immédiat d'un test, pour valider la configuration depuis l'interface. */
export async function testSystemSmtp(smtp: SystemSmtp, to: string): Promise<void> {
  const t = nodemailer.createTransport({ host: smtp.host, port: smtp.port, secure: smtp.secure, auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined });
  await t.verify();
  await t.sendMail({ from: smtp.from, to, subject: "Test d'envoi — Automatisation Mail", text: "La configuration des e-mails système fonctionne." });
}
