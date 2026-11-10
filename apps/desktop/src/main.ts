/**
 * Application Windows d'Automatisation Mail (Electron).
 * - démarre la base, l'API, le moteur d'envoi et l'interface sur le poste ;
 * - ouvre la session automatiquement ;
 * - reste dans la zone de notification quand on ferme la fenêtre, pour que les séquences continuent ;
 * - peut démarrer avec Windows.
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, safeStorage, session, shell, Tray } from "electron";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startRuntime, type Runtime } from "./runtime.js";

const APP_NAME = "Automatisation Mail";
app.setName(APP_NAME);
app.setAppUserModelId("ci.automatisation-mail.app");

const dataDir = app.getPath("userData");
const logFile = path.join(dataDir, "automatisation-mail.log");
// Empaqueté : resources/ d'Electron. En développement : apps/desktop/stage/resources (main.cjs est dans stage/app).
const resourcesDir = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "../resources");
const assetsDir = path.join(resourcesDir, "assets");

function log(msg: string, extra?: unknown) {
  const line = `[${new Date().toISOString()}] ${msg}${extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`}\n`;
  try {
    appendFileSync(logFile, line);
  } catch { /* disque plein ou dossier inaccessible */ }
  if (!app.isPackaged) process.stdout.write(line);
}

/** Secrets propres au poste, chiffrés par Windows (DPAPI) quand c'est possible. */
function loadSecrets(): { encryptionKey: string; trackingSecret: string } {
  const file = path.join(dataDir, "secrets.bin");
  if (existsSync(file)) {
    const buf = readFileSync(file);
    const json = safeStorage.isEncryptionAvailable() && buf[0] !== 0x7b ? safeStorage.decryptString(buf) : buf.toString("utf8");
    return JSON.parse(json);
  }
  const secrets = { encryptionKey: randomBytes(32).toString("hex"), trackingSecret: randomBytes(32).toString("base64url") };
  const json = JSON.stringify(secrets);
  writeFileSync(file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
  return secrets;
}

let runtime: Runtime | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let hintShown = false;

function isInternal(url: string): boolean {
  return Boolean(runtime) && (url.startsWith(runtime!.webUrl) || url.startsWith(runtime!.apiUrl));
}

function createWindow() {
  if (!runtime) return;
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(assetsDir, "icon.png"),
    backgroundColor: "#f6f8fb",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win?.show());

  // Pages externes (consentement Google/Microsoft, liens d'aide) : navigateur du système.
  // Google et Microsoft refusent l'authentification dans une fenêtre intégrée.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isInternal(url)) void shell.openExternal(url);
    return { action: isInternal(url) ? "allow" : "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isInternal(url)) return;
    e.preventDefault();
    void shell.openExternal(url);
  });
  // De retour d'une connexion de boîte dans le navigateur : on rafraîchit la page des boîtes.
  win.on("focus", () => {
    if (win?.webContents.getURL().includes("/boites")) win.webContents.reload();
  });

  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (!hintShown && Notification.isSupported()) {
      hintShown = true;
      new Notification({
        title: APP_NAME,
        body: "L'application continue d'envoyer vos séquences en arrière-plan. Clic droit sur l'icône près de l'horloge pour quitter.",
        icon: path.join(assetsDir, "icon.png"),
      }).show();
    }
  });

  void win.loadURL(runtime.webUrl);
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(assetsDir, "tray.png")));
  tray.setToolTip(`${APP_NAME} — envois actifs`);
  const refresh = () => {
    const startup = app.getLoginItemSettings().openAtLogin;
    tray!.setContextMenu(Menu.buildFromTemplate([
      { label: `Ouvrir ${APP_NAME}`, click: showWindow },
      { type: "separator" },
      {
        label: "Démarrer avec Windows", type: "checkbox", checked: startup,
        click: () => {
          app.setLoginItemSettings({ openAtLogin: !startup, args: ["--hidden"] });
          refresh();
        },
      },
      { label: "Ouvrir le dossier des données", click: () => void shell.openPath(dataDir) },
      { type: "separator" },
      { label: "Quitter (arrête les envois)", click: () => { quitting = true; app.quit(); } },
    ]));
  };
  refresh();
  tray.on("click", showWindow);
}

async function boot() {
  mkdirSync(dataDir, { recursive: true });
  log(`Démarrage ${APP_NAME} ${app.getVersion()}`);
  try {
    runtime = await startRuntime({
      dataDir,
      resourcesDir,
      secrets: loadSecrets(),
      nodeExecutable: process.execPath,
      nodeEnv: { ELECTRON_RUN_AS_NODE: "1" },
      log,
    });
  } catch (err) {
    log("Échec du démarrage", (err as Error).stack ?? String(err));
    dialog.showErrorBox(APP_NAME, `L'application n'a pas pu démarrer :\n\n${(err as Error).message}\n\nJournal : ${logFile}`);
    quitting = true;
    app.quit();
    return;
  }

  // Connexion automatique : le jeton de session va dans un cookie httpOnly de la fenêtre.
  await session.defaultSession.cookies.set({
    url: runtime.webUrl, name: "am_session", value: runtime.sessionToken, httpOnly: true, sameSite: "lax",
    expirationDate: Math.floor(runtime.sessionExpiresAt.getTime() / 1000),
  });

  buildTray();
  if (!process.argv.includes("--hidden")) createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(boot);
  // Fenêtre fermée : on reste dans la zone de notification.
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (e) => {
    quitting = true;
    if (!runtime) return;
    e.preventDefault();
    const r = runtime;
    runtime = null;
    void r.stop().catch((err) => log("Erreur à l'arrêt", String(err))).finally(() => app.exit(0));
  });
}
