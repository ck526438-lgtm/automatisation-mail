/**
 * Démarre tout Automatisation Mail sur le poste, dans un seul processus :
 * base embarquée (PGlite) + API + moteur local (séquences, envois, lecture des boîtes, e-mails système),
 * puis l'interface Next.js dans un processus enfant. Sans dépendance à Electron : testable avec Node.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

export interface RuntimeOptions {
  /** Dossier des données (base, journaux) */
  dataDir: string;
  /** Dossier des ressources empaquetées (migrations, interface) */
  resourcesDir: string;
  /** Secrets propres au poste, générés au premier lancement */
  secrets: { encryptionKey: string; trackingSecret: string };
  /** Exécutable Node pour l'interface (Electron en mode Node, ou `node` en test) */
  nodeExecutable: string;
  nodeEnv?: Record<string, string>;
  apiPort?: number;
  log: (msg: string, extra?: unknown) => void;
}

export interface Runtime {
  apiUrl: string;
  webUrl: string;
  sessionToken: string;
  sessionExpiresAt: Date;
  stop(): Promise<void>;
}

export const DEFAULT_API_PORT = 47811;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true))).listen(port, "127.0.0.1");
  });
}

async function freePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 50; p++) if (await portFree(p)) return p;
  throw new Error("Aucun port local disponible");
}

/** Réglages facultatifs du poste : identifiants OAuth Google/Microsoft, SMTP système… (config.json) */
function loadUserConfig(dataDir: string): Record<string, string> {
  const file = path.join(dataDir, "config.json");
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

async function waitFor(url: string, timeoutMs: number, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`L'interface s'est arrêtée (code ${child.exitCode})`);
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Délai dépassé en attendant ${url}`);
}

export async function startRuntime(o: RuntimeOptions): Promise<Runtime> {
  const apiPort = o.apiPort ?? DEFAULT_API_PORT;
  if (!(await portFree(apiPort))) {
    throw new Error(`Le port ${apiPort} est déjà utilisé : Automatisation Mail est peut-être déjà ouvert sur ce poste.`);
  }
  const webPort = await freePort(apiPort + 1);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  // Les modules de configuration lisent l'environnement au chargement : on le fixe avant de les importer.
  Object.assign(process.env, {
    AM_MODE: "desktop",
    NODE_ENV: "production",
    API_PORT: String(apiPort),
    API_PUBLIC_URL: apiUrl,
    WEB_URL: webUrl,
    CORS_ORIGIN: webUrl,
    ALLOW_SIGNUP: "false",
    ENCRYPTION_KEY: o.secrets.encryptionKey,
    TRACKING_SECRET: o.secrets.trackingSecret,
    LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
    ...loadUserConfig(o.dataDir),
  });

  const { openLocalDb } = await import("@am/db/local");
  const { ensureDesktopOwner, openDesktopSession } = await import("@am/db");
  const { buildApp } = await import("../../api/src/app.js");
  const { startLocalEngine } = await import("../../worker/src/local.js");

  o.log("Ouverture de la base locale", o.dataDir);
  const local = await openLocalDb(path.join(o.dataDir, "base"), path.join(o.resourcesDir, "migrations"));

  const owner = await ensureDesktopOwner(local.db, { orgName: "Mon entreprise", userName: "Moi", email: "proprietaire@poste.local" });
  const session = await openDesktopSession(local.db, owner.userId);

  const app = await buildApp({ db: local.db });
  await app.listen({ port: apiPort, host: "127.0.0.1" });
  o.log("API démarrée", apiUrl);

  const engine = startLocalEngine(local.db, o.log);

  const webDir = path.join(o.resourcesDir, "web");
  const serverJs = ["apps/web/server.js", "server.js"].map((p) => path.join(webDir, p)).find((p) => existsSync(p));
  if (!serverJs) throw new Error(`Interface introuvable dans ${webDir}`);
  const web = spawn(o.nodeExecutable, [serverJs], {
    cwd: path.dirname(serverJs),
    env: { ...process.env, ...o.nodeEnv, PORT: String(webPort), HOSTNAME: "127.0.0.1", API_URL: apiUrl, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  web.stdout?.on("data", (d) => o.log(`[interface] ${String(d).trim()}`));
  web.stderr?.on("data", (d) => o.log(`[interface] ${String(d).trim()}`));
  await waitFor(`${webUrl}/connexion`, 60_000, web);
  o.log("Interface prête", webUrl);

  let stopped = false;
  return {
    apiUrl, webUrl, sessionToken: session.token, sessionExpiresAt: session.expiresAt,
    async stop() {
      if (stopped) return;
      stopped = true;
      web.kill();
      await engine.stop();
      await app.close();
      await local.close();
    },
  };
}
