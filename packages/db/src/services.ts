/**
 * Services partagés entre l'API et les workers : enregistrement d'événements
 * et application des règles de conformité (suppression, arrêt des séquences, pause de campagne).
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { classifyBounce, normalizeEmail, shouldPauseCampaign, type BounceInput } from "@am/core";
import type { Db } from "./index.js";
import * as s from "./schema.js";
import { notifyAdmins, systemTemplates } from "./system-mail.js";

const webUrl = () => process.env.WEB_URL ?? "http://localhost:3000";

export type EventType = (typeof s.events.$inferInsert)["type"];

export async function isSuppressed(db: Db, orgId: string, email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  const rows = await db.select({ id: s.suppressions.id }).from(s.suppressions)
    .where(and(eq(s.suppressions.emailNormalized, e), or(eq(s.suppressions.orgId, orgId), isNull(s.suppressions.orgId))))
    .limit(1);
  return rows.length > 0;
}

export async function suppress(db: Db, orgId: string | null, email: string, reason: (typeof s.suppressions.$inferInsert)["reason"]): Promise<void> {
  const e = normalizeEmail(email);
  const existing = await db.select({ id: s.suppressions.id }).from(s.suppressions)
    .where(and(eq(s.suppressions.emailNormalized, e), orgId ? eq(s.suppressions.orgId, orgId) : isNull(s.suppressions.orgId))).limit(1);
  if (existing.length === 0) await db.insert(s.suppressions).values({ orgId, emailNormalized: e, reason });
}

/** Réveille les inscriptions du contact pour que le moteur réévalue conditions et arrêts. */
async function wakeEnrollments(db: Db, contactId: string, campaignId?: string | null): Promise<void> {
  await db.update(s.enrollments).set({ nextRunAt: new Date() })
    .where(and(
      eq(s.enrollments.contactId, contactId),
      sql`${s.enrollments.state} in ('active','waiting')`,
      campaignId ? eq(s.enrollments.campaignId, campaignId) : undefined,
    ));
}

export interface RecordEventInput {
  orgId: string;
  type: EventType;
  messageId?: string | null;
  contactId?: string | null;
  campaignId?: string | null;
  nodeId?: string | null;
  isBot?: boolean;
  meta?: Record<string, unknown>;
}

export async function recordEvent(db: Db, e: RecordEventInput): Promise<void> {
  await db.insert(s.events).values({
    orgId: e.orgId, type: e.type, messageId: e.messageId ?? null, contactId: e.contactId ?? null,
    campaignId: e.campaignId ?? null, nodeId: e.nodeId ?? null, isBot: e.isBot ?? false, meta: e.meta ?? {},
  });
  if (!e.contactId || e.isBot) return;

  const [contact] = await db.select().from(s.contacts).where(eq(s.contacts.id, e.contactId)).limit(1);
  if (!contact) return;

  switch (e.type) {
    case "unsubscribe":
      await db.update(s.contacts).set({ status: "unsubscribed" }).where(eq(s.contacts.id, contact.id));
      await suppress(db, e.orgId, contact.email, "unsubscribe");
      await stopAllEnrollments(db, contact.id, "unsubscribed");
      break;
    case "complaint":
      await db.update(s.contacts).set({ status: "complained" }).where(eq(s.contacts.id, contact.id));
      // Une plainte supprime l'adresse pour toute la plateforme.
      await suppress(db, null, contact.email, "complaint");
      await stopAllEnrollments(db, contact.id, "complaint");
      break;
    case "bounce": {
      const kind = (e.meta?.kind as string | undefined) ?? "soft";
      if (kind === "hard") {
        await db.update(s.contacts).set({ status: "bounced" }).where(eq(s.contacts.id, contact.id));
        await suppress(db, e.orgId, contact.email, "hard_bounce");
        await stopAllEnrollments(db, contact.id, "bounced");
      }
      if (e.campaignId) await checkCampaignHealth(db, e.campaignId);
      break;
    }
    case "reply":
      await stopAllEnrollments(db, contact.id, "reply", e.campaignId ?? undefined);
      break;
    case "open":
    case "click":
      await wakeEnrollments(db, contact.id, e.campaignId);
      break;
    default:
      break;
  }
}

export async function stopAllEnrollments(db: Db, contactId: string, reason: string, campaignId?: string): Promise<void> {
  await db.update(s.enrollments).set({ state: "stopped", stopReason: reason, nextRunAt: null })
    .where(and(
      eq(s.enrollments.contactId, contactId),
      sql`${s.enrollments.state} in ('active','waiting')`,
      campaignId ? eq(s.enrollments.campaignId, campaignId) : undefined,
    ));
}

export async function campaignStats(db: Db, campaignId: string) {
  const rows = await db.execute<{ type: string; total: string; humans: string; unique_contacts: string }>(sql`
    select type, count(*) as total, count(*) filter (where not is_bot) as humans,
           count(distinct contact_id) filter (where not is_bot) as unique_contacts
    from events where campaign_id = ${campaignId} group by type`);
  const by = Object.fromEntries(rows.rows.map((r) => [r.type, { total: Number(r.total), humans: Number(r.humans), unique: Number(r.unique_contacts) }]));
  const n = (t: string) => by[t]?.unique ?? 0;
  const sent = by.sent?.total ?? 0;
  const rate = (x: number) => (sent ? Math.round((1000 * x) / sent) / 10 : 0);
  return {
    sent,
    opened: n("open"), clicked: n("click"), replied: n("reply"),
    bounced: by.bounce?.total ?? 0, unsubscribed: n("unsubscribe"), complaints: by.complaint?.total ?? 0,
    rates: { open: rate(n("open")), click: rate(n("click")), reply: rate(n("reply")), bounce: rate(by.bounce?.total ?? 0), unsubscribe: rate(n("unsubscribe")) },
  };
}

export async function checkCampaignHealth(db: Db, campaignId: string): Promise<void> {
  const st = await campaignStats(db, campaignId);
  const verdict = shouldPauseCampaign({ sent: st.sent, bounced: st.bounced, complaints: st.complaints });
  if (verdict.pause) {
    const paused = await db.update(s.campaigns).set({ status: "paused", pauseReason: `Pause automatique : ${verdict.reason}` })
      .where(and(eq(s.campaigns.id, campaignId), eq(s.campaigns.status, "running"))).returning();
    const c = paused[0];
    if (c) {
      await notifyAdmins(db, c.orgId, "campaign_paused",
        systemTemplates.campaignPaused({ campaign: c.name, reason: verdict.reason ?? "seuil dépassé", link: `${webUrl()}/campagnes/${c.id}` }));
    }
  }
}

/** Traite un rebond rattaché à un message envoyé (par son en-tête Message-ID ou son id interne). */
export async function handleBounce(db: Db, ref: { messageIdHeader?: string; messageId?: string }, input: BounceInput, extraMeta: Record<string, unknown> = {}) {
  const where = ref.messageId ? eq(s.messages.id, ref.messageId) : eq(s.messages.messageIdHeader, ref.messageIdHeader ?? "");
  const [msg] = await db.select().from(s.messages).where(where).limit(1);
  if (!msg) return null;
  const verdict = classifyBounce(input);
  await db.update(s.messages).set({ status: "bounced", error: input.message ?? verdict.reason }).where(eq(s.messages.id, msg.id));
  await recordEvent(db, {
    orgId: msg.orgId, type: "bounce", messageId: msg.id, contactId: msg.contactId, campaignId: msg.campaignId,
    nodeId: msg.nodeId, meta: { kind: verdict.kind, reason: verdict.reason, code: input.code, enhanced: input.enhanced, ...extraMeta },
  });
  return verdict;
}

/** Traite une réponse entrante rattachée par In-Reply-To / References. */
export async function handleReply(db: Db, input: { inReplyTo: string[]; from: string; subject?: string; snippet?: string; autoReply?: boolean; extraMeta?: Record<string, unknown> }) {
  for (const ref of input.inReplyTo) {
    const [msg] = await db.select().from(s.messages).where(eq(s.messages.messageIdHeader, ref.replace(/[<>]/g, ""))).limit(1);
    if (!msg) continue;
    await recordEvent(db, {
      orgId: msg.orgId, type: input.autoReply ? "auto_reply" : "reply", messageId: msg.id, contactId: msg.contactId,
      campaignId: msg.campaignId, nodeId: msg.nodeId, meta: { from: input.from, subject: input.subject, snippet: input.snippet?.slice(0, 500), ...input.extraMeta },
    });
    return msg;
  }
  return null;
}

/** Détecte les réponses automatiques (absence, vacances) selon les en-têtes RFC 3834 et l'objet. */
export function isAutoReply(headers: Record<string, string | undefined>, subject = ""): boolean {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), (v ?? "").toLowerCase()]));
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"] || h["precedence"] === "auto_reply") return true;
  return /^(absence|out of office|automatic reply|réponse automatique|auto[- ]?reply|en congé)/i.test(subject.trim());
}

/** Vrai si ce message entrant (identifiant fournisseur) a déjà été traité : la synchro peut repasser dessus. */
export async function inboundAlreadyProcessed(db: Db, accountId: string, inboundId: string): Promise<boolean> {
  const { rows } = await db.execute(sql`
    select 1 from events where meta->>'inboundId' = ${inboundId} and meta->>'accountId' = ${accountId} limit 1`);
  return rows.length > 0;
}
