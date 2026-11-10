import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDb } from "@am/db";
import { config } from "./config.js";
import { startScheduler, type SendJob } from "./scheduler.js";
import { makeSendProcessor } from "./sender.js";
import { recheckDomains, refreshHealthScores } from "./maintenance.js";
import { accountsToSync, syncAccount } from "./mailbox/sync.js";

const log = (msg: string, extra?: unknown) => console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? "");

const { db, pool } = createDb();
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const sendQueue = new Queue<SendJob>("send", { connection });
const sendWorker = new Worker<SendJob>("send", makeSendProcessor(db), { connection, concurrency: config.sendConcurrency });
sendWorker.on("completed", (job, result) => log(`Envoi ${job.id} : ${result}`));
sendWorker.on("failed", (job, err) => log(`Échec envoi ${job?.id} (tentative ${job?.attemptsMade})`, err.message));

const maintenanceQueue = new Queue("maintenance", { connection });
await maintenanceQueue.upsertJobScheduler("health", { every: 3_600_000 }, { name: "health" });
await maintenanceQueue.upsertJobScheduler("dns", { pattern: "17 3 * * *" }, { name: "dns" });
await maintenanceQueue.upsertJobScheduler("inbox", { every: config.inboxSyncIntervalMs }, { name: "inbox" });
const maintenanceWorker = new Worker("maintenance", async (job) => {
  if (job.name === "health") return `scores mis à jour : ${await refreshHealthScores(db)}`;
  if (job.name === "dns") return `domaines vérifiés : ${await recheckDomains(db)}`;
  if (job.name === "inbox") {
    const totals = { boites: 0, reponses: 0, absences: 0, rebonds: 0, erreurs: 0 };
    for (const account of await accountsToSync(db)) {
      try {
        const r = await syncAccount(db, account);
        if (!r) continue;
        totals.boites++;
        totals.reponses += r.replies;
        totals.absences += r.autoReplies;
        totals.rebonds += r.bounces;
      } catch (err) {
        totals.erreurs++;
        log(`Synchro de ${account.email} en échec`, (err as Error).message);
      }
    }
    return `boîtes lues : ${JSON.stringify(totals)}`;
  }
  return "inconnu";
}, { connection });
maintenanceWorker.on("completed", (job, r) => {
  // La synchro tourne toutes les 2 minutes : on ne journalise que lorsqu'il s'est passé quelque chose.
  if (job.name !== "inbox" || !/"reponses":0,"absences":0,"rebonds":0,"erreurs":0/.test(String(r))) log(`Maintenance ${job.name} : ${r}`);
});

const stopScheduler = startScheduler(db, sendQueue, log);
log("Worker démarré : scheduler, envoi et maintenance actifs");

const shutdown = async () => {
  log("Arrêt du worker…");
  stopScheduler();
  await Promise.all([sendWorker.close(), maintenanceWorker.close()]);
  await Promise.all([sendQueue.close(), maintenanceQueue.close()]);
  connection.disconnect();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
