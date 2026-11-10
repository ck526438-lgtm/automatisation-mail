import { describe, expect, it } from "vitest";
import {
  AttemptLimiter, canManage, checkPasswordStrength, DUMMY_PASSWORD_HASH, hashPassword, hashToken, hasRole, newToken, verifyPassword,
} from "../src/index.js";

describe("mots de passe", () => {
  it("hache avec un sel et vérifie", async () => {
    const a = await hashPassword("Cocody-Riviera-2026");
    const b = await hashPassword("Cocody-Riviera-2026");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("Cocody-Riviera-2026", a)).toBe(true);
    expect(await verifyPassword("cocody-riviera-2026", a)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
    expect(await verifyPassword("x", DUMMY_PASSWORD_HASH)).toBe(false);
  });

  it("refuse les mots de passe faibles", () => {
    expect(checkPasswordStrength("court").ok).toBe(false);
    expect(checkPasswordStrength("motdepasse").ok).toBe(false);
    expect(checkPasswordStrength("aaaaaaaaaaaa").ok).toBe(false);
    expect(checkPasswordStrength("awakone-2026!", "awakone@acme.ci").ok).toBe(false);
    expect(checkPasswordStrength("Plateau-Lagune-17").ok).toBe(true);
  });
});

describe("jetons et rôles", () => {
  it("ne stocke que l'empreinte du jeton", () => {
    const { token, hash } = newToken();
    expect(token).toMatch(/^ses_/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toContain(token.slice(4));
  });

  it("hiérarchise les rôles", () => {
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("member", "admin")).toBe(false);
    expect(canManage("admin", "member", "admin")).toBe(true);
    expect(canManage("admin", "owner")).toBe(false);
    expect(canManage("admin", "member", "owner")).toBe(false);
    expect(canManage("member", "member", "member")).toBe(false);
    expect(canManage("owner", "admin", "owner")).toBe(true);
  });
});

describe("limitation des tentatives", () => {
  it("bloque après 5 échecs puis relâche après la fenêtre", () => {
    const l = new AttemptLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      expect(l.check("ip|awa", 1000 + i)).toBe(0);
      l.fail("ip|awa", 1000 + i);
    }
    expect(l.check("ip|awa", 2000)).toBeGreaterThan(0);
    expect(l.check("ip|autre", 2000)).toBe(0);
    expect(l.check("ip|awa", 62_000)).toBe(0);
  });
});
