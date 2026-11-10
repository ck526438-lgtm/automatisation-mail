import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeEmail } from "@am/core";
import { contacts, eq, messages, organizations, sendingAccounts, suppressions, type Db } from "@am/db";
import { openLocalDb, type LocalDb } from "@am/db/local";
import { processInbound } from "./sync.js";

// Base PostgreSQL réelle (PGlite en mémoire), migrations comprises.
let local: LocalDb;
let db: Db;
let account: typeof sendingAccounts.$inferSelect;
const migrations = fileURLToPath(new URL("../../../../packages/db/migrations", import.meta.url));

beforeAll(async () => {
  local = await openLocalDb("memory://", migrations);
  db = local.db;
  const [org] = await db.insert(organizations).values({ name: "Test", apiKeyHash: "x" }).returning();
  [account] = await db.insert(sendingAccounts).values({ orgId: org!.id, email: "vente@acme.ci", provider: "smtp" }).returning() as [typeof account];
  for (const email of ["adja@client.ci", "brou@client.ci"]) {
    const [c] = await db.insert(contacts).values({ orgId: org!.id, email, emailNormalized: normalizeEmail(email) }).returning();
    await db.insert(messages).values({ orgId: org!.id, contactId: c!.id, sendingAccountId: account.id, messageIdHeader: `m-${email}`, subject: "Bonjour", idempotencyKey: email, status: "sent", sentAt: new Date() });
  }
}, 60_000);

afterAll(async () => local?.close());

const status = async (email: string) => (await db.select({ s: contacts.status }).from(contacts).where(eq(contacts.email, email)))[0]?.s;

describe("désinscription par e-mail (base réelle)", () => {
  it("une réponse « STOP » désinscrit le contact et l'ajoute à la liste de suppression", async () => {
    const raw = Buffer.from("From: Adja <adja@client.ci>\r\nSubject: Re: Bonjour\r\nIn-Reply-To: <m-adja@client.ci>\r\n\r\nSTOP\r\n\r\n> Bonjour\r\n");
    const r = await processInbound(db, account, [{ id: "in-1", raw }]);
    expect(r).toMatchObject({ replies: 1, unsubscribes: 1 });
    expect(await status("adja@client.ci")).toBe("unsubscribed");
    expect((await db.select().from(suppressions)).map((s) => s.emailNormalized)).toContain("adja@client.ci");
  });

  it("l'e-mail du lien mailto (objet « unsubscribe », sans référence) désinscrit aussi", async () => {
    const raw = Buffer.from("From: brou@client.ci\r\nTo: vente@acme.ci\r\nSubject: unsubscribe\r\n\r\n");
    const r = await processInbound(db, account, [{ id: "in-2", raw }]);
    expect(r.unsubscribes).toBe(1);
    expect(await status("brou@client.ci")).toBe("unsubscribed");
  });

  it("le même message relu à la synchronisation suivante n'est pas compté deux fois", async () => {
    const raw = Buffer.from("From: Adja <adja@client.ci>\r\nSubject: Re: Bonjour\r\nIn-Reply-To: <m-adja@client.ci>\r\n\r\nSTOP\r\n");
    const r = await processInbound(db, account, [{ id: "in-1", raw }]);
    expect(r).toMatchObject({ replies: 0, unsubscribes: 0, ignored: 1 });
  });
});
