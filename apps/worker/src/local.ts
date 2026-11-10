/**
 * Moteur local, sans Redis : utilisé par l'application Windows.
 * Tout tourne dans le même processus ; la file d'envoi est la table `messages`
 * (statut « queued », next_attempt_at), donc rien n'est perdu si l'application est fermée.
 */
import { eq, messages, sql, type Db } from "@am/db";
import { config } from "./config.js";
import { isQuiet, runInboxSync, type Log } from "./jobs.js";
import { recheckDomains, refreshHealthScores } from "./maintenance.js";
import { startScheduler, type SendQueue } from "./scheduler.js";
import { processSend } from "./sender.js";
import { deliverSystemEmails } from "./system-mail.js";

const MAX_ATTEMPTS = 4;
/** Délais entre tentatives après une erreur temporaire : 1 min, 4 min, 16 min. */
const backoffMs = (attempt: number) => 60_000 * 4 ** Math.max(0, attempt - 1);

/** La ligne est déjà en base au moment de l'inscription en file : rien d'autre à faire. */
export const localSendQueue: SendQueue = { enqueue: async () => undefined };

/** Traite les envois dus, un par un, jusqu'à épuisement ou limite du lot. */
export async function drainSendQueue(db: Db, log: Log, batch = 20): Promise<number> {
  const { rows } = await db.execute<{ id: string; attempts: number }>(sql`
    select id, attempts from messages
    where status = 'queued' and (next_attempt_at is null or next_attempt_at <= now())
    order by next_attempt_at nulls first limit ${batch}`);
  for (const row of rows) {
    try {
      const outcome = await processSend(db, row.id);
      if (outcome.status === "delay") {
        await db.update(messages).set({ nextAttemptAt: outcome.until }).where(eq(messages.id, row.id));
      } else {
        log(`Envoi ${row.id} : ${outcome.note}`);
      }
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = (err as Error).message;
      if (attempts >= MAX_ATTEMPTS) {
        await db.update(messages).set({ status: "failed", attempts, error: message }).where(eq(messages.id, row.id));
        log(`Envoi ${row.id} abandonné après ${attempts} tentatives`, message);
      } else {
        await db.update(messages).set({ attempts, error: message, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) }).where(eq(messages.id, row.id));
        log(`Échec envoi ${row.id} (tentative ${attempts}), nouvel essai plus tard`, message);
      }
    }
  }
  return rows.length;
}

export interface LocalEngine {
  stop(): Promise<void>;
}

export function startLocalEngine(db: Db, log: Log): LocalEngine {
  const stopScheduler = startScheduler(db, localSendQueue, log);
  const timers: NodeJS.Timeout[] = [];
  const busy = new Set<string>();

  /** Lance `fn` toutes les `everyMs`, sans chevauchement, et une première fois après `firstMs`. */
  const every = (name: string, everyMs: number, firstMs: number, fn: () => Promise<unknown>) => {
    const run = async () => {
      if (busy.has(name)) return;
      busy.add(name);
      try {
        await fn();
      } catch (err) {
        log(`Tâche ${name} en échec`, (err as Error).message);
      } finally {
        busy.delete(name);
      }
    };
    timers.push(setTimeout(run, firstMs));
    timers.push(setInterval(run, everyMs));
  };

  every("envois", 5_000, 2_000, () => drainSendQueue(db, log));
  every("e-mails système", 15_000, 3_000, () => deliverSystemEmails(db, log));
  every("boîtes", config.inboxSyncIntervalMs, 20_000, async () => {
    const t = await runInboxSync(db, log);
    if (!isQuiet(t)) log("Boîtes lues", t);
  });
  every("santé", 3_600_000, 60_000, () => refreshHealthScores(db));
  every("dns", 86_400_000, 120_000, () => recheckDomains(db));

  log("Moteur local démarré : séquences, envois, lecture des boîtes et e-mails système");
  return {
    async stop() {
      stopScheduler();
      timers.forEach((t) => clearTimeout(t));
      // Laisse finir une tâche en cours au plus 10 s.
      const deadline = Date.now() + 10_000;
      while (busy.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    },
  };
}
