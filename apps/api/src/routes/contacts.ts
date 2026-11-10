import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyMapping, dedupeContacts, parseCsv, segmentToSql, suggestMapping, type SegmentRule } from "@am/core";
import { and, contacts, contactTags, desc, eq, inArray, segments, sql, suppressions, tags, isNull, or, paramSql, type Db } from "@am/db";
import type { AppDeps } from "../app.js";

const contactSchema = z.object({
  email: z.string().min(3),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  country: z.string().optional(),
  timezone: z.string().optional(),
  custom_fields: z.record(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  consent: z.object({ basis: z.enum(["consent", "legitimate_interest"]), proof: z.string().optional() }).optional(),
});

type ContactIn = z.infer<typeof contactSchema>;

const ruleSchema: z.ZodType<SegmentRule> = z.lazy(() => z.union([
  z.object({ all: z.array(ruleSchema) }),
  z.object({ any: z.array(ruleSchema) }),
  z.object({ not: ruleSchema }),
  z.object({ field: z.string(), op: z.enum(["eq", "neq", "contains", "not_contains", "starts_with", "exists", "not_exists", "gt", "lt"]), value: z.union([z.string(), z.number()]).optional() }),
  z.object({ tag: z.string(), has: z.boolean() }),
  z.object({ activity: z.enum(["open", "click", "reply"]), withinDays: z.number().int().positive(), has: z.boolean() }),
]));

async function suppressedSet(db: Db, orgId: string, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const rows = await db.select({ e: suppressions.emailNormalized }).from(suppressions)
    .where(and(inArray(suppressions.emailNormalized, emails), or(eq(suppressions.orgId, orgId), isNull(suppressions.orgId))));
  return new Set(rows.map((r) => r.e));
}

async function ensureTags(db: Db, orgId: string, names: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();
  await db.insert(tags).values(unique.map((name) => ({ orgId, name }))).onConflictDoNothing();
  const rows = await db.select().from(tags).where(and(eq(tags.orgId, orgId), inArray(tags.name, unique)));
  return new Map(rows.map((t) => [t.name, t.id]));
}

export async function upsertContacts(db: Db, orgId: string, rows: ContactIn[], strategy: "skip" | "overwrite" | "fill_empty", source: string) {
  const prelim = rows.map((r) => r.email.trim().toLowerCase());
  const sup = await suppressedSet(db, orgId, prelim);
  const result = dedupeContacts(rows, { strategy, suppressed: sup });
  let inserted = 0;
  let updated = 0;
  const tagMap = await ensureTags(db, orgId, result.contacts.flatMap((c) => c.tags ?? []));

  for (let i = 0; i < result.contacts.length; i += 500) {
    const batch = result.contacts.slice(i, i + 500);
    const values = batch.map((c) => ({
      orgId, email: c.email.trim(), emailNormalized: c.emailNormalized,
      firstName: c.first_name, lastName: c.last_name, company: c.company, title: c.title, phone: c.phone,
      country: c.country, timezone: c.timezone, customFields: c.custom_fields ?? {}, source,
      consent: c.consent ? { ...c.consent, at: new Date().toISOString() } : { basis: "legitimate_interest" as const, at: new Date().toISOString() },
    }));
    const q = db.insert(contacts).values(values);
    const rowsOut = strategy === "skip"
      ? await q.onConflictDoNothing().returning({ id: contacts.id, email: contacts.emailNormalized, isNew: sql<boolean>`true` })
      : await q.onConflictDoUpdate({
          target: [contacts.orgId, contacts.emailNormalized],
          set: strategy === "overwrite"
            ? { firstName: sql`excluded.first_name`, lastName: sql`excluded.last_name`, company: sql`excluded.company`, title: sql`excluded.title`, phone: sql`excluded.phone`, country: sql`excluded.country`, customFields: sql`${contacts.customFields} || excluded.custom_fields` }
            : { firstName: sql`coalesce(${contacts.firstName}, excluded.first_name)`, lastName: sql`coalesce(${contacts.lastName}, excluded.last_name)`, company: sql`coalesce(${contacts.company}, excluded.company)`, title: sql`coalesce(${contacts.title}, excluded.title)`, phone: sql`coalesce(${contacts.phone}, excluded.phone)`, country: sql`coalesce(${contacts.country}, excluded.country)`, customFields: sql`excluded.custom_fields || ${contacts.customFields}` },
        }).returning({ id: contacts.id, email: contacts.emailNormalized, isNew: sql<boolean>`(xmax = 0)` });
    for (const r of rowsOut) (r.isNew ? inserted++ : updated++);
    const idByEmail = new Map(rowsOut.map((r) => [r.email, r.id]));
    const links = batch.flatMap((c) => (c.tags ?? []).map((t) => ({ contactId: idByEmail.get(c.emailNormalized), tagId: tagMap.get(t.trim()) })))
      .filter((l): l is { contactId: string; tagId: string } => Boolean(l.contactId && l.tagId));
    if (links.length) await db.insert(contactTags).values(links).onConflictDoNothing();
  }
  return { inserted, updated, duplicates: result.duplicates, suppressed: result.suppressed, invalid: result.invalid };
}

export function registerContactRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get("/contacts", async (req) => {
    const q = z.object({
      status: z.enum(["active", "unsubscribed", "bounced", "complained"]).optional(),
      search: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const where = and(
      eq(contacts.orgId, req.orgId),
      q.status ? eq(contacts.status, q.status) : undefined,
      q.search ? sql`(${contacts.emailNormalized} ilike ${"%" + q.search + "%"} or ${contacts.company} ilike ${"%" + q.search + "%"} or ${contacts.lastName} ilike ${"%" + q.search + "%"})` : undefined,
    );
    const [rows, totals] = await Promise.all([
      db.select().from(contacts).where(where).orderBy(desc(contacts.createdAt)).limit(q.limit).offset(q.offset),
      db.select({ total: sql<number>`count(*)::int`.as("total") }).from(contacts).where(where),
    ]);
    return { total: totals[0]?.total ?? 0, items: rows };
  });

  app.post("/contacts", async (req, reply) => {
    const body = contactSchema.parse(req.body);
    const r = await upsertContacts(db, req.orgId, [body], "fill_empty", "api");
    if (r.invalid.length) return reply.status(422).send({ error: "Adresse invalide", detail: r.invalid[0] });
    if (r.suppressed) return reply.status(409).send({ error: "Adresse présente dans la liste de suppression" });
    return reply.status(201).send(r);
  });

  app.post("/contacts/bulk", async (req) => {
    const body = z.object({
      contacts: z.array(contactSchema).max(1000),
      strategy: z.enum(["skip", "overwrite", "fill_empty"]).default("fill_empty"),
    }).parse(req.body);
    return upsertContacts(db, req.orgId, body.contacts, body.strategy, "api");
  });

  /** Import CSV : corps text/csv, ou JSON { csv, mapping?, strategy?, tags? } */
  app.post("/contacts/import", async (req) => {
    const input = typeof req.body === "string" ? { csv: req.body } : z.object({
      csv: z.string(),
      mapping: z.record(z.string()).optional(),
      strategy: z.enum(["skip", "overwrite", "fill_empty"]).optional(),
      tags: z.array(z.string()).optional(),
    }).parse(req.body);
    const rows = parseCsv(input.csv);
    if (rows.length < 2) return { inserted: 0, updated: 0, duplicates: 0, suppressed: 0, invalid: [], mapping: {} };
    const mapping = input.mapping ? Object.fromEntries(Object.entries(input.mapping).map(([k, v]) => [Number(k), v])) : suggestMapping(rows[0]!);
    if (!Object.values(mapping).includes("email")) {
      const err = new Error("Aucune colonne e-mail détectée : fournissez un mapping") as Error & { statusCode: number };
      err.statusCode = 422;
      throw err;
    }
    const mapped = applyMapping(rows.slice(1), mapping).map((r) => ({ ...r, tags: "tags" in input ? input.tags : undefined }));
    const result = await upsertContacts(db, req.orgId, mapped, ("strategy" in input && input.strategy) || "fill_empty", "csv");
    return { ...result, mapping };
  });

  app.delete<{ Params: { id: string } }>("/contacts/:id", async (req, reply) => {
    // Droit à l'effacement : suppression du contact, l'adresse reste en liste de suppression pour ne plus être contactée.
    const [c] = await db.delete(contacts).where(and(eq(contacts.id, req.params.id), eq(contacts.orgId, req.orgId))).returning();
    if (!c) return reply.status(404).send({ error: "Contact introuvable" });
    await db.insert(suppressions).values({ orgId: req.orgId, emailNormalized: c.emailNormalized, reason: "manual" }).onConflictDoNothing();
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>("/contacts/:id/export", async (req, reply) => {
    // Droit d'accès RGPD : toutes les données et l'historique d'un contact.
    const [c] = await db.select().from(contacts).where(and(eq(contacts.id, req.params.id), eq(contacts.orgId, req.orgId)));
    if (!c) return reply.status(404).send({ error: "Contact introuvable" });
    const history = await db.execute(sql`select type, occurred_at, meta from events where contact_id = ${c.id} order by occurred_at`);
    return { contact: c, events: history.rows };
  });

  app.post("/segments", async (req, reply) => {
    const body = z.object({ name: z.string().min(1), rules: ruleSchema }).parse(req.body);
    segmentToSql(body.rules, []); // valide la compilation
    const [seg] = await db.insert(segments).values({ orgId: req.orgId, name: body.name, rules: body.rules }).returning();
    return reply.status(201).send(seg);
  });

  app.get("/segments", async (req) => db.select().from(segments).where(eq(segments.orgId, req.orgId)));

  app.get<{ Params: { id: string } }>("/segments/:id/contacts", async (req, reply) => {
    const [seg] = await db.select().from(segments).where(and(eq(segments.id, req.params.id), eq(segments.orgId, req.orgId)));
    if (!seg) return reply.status(404).send({ error: "Segment introuvable" });
    return { items: await segmentContactIds(db, req.orgId, seg.rules, 1000) };
  });
}

/** Contacts actifs d'un segment, via la compilation SQL paramétrée de @am/core. */
export async function segmentContactIds(db: Db, orgId: string, rules: SegmentRule, limit = 100_000): Promise<string[]> {
  const params: unknown[] = [orgId];
  const where = segmentToSql(rules, params);
  params.push(limit);
  const { rows } = await db.execute<{ id: string }>(
    paramSql(`select c.id from contacts c where c.org_id = $1 and c.status = 'active' and ${where} limit $${params.length}`, params),
  );
  return rows.map((r) => r.id);
}
