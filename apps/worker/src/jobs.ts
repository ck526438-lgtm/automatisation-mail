/**
 * Tâches périodiques communes aux deux modes (serveur et application locale).
 */
import type { Db } from "@am/db";
import { accountsToSync, syncAccount } from "./mailbox/sync.js";

export type Log = (msg: string, extra?: unknown) => void;

export interface InboxTotals {
  boites: number;
  reponses: number;
  absences: number;
  rebonds: number;
  desinscriptions: number;
  erreurs: number;
}

export async function runInboxSync(db: Db, log: Log): Promise<InboxTotals> {
  const totals: InboxTotals = { boites: 0, reponses: 0, absences: 0, rebonds: 0, desinscriptions: 0, erreurs: 0 };
  for (const account of await accountsToSync(db)) {
    try {
      const r = await syncAccount(db, account);
      if (!r) continue;
      totals.boites++;
      totals.reponses += r.replies;
      totals.absences += r.autoReplies;
      totals.rebonds += r.bounces;
      totals.desinscriptions += r.unsubscribes;
    } catch (err) {
      totals.erreurs++;
      log(`Synchro de ${account.email} en échec`, (err as Error).message);
    }
  }
  return totals;
}

export const isQuiet = (t: InboxTotals) => t.reponses + t.absences + t.rebonds + t.desinscriptions + t.erreurs === 0;
