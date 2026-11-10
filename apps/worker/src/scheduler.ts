/**
 * Scheduler : réclame les inscriptions dues (FOR UPDATE SKIP LOCKED, plusieurs workers possibles),
 * fait avancer chacune dans son graphe et met les envois en file.
 */
import { randomUUID } from "node:crypto";
import { advance, type WorkflowEvent, type Effect } from "@am/core";
import {
  and, contacts, contactTags, eq, enrollments, inArray, messages, sendingAccounts,
  sql, tags, workflowVersions, type Db,
} from "@am/db";
import { config } from "./config.js";

type Enrollment = typeof enrollments.$inferSelect;

export interface SendJob {
  messageId: string;
}

/**
 * File d'envoi. En mode serveur : BullMQ sur Redis. En mode local (application Windows) :
 * la table messages elle-même (statut « queued » + next_attempt_at), relue en boucle.
 */
export interface SendQueue {
  enqueue(messageId: string): Promise<void>;
}

/** Réserve un lot d'inscriptions dues en repoussant leur échéance de 5 minutes (bail). */
async function claimDue(db: Db, limit: number): Promise<Enrollment[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    update enrollments set next_run_at = now() + interval '5 minutes'
    where id in (
      select e.id from enrollments e join campaigns c on c.id = e.campaign_id
      where e.state in ('active','waiting') and e.next_run_at <= now() and c.status = 'running'
      order by e.next_run_at limit ${limit} for update of e skip locked
    ) returning id`);
  if (rows.length === 0) return [];
  return db.select().from(enrollments).where(inArray(enrollments.id, rows.map((r) => r.id)));
}

/** Choisit la boîte la moins sollicitée aujourd'hui parmi celles de la campagne, en bonne santé. */
async function pickAccount(db: Db, campaignId: string): Promise<string | null> {
  const { rows } = await db.execute<{ id: string }>(sql`
    select a.id from campaign_accounts ca join sending_accounts a on a.id = ca.sending_account_id
    where ca.campaign_id = ${campaignId} and not a.paused and a.health_score >= 50
    order by (select count(*) from enrollments e where e.sending_account_id = a.id and e.state in ('active','waiting')) asc
    limit 1`);
  return rows[0]?.id ?? null;
}

async function applyEffect(db: Db, queue: SendQueue, e: Enrollment, effect: Effect, accountId: string | null): Promise<void> {
  switch (effect.kind) {
    case "send_email": {
      if (!accountId) throw new Error("Aucune boîte d'envoi disponible pour cette campagne");
      const [acc] = await db.select({ email: sendingAccounts.email }).from(sendingAccounts).where(eq(sendingAccounts.id, accountId));
      const domain = acc?.email.split("@")[1] ?? "localhost";
      let inReplyTo: string | null = null;
      if (effect.threadWith) {
        const [parent] = await db.select({ h: messages.messageIdHeader }).from(messages)
          .where(and(eq(messages.enrollmentId, e.id), eq(messages.nodeId, effect.threadWith))).limit(1);
        inReplyTo = parent?.h ?? null;
      }
      const [msg] = await db.insert(messages).values({
        orgId: e.orgId, enrollmentId: e.id, campaignId: e.campaignId, contactId: e.contactId, nodeId: effect.nodeId,
        sendingAccountId: accountId, messageIdHeader: `${randomUUID()}@${domain}`, inReplyTo,
        subject: "", status: "queued", idempotencyKey: `${e.id}:${effect.nodeId}`,
      }).onConflictDoNothing().returning({ id: messages.id });
      // Si la ligne existe déjà, l'e-mail a déjà été mis en file : pas de double envoi.
      if (msg) await queue.enqueue(msg.id);
      break;
    }
    case "add_tag":
    case "remove_tag": {
      await db.insert(tags).values({ orgId: e.orgId, name: effect.tag }).onConflictDoNothing();
      const [t] = await db.select().from(tags).where(and(eq(tags.orgId, e.orgId), eq(tags.name, effect.tag)));
      if (!t) break;
      if (effect.kind === "add_tag") await db.insert(contactTags).values({ contactId: e.contactId, tagId: t.id }).onConflictDoNothing();
      else await db.delete(contactTags).where(and(eq(contactTags.contactId, e.contactId), eq(contactTags.tagId, t.id)));
      break;
    }
    case "set_status":
      await db.update(contacts).set({ customFields: sql`${contacts.customFields} || ${JSON.stringify({ pipeline_status: effect.status })}::jsonb` })
        .where(eq(contacts.id, e.contactId));
      break;
    case "webhook":
      // Notification sortante, sans bloquer la séquence en cas d'échec.
      await fetch(effect.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enrollmentId: e.id, contactId: e.contactId, campaignId: e.campaignId, at: new Date().toISOString() }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      break;
  }
}

export async function processEnrollment(db: Db, queue: SendQueue, e: Enrollment): Promise<void> {
  const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, e.workflowVersionId));
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, e.contactId));
  if (!version || !contact) {
    await db.update(enrollments).set({ state: "stopped", stopReason: "données manquantes", nextRunAt: null }).where(eq(enrollments.id, e.id));
    return;
  }
  if (contact.status !== "active") {
    await db.update(enrollments).set({ state: "stopped", stopReason: contact.status, nextRunAt: null }).where(eq(enrollments.id, e.id));
    return;
  }
  const tagRows = await db.select({ name: tags.name }).from(contactTags).innerJoin(tags, eq(tags.id, contactTags.tagId)).where(eq(contactTags.contactId, contact.id));
  const evRows = await db.execute<{ type: WorkflowEvent["type"]; node_id: string | null; meta: Record<string, unknown>; occurred_at: Date }>(sql`
    select type, node_id, meta, occurred_at from events
    where contact_id = ${contact.id} and campaign_id = ${e.campaignId} and not is_bot order by occurred_at`);
  const events: WorkflowEvent[] = evRows.rows.map((r) => ({
    type: r.type, nodeId: r.node_id ?? undefined, occurredAt: new Date(r.occurred_at).toISOString(),
    bounceKind: r.type === "bounce" ? (r.meta.kind as WorkflowEvent["bounceKind"]) : undefined,
  }));

  const result = advance(version.graph, {
    currentNodeId: e.currentNodeId, state: e.state, enteredNodeAt: e.enteredNodeAt.toISOString(),
  }, { tags: tagRows.map((t) => t.name), fields: { ...contact.customFields, email: contact.email, company: contact.company, title: contact.title, country: contact.country } }, events);

  let accountId = e.sendingAccountId;
  if (!accountId && result.effects.some((x) => x.kind === "send_email")) {
    accountId = await pickAccount(db, e.campaignId);
    if (!accountId) {
      // Aucune boîte disponible : on réessaie dans une heure sans avancer.
      await db.update(enrollments).set({ nextRunAt: new Date(Date.now() + 3_600_000) }).where(eq(enrollments.id, e.id));
      return;
    }
  }
  for (const effect of result.effects) await applyEffect(db, queue, e, effect, accountId);

  await db.update(enrollments).set({
    state: result.state, currentNodeId: result.currentNodeId, enteredNodeAt: new Date(result.enteredNodeAt),
    nextRunAt: result.nextRunAt ? new Date(result.nextRunAt) : null, stopReason: result.stopReason ?? null,
    sendingAccountId: accountId,
  }).where(eq(enrollments.id, e.id));
}

export function startScheduler(db: Db, queue: SendQueue, log: (msg: string, extra?: unknown) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      let batch: Enrollment[];
      do {
        batch = await claimDue(db, config.schedulerBatch);
        for (const e of batch) {
          try {
            await processEnrollment(db, queue, e);
          } catch (err) {
            log(`Erreur sur l'inscription ${e.id}`, (err as Error).message);
            await db.update(enrollments).set({ nextRunAt: new Date(Date.now() + 600_000) }).where(eq(enrollments.id, e.id));
          }
        }
        if (batch.length) log(`Scheduler : ${batch.length} inscription(s) traitée(s)`);
      } while (batch.length === config.schedulerBatch);
    } catch (err) {
      log("Erreur du scheduler", (err as Error).message);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(tick, config.schedulerIntervalMs);
  return () => clearInterval(timer);
}

