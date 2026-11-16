import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linuxAutostartEnabled, linuxAutostartEntry, linuxAutostartFile, setLinuxAutostart } from "./platform.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("démarrage automatique sous Linux", () => {
  it("place le fichier dans ~/.config/autostart, ou dans XDG_CONFIG_HOME s'il est absolu", () => {
    expect(linuxAutostartFile("/home/awa", {})).toBe("/home/awa/.config/autostart/automatisation-mail.desktop");
    expect(linuxAutostartFile("/home/awa", { XDG_CONFIG_HOME: "/etc/xdg-awa" })).toBe("/etc/xdg-awa/autostart/automatisation-mail.desktop");
    expect(linuxAutostartFile("/home/awa", { XDG_CONFIG_HOME: "relatif" })).toBe("/home/awa/.config/autostart/automatisation-mail.desktop");
  });

  it("démarre masqué et protège les chemins avec espaces ou caractères spéciaux", () => {
    const entry = linuxAutostartEntry('/home/awa/Mes Apps/Auto "Mail" $1.AppImage', "Automatisation Mail");
    expect(entry).toContain('Exec="/home/awa/Mes Apps/Auto \\"Mail\\" \\$1.AppImage" --hidden');
    expect(entry.startsWith("[Desktop Entry]\nType=Application\nName=Automatisation Mail\n")).toBe(true);
  });

  it("active puis désactive", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "am-autostart-"));
    dirs.push(dir);
    const file = path.join(dir, "autostart", "automatisation-mail.desktop");
    expect(linuxAutostartEnabled(file)).toBe(false);
    setLinuxAutostart(true, "/opt/Automatisation Mail/automatisation-mail", "Automatisation Mail", file);
    expect(linuxAutostartEnabled(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("--hidden");
    setLinuxAutostart(false, "", "Automatisation Mail", file);
    expect(linuxAutostartEnabled(file)).toBe(false);
    setLinuxAutostart(false, "", "Automatisation Mail", file); // sans erreur si déjà absent
  });
});
