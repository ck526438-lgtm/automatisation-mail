/**
 * Worker en mode serveur : BullMQ sur Redis, plusieurs instances possibles.
 * (L'application Windows utilise le moteur local, voir local.ts.)
 */
import { DelayedError, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createDb } from "@am/db";
import { config } from "./config.js";
import { isQuiet, runInboxSync } from "./jobs.js";
import { recheckDomains, refreshHealthScores } from "./maintenance.js";
import { startScheduler, type SendJob, type SendQueue } from "./scheduler.js";
import { processSend } from "./sender.js";
import { deliverSystemEmails } from "./system-mail.js";

const log = (msg: string, extra?: unknown) => console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? "");

const { db, pool } = createDb();
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

const sendQueue = new Queue<SendJob>("send", { connection });
const queue: SendQueue = {
  enqueue: async (messageId) => {
    await sendQueue.add("send", { messageId }, { jobId: messageId, attempts: 4, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 1000, removeOnFail: 5000 });
  },
};

const sendWorker = new Worker<SendJob>("send", async (job, token) => {
  const outcome = await processSend(db, job.data.messageId);
  if (outcome.status === "delay") {
    await job.log(`Repoussé au ${outcome.until.toISOString()} : ${outcome.reason}`);
    await job.moveToDelayed(outcome.until.getTime(), token);
    throw new DelayedError();
  }
  return outcome.note;
}, { connection, concurrency: config.sendConcurrency });
sendWorker.on("completed", (job, result) => log(`Envoi ${job.id} : ${result}`));
sendWorker.on("failed", (job, err) => log(`Échec envoi ${job?.id} (tentative ${job?.attemptsMade})`, err.message));

const maintenanceQueue = new Queue("maintenance", { connection });
await maintenanceQueue.upsertJobScheduler("health", { every: 3_600_000 }, { name: "health" });
await maintenanceQueue.upsertJobScheduler("dns", { pattern: "17 3 * * *" }, { name: "dns" });
await maintenanceQueue.upsertJobScheduler("inbox", { every: config.inboxSyncIntervalMs }, { name: "inbox" });
await maintenanceQueue.upsertJobScheduler("system-mail", { every: 15_000 }, { name: "system-mail" });
const maintenanceWorker = new Worker("maintenance", async (job) => {
  if (job.name === "health") return `scores mis à jour : ${await refreshHealthScores(db)}`;
  if (job.name === "dns") return `domaines vérifiés : ${await recheckDomains(db)}`;
  if (job.name === "system-mail") return `e-mails système envoyés : ${await deliverSystemEmails(db, log)}`;
  if (job.name === "inbox") {
    const t = await runInboxSync(db, log);
    return isQuiet(t) ? "" : `boîtes lues : ${JSON.stringify(t)}`;
  }
  return "inconnu";
}, { connection });
// Les tâches fréquentes ne sont journalisées que lorsqu'il s'est passé quelque chose.
maintenanceWorker.on("completed", (job, r) => {
  if (r && !/^e-mails système envoyés : 0$/.test(String(r))) log(`Maintenance ${job.name} : ${r}`);
});

const stopScheduler = startScheduler(db, queue, log);
log("Worker démarré (mode serveur) : scheduler, envoi et maintenance actifs");

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
