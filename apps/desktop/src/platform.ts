/**
 * Différences entre Windows, macOS et Linux : libellés, démarrage automatique à l'ouverture de session.
 * Sans dépendance à Electron pour la partie Linux (fichier .desktop), afin de rester testable.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Platform = "win32" | "darwin" | "linux";
export const platform: Platform = process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";

export const SYSTEM_NAME: Record<Platform, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

/** Où retrouver l'application une fois la fenêtre fermée. */
export const TRAY_HINT: Record<Platform, string> = {
  win32: "Clic droit sur l'icône près de l'horloge pour quitter.",
  darwin: "Cliquez sur l'icône dans la barre des menus pour la rouvrir ou quitter.",
  linux: "Utilisez l'icône de la zone de notification pour la rouvrir ou quitter.",
};

export const AUTOSTART_LABEL: Record<Platform, string> = {
  win32: "Démarrer avec Windows",
  darwin: "Ouvrir à l'ouverture de session",
  linux: "Démarrer à l'ouverture de session",
};

/** Linux : entrée XDG Autostart (~/.config/autostart), reconnue par GNOME, KDE, XFCE, Cinnamon… */
export function linuxAutostartFile(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(base, "autostart", "automatisation-mail.desktop");
}

/** Contenu du fichier .desktop. `exec` est le chemin de l'exécutable (ou de l'AppImage). */
export function linuxAutostartEntry(exec: string, name: string): string {
  // Spécification Desktop Entry : guillemets autour du chemin, échappement de " ` $ et \.
  const quoted = `"${exec.replace(/(["`$\\])/g, "\\$1")}"`;
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name}`,
    `Exec=${quoted} --hidden`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

export function linuxAutostartEnabled(file = linuxAutostartFile()): boolean {
  return existsSync(file);
}

export function setLinuxAutostart(enabled: boolean, exec: string, name: string, file = linuxAutostartFile()): void {
  if (!enabled) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, linuxAutostartEntry(exec, name));
}
