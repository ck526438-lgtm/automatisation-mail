/**
 * Test de bout en bout de l'application empaquetée (stage/) : démarre un SMTP de test,
 * puis lance stage/smoke.cjs (base embarquée, API, moteur, interface, e-mails système, redémarrage).
 *   node scripts/smoke.mjs
 */
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mails = [];
const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ["STARTTLS"],
  onData(stream, _s, cb) {
    simpleParser(stream).then((m) => { mails.push({ to: m.to?.text, subject: m.subject, messageId: m.messageId, text: m.text ?? "" }); cb(); }, cb);
  },
});
await new Promise((r) => smtp.listen(1025, "127.0.0.1", r));
const inbox = http.createServer((_q, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(mails)); });
await new Promise((r) => inbox.listen(4901, "127.0.0.1", r));

const dataDir = mkdtempSync(path.join(os.tmpdir(), "am-smoke-"));
const child = spawn(process.execPath, ["--no-deprecation", path.join(desktop, "stage/smoke.cjs"), dataDir, "http://127.0.0.1:4901"], {
  stdio: "inherit",
  env: { ...process.env, NODE_PATH: path.join(desktop, "stage/app/node_modules") },
});
const code = await new Promise((r) => child.on("exit", r));
smtp.close();
inbox.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(code ?? 1);
