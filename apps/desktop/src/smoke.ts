/**
 * Test de bout en bout du moteur de l'application, sans Electron :
 *   node stage/smoke.cjs <dossier-données> <url-boîte-de-test>
 * Prérequis : un SMTP de test sur le port 1025 qui consigne les messages, et un faux Gmail (voir docs).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { startRuntime, type Runtime } from "./runtime.js";

const [dataDir = "/tmp/am-smoke", sinkUrl = "http://127.0.0.1:4901"] = process.argv.slice(2);
// Test uniquement : pas d'espacement aléatoire de 1 à 5 minutes entre deux envois de la même boîte.
process.env.MIN_GAP_SECONDS = "0";
process.env.MAX_GAP_SECONDS = "1";
const resourcesDir = path.resolve(__dirname, "resources");
mkdirSync(dataDir, { recursive: true });
const secrets = { encryptionKey: "ab".repeat(32), trackingSecret: "smoke-secret" };
const log = (m: string, e?: unknown) => { if (process.env.SMOKE_VERBOSE) console.log("   ", m, e ?? ""); };

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "✔" : "✘"} ${label}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

interface Mail { to: string; subject: string; text: string; messageId: string; lu?: unknown }
const mails = async (): Promise<Mail[]> => (await fetch(`${sinkUrl}/mails`)).json() as Promise<Mail[]>;

async function main() {
  const started = Date.now();
  let rt: Runtime = await startRuntime({ dataDir, resourcesDir, secrets, nodeExecutable: process.execPath, log, apiPort: 47811 });
  check("démarrage complet (base, API, moteur, interface)", true, `${Date.now() - started} ms`);

  const auth = { authorization: `Bearer ${rt.sessionToken}`, "content-type": "application/json" };
  const api = async <T>(p: string, init: RequestInit = {}) => {
    const r = await fetch(`${rt.apiUrl}${p}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(body)}`);
    return body as T;
  };

  // Interface avec la session automatique (le cookie que pose Electron)
  const home = await fetch(rt.webUrl, { headers: { cookie: `am_session=${rt.sessionToken}` }, redirect: "manual" });
  const html = await home.text();
  check("interface ouverte sans écran de connexion", home.status === 200 && html.includes("Tableau de bord"), home.status);
  const anon = await fetch(rt.webUrl, { redirect: "manual" });
  check("sans cookie, l'interface renvoie vers la connexion", anon.status === 307 && (anon.headers.get("location") ?? "").includes("/connexion"));
  const me = await api<{ mode: string; role: string; canManagePlatform: boolean; user: { hasPassword: boolean } }>("/v1/me");
  check("mode application, propriétaire local", me.mode === "desktop" && me.role === "owner" && me.canManagePlatform && !me.user.hasPassword);

  // Boîte SMTP de test, modèle et séquence
  await api("/v1/org", { method: "PATCH", body: JSON.stringify({ name: "Acme Côte d'Ivoire", postalAddress: "Plateau, Abidjan" }) });
  await api("/v1/accounts", { method: "POST", body: JSON.stringify({ email: "vente@acme-test.ci", fromName: "Awa", smtpHost: "127.0.0.1", smtpPort: 1025, dailyLimit: 200, warmupEnabled: false }) });
  const accounts = await api<{ id: string }[]>("/v1/accounts");
  const tpl = await api<{ id: string }>("/v1/templates", { method: "POST", body: JSON.stringify({ name: "Premier", subject: "Question pour {{company}}", bodyText: "Bonjour {{first_name}},\n\nUne question rapide ?" }) });
  const wf = await api<{ id: string }>("/v1/workflows", { method: "POST", body: JSON.stringify({ name: "Test", graph: { nodes: [
    { id: "s", type: "start", next: "e1" }, { id: "e1", type: "email", templateId: tpl.id, next: "w" },
    { id: "w", type: "wait", delay: { amount: 3, unit: "days" }, next: "f" }, { id: "f", type: "end" },
  ] } }) });
  const imp = await api<{ inserted: number }>("/v1/contacts/import", { method: "POST", body: JSON.stringify({ csv: "email;prenom;societe\nadja@client-a.ci;Adja;Alpha\nbrou@client-b.ci;Brou;Beta\nfaux;X;Y" }) });
  check("import CSV dans la base embarquée", imp.inserted === 2, imp);
  const camp = await api<{ id: string }>("/v1/campaigns", { method: "POST", body: JSON.stringify({ name: "Test local", workflowId: wf.id, sendingAccountIds: [accounts[0]!.id], sendWindow: { timezone: "UTC", startHour: 0, endHour: 24, days: [1, 2, 3, 4, 5, 6, 7] } }) });
  await api(`/v1/campaigns/${camp.id}/enroll`, { method: "POST", body: JSON.stringify({ all: true }) });
  await api(`/v1/campaigns/${camp.id}/start`, { method: "POST", body: "{}" });

  const sent = await until(async () => { const m = (await mails()).filter((x) => x.subject.startsWith("Question pour")); return m.length >= 2 ? m : null; }, 90_000);
  check("séquence envoyée par le moteur local (sans Redis)", Boolean(sent), sent?.map((m) => m.to));
  const first = sent?.[0];
  check("pas de lien vers ce poste dans l'e-mail (inaccessible aux destinataires)", Boolean(first) && !first!.text.includes("127.0.0.1"));
  check("désinscription par réponse « STOP » proposée", Boolean(first?.text.includes("répondez simplement « STOP »")));
  check("adresse postale en pied de message", Boolean(first?.text.includes("Plateau, Abidjan")));

  // E-mails système par le SMTP dédié
  const pending = await api<{ queue: { pending: number } }>("/v1/system-smtp");
  await api("/v1/system-smtp", { method: "PUT", body: JSON.stringify({ host: "127.0.0.1", port: 1025, secure: false, user: "", from: "Automatisation Mail <no-reply@acme-test.ci>" }) });
  await api("/v1/system-smtp/test", { method: "POST", body: "{}" });
  check("e-mail de test du SMTP système", Boolean(await until(async () => (await mails()).find((m) => m.subject.startsWith("Test d'envoi")))));
  await api("/v1/me", { method: "PATCH", body: JSON.stringify({ newPassword: "Treichville-Local-77" }) });
  const changed = await until(async () => (await mails()).find((m) => m.subject === "Votre mot de passe a été modifié"), 30_000);
  check("alerte « mot de passe modifié » envoyée automatiquement", Boolean(changed), `file avant config : ${pending.queue.pending}`);
  await fetch(`${rt.apiUrl}/auth/forgot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "proprietaire@poste.local" }) });
  const reset = await until(async () => (await mails()).find((m) => m.subject === "Réinitialisation de votre mot de passe"), 30_000);
  const resetLink = reset?.text.match(/https?:\/\/\S+\/reinitialisation\/\S+/)?.[0];
  check("e-mail « mot de passe oublié » avec lien", Boolean(resetLink), resetLink?.slice(0, 60));
  if (resetLink) {
    const r = await fetch(`${rt.apiUrl}/auth/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: resetLink.split("/").pop(), password: "Bingerville-Neuf-12" }) });
    check("réinitialisation par le lien reçu", r.ok);
    const again = await fetch(`${rt.apiUrl}/auth/reset`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: resetLink.split("/").pop(), password: "Bingerville-Neuf-13" }) });
    check("lien de réinitialisation à usage unique", again.status === 410);
  }

  // Redémarrage : les données restent sur le poste
  await rt.stop();
  rt = await startRuntime({ dataDir, resourcesDir, secrets, nodeExecutable: process.execPath, log, apiPort: 47811 });
  const after = await fetch(`${rt.apiUrl}/v1/contacts`, { headers: { authorization: `Bearer ${rt.sessionToken}` } }).then((r) => r.json()) as { total: number };
  const msgs = await fetch(`${rt.apiUrl}/v1/campaigns/${camp.id}/stats`, { headers: { authorization: `Bearer ${rt.sessionToken}` } }).then((r) => r.json()) as { sent: number };
  check("données conservées après redémarrage", after.total === 2 && msgs.sent === 2, { contacts: after.total, envoyes: msgs.sent });
  await rt.stop();

  console.log(failures ? `\n${failures} échec(s)` : "\nTout est bon.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("✘ Erreur :", err);
  process.exit(1);
});
