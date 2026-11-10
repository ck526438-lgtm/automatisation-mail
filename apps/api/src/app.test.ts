import { describe, expect, it } from "vitest";
import type { Db } from "@am/db";
import { buildApp } from "./app.js";

// Ces tests ne touchent pas la base : ils couvrent les routes qui répondent avant toute requête SQL.
const app = await buildApp({ db: {} as Db });

describe("API", () => {
  it("répond au health check", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });

  it("exige une clé API sur /v1", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/contacts" });
    expect(r.statusCode).toBe(401);
  });

  it("refuse un jeton de désinscription falsifié, même en un clic", async () => {
    const r = await app.inject({
      method: "POST", url: "/u/faux.jeton",
      headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click",
    });
    expect(r.statusCode).toBe(404);
  });

  it("sert toujours le pixel, même pour un jeton inconnu", async () => {
    const r = await app.inject({ method: "GET", url: "/o/inconnu.gif" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/gif");
  });

  it("accepte les jetons de clic longs", async () => {
    const r = await app.inject({ method: "GET", url: `/c/${"a".repeat(600)}.sig` });
    expect(r.statusCode).toBe(404); // invalide, mais pas 414
  });
});
