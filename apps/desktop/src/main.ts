/**
 * Application de bureau d'Automatisation Mail (Electron) : Windows, macOS et Linux.
 * - démarre la base, l'API, le moteur d'envoi et l'interface sur le poste ;
 * - ouvre la session automatiquement ;
 * - reste dans la zone de notification (barre des menus sur macOS) quand on ferme la fenêtre,
 *   pour que les séquences continuent ;
 * - peut démarrer à l'ouverture de session.
 */
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, safeStorage, session, shell, Tray } from "electron";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AUTOSTART_LABEL, linuxAutostartEnabled, platform, setLinuxAutostart, SYSTEM_NAME, TRAY_HINT } from "./platform.js";
import { startRuntime, type Runtime } from "./runtime.js";

const APP_NAME = "Automatisation Mail";
const RELEASES_URL = "https://github.com/ck526438-lgtm/automatisation-mail/releases/latest";
const HELP_URL = "https://github.com/ck526438-lgtm/automatisation-mail/blob/main/docs/applications.md";
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

/** Secrets propres au poste, chiffrés par le système quand c'est possible (DPAPI, Trousseau macOS, libsecret/KWallet). */
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
        body: `L'application continue d'envoyer vos séquences en arrière-plan. ${TRAY_HINT[platform]}`,
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

/** Démarrage à l'ouverture de session. Electron ne le gère pas sous Linux : on écrit une entrée XDG Autostart. */
function autostartEnabled(): boolean {
  return platform === "linux" ? linuxAutostartEnabled() : app.getLoginItemSettings().openAtLogin;
}

function setAutostart(enabled: boolean) {
  try {
    if (platform === "linux") {
      // Une AppImage est montée à un chemin temporaire : c'est le fichier .AppImage qu'il faut relancer.
      setLinuxAutostart(enabled, process.env.APPIMAGE ?? process.execPath, APP_NAME);
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
    }
  } catch (err) {
    log("Démarrage automatique non modifié", String(err));
  }
}

/** Lancé par le système à l'ouverture de session : pas de fenêtre, seulement l'icône. */
function startedHidden(): boolean {
  return process.argv.includes("--hidden") || (platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin);
}

function quit() {
  quitting = true;
  app.quit();
}

function buildTray() {
  let icon = nativeImage.createFromPath(path.join(assetsDir, "tray.png"));
  // La barre des menus de macOS attend une icône d'environ 18 points.
  if (platform === "darwin") icon = icon.resize({ width: 18, height: 18, quality: "best" });
  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME} — envois actifs`);
  const refresh = () => {
    const startup = autostartEnabled();
    tray!.setContextMenu(Menu.buildFromTemplate([
      { label: `Ouvrir ${APP_NAME}`, click: showWindow },
      { type: "separator" },
      {
        label: AUTOSTART_LABEL[platform], type: "checkbox", checked: startup,
        click: () => {
          setAutostart(!startup);
          refresh();
        },
      },
      { label: "Ouvrir le dossier des données", click: () => void shell.openPath(dataDir) },
      { label: "Ouvrir le journal", click: () => void shell.openPath(logFile) },
      { type: "separator" },
      { label: "Aide", click: () => void shell.openExternal(HELP_URL) },
      { label: `Rechercher une mise à jour (version ${app.getVersion()})`, click: () => void shell.openExternal(RELEASES_URL) },
      { type: "separator" },
      { label: "Quitter (arrête les envois)", click: quit },
    ]));
  };
  refresh();
  // Windows : clic gauche = ouvrir. macOS et Linux affichent le menu au clic.
  if (platform === "win32") tray.on("click", showWindow);
}

/**
 * macOS : menu d'application en français (sans lui, ⌘C / ⌘V / ⌘Q ne fonctionnent pas dans la fenêtre).
 * Windows et Linux gardent le menu par défaut, masqué, pour ses raccourcis clavier.
 */
function buildAppMenu() {
  if (platform !== "darwin") return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: `À propos d'${APP_NAME}` },
        { type: "separator" },
        { role: "hide", label: `Masquer ${APP_NAME}` },
        { role: "hideOthers", label: "Masquer les autres" },
        { role: "unhide", label: "Tout afficher" },
        { type: "separator" },
        { label: "Quitter (arrête les envois)", accelerator: "Command+Q", click: quit },
      ],
    },
    {
      label: "Édition",
      submenu: [
        { role: "undo", label: "Annuler" },
        { role: "redo", label: "Rétablir" },
        { type: "separator" },
        { role: "cut", label: "Couper" },
        { role: "copy", label: "Copier" },
        { role: "paste", label: "Coller" },
        { role: "selectAll", label: "Tout sélectionner" },
      ],
    },
    {
      label: "Présentation",
      submenu: [
        { role: "reload", label: "Actualiser" },
        { type: "separator" },
        { role: "resetZoom", label: "Taille réelle" },
        { role: "zoomIn", label: "Agrandir" },
        { role: "zoomOut", label: "Réduire" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Plein écran" },
      ],
    },
    {
      label: "Fenêtre",
      submenu: [
        { role: "minimize", label: "Réduire" },
        { role: "close", label: "Fermer la fenêtre" },
      ],
    },
    {
      label: "Aide",
      submenu: [
        { label: "Guide de l'application", click: () => void shell.openExternal(HELP_URL) },
        { label: "Rechercher une mise à jour", click: () => void shell.openExternal(RELEASES_URL) },
        { label: "Ouvrir le journal", click: () => void shell.openPath(logFile) },
      ],
    },
  ]));
}

async function boot() {
  mkdirSync(dataDir, { recursive: true });
  log(`Démarrage ${APP_NAME} ${app.getVersion()} (${SYSTEM_NAME[platform]} ${process.arch})`);
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

  buildAppMenu();
  try {
    buildTray();
  } catch (err) {
    // Certains bureaux Linux n'ont pas de zone de notification : relancer l'application rouvre la fenêtre.
    log("Zone de notification indisponible", String(err));
  }
  if (!startedHidden() || !tray) createWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(boot);
  // Fenêtre fermée : on reste dans la zone de notification.
  app.on("window-all-closed", () => undefined);
  // macOS : clic sur l'icône du Dock.
  app.on("activate", () => { if (runtime) showWindow(); });
  app.on("before-quit", (e) => {
    quitting = true;
    if (!runtime) return;
    e.preventDefault();
    const r = runtime;
    runtime = null;
    void r.stop().catch((err) => log("Erreur à l'arrêt", String(err))).finally(() => app.exit(0));
  });
}
