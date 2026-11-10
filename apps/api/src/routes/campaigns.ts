import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { startNodeId } from "@am/core";
import {
  and, campaignAccounts, campaigns, campaignStats, contacts, desc, enrollments, eq, inArray, segments,
  sendingAccounts, sql, workflows, workflowVersions,
} from "@am/db";
import type { AppDeps } from "../app.js";
import { segmentContactIds } from "./contacts.js";

const windowSchema = z.object({
  timezone: z.string(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(1).max(24),
  days: z.array(z.number().int().min(1).max(7)).min(1),
});

function notFound(what: string): Error {
  return Object.assign(new Error(`${what} introuvable`), { statusCode: 404 });
}

export function registerCampaignRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get("/campaigns", async (req) => {
    const rows = await db.select().from(campaigns).where(eq(campaigns.orgId, req.orgId)).orderBy(desc(campaigns.createdAt));
    const counts = await db.execute<{ campaign_id: string; state: string; n: string }>(sql`
      select campaign_id, state, count(*) as n from enrollments where org_id = ${req.orgId} group by campaign_id, state`);
    return rows.map((c) => ({
      ...c,
      enrollments: Object.fromEntries(counts.rows.filter((r) => r.campaign_id === c.id).map((r) => [r.state, Number(r.n)])),
    }));
  });

  app.post("/campaigns", async (req, reply) => {
    const body = z.object({
      name: z.string().min(1),
      type: z.enum(["cold", "nurture", "newsletter"]).default("cold"),
      workflowId: z.string().uuid(),
      sendingAccountIds: z.array(z.string().uuid()).min(1),
      sendWindow: windowSchema.optional(),
      trackOpens: z.boolean().optional(),
      trackClicks: z.boolean().optional(),
    }).parse(req.body);
    const [wf] = await db.select().from(workflows).where(and(eq(workflows.id, body.workflowId), eq(workflows.orgId, req.orgId)));
    if (!wf) throw notFound("Workflow");
    const accounts = await db.select({ id: sendingAccounts.id }).from(sendingAccounts)
      .where(and(eq(sendingAccounts.orgId, req.orgId), inArray(sendingAccounts.id, body.sendingAccountIds)));
    if (accounts.length !== body.sendingAccountIds.length) throw notFound("Compte d'envoi");
    const [c] = await db.insert(campaigns).values({
      orgId: req.orgId, name: body.name, type: body.type, workflowId: wf.id, sendWindow: body.sendWindow,
      // Le pixel d'ouverture nuit à la délivrabilité en prospection : désactivé par défaut pour « cold ».
      trackOpens: body.trackOpens ?? body.type !== "cold",
      trackClicks: body.trackClicks ?? true,
    }).returning();
    await db.insert(campaignAccounts).values(accounts.map((a) => ({ campaignId: c!.id, sendingAccountId: a.id })));
    return reply.status(201).send(c);
  });

  /** Inscrit des contacts : liste d'identifiants, segment, ou tous les contacts actifs. */
  app.post<{ Params: { id: string } }>("/campaigns/:id/enroll", async (req) => {
    const body = z.union([
      z.object({ contactIds: z.array(z.string().uuid()).min(1) }),
      z.object({ segmentId: z.string().uuid() }),
      z.object({ all: z.literal(true) }),
    ]).parse(req.body);
    const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, req.params.id), eq(campaigns.orgId, req.orgId)));
    if (!c) throw notFound("Campagne");
    const [wf] = await db.select().from(workflows).where(eq(workflows.id, c.workflowId));
    const [version] = await db.select().from(workflowVersions)
      .where(and(eq(workflowVersions.workflowId, c.workflowId), eq(workflowVersions.version, wf!.currentVersion)));
    if (!version) throw notFound("Version de workflow");

    let ids: string[];
    if ("contactIds" in body) {
      const rows = await db.select({ id: contacts.id }).from(contacts)
        .where(and(eq(contacts.orgId, req.orgId), eq(contacts.status, "active"), inArray(contacts.id, body.contactIds)));
      ids = rows.map((r) => r.id);
    } else if ("segmentId" in body) {
      const [seg] = await db.select().from(segments).where(and(eq(segments.id, body.segmentId), eq(segments.orgId, req.orgId)));
      if (!seg) throw notFound("Segment");
      ids = await segmentContactIds(db, req.orgId, seg.rules);
    } else {
      ids = (await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.orgId, req.orgId), eq(contacts.status, "active")))).map((r) => r.id);
    }

    const start = startNodeId(version.graph);
    let enrolled = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const out = await db.insert(enrollments).values(ids.slice(i, i + 1000).map((contactId) => ({
        orgId: req.orgId, campaignId: c.id, workflowVersionId: version.id, contactId, currentNodeId: start,
        state: "active" as const, nextRunAt: c.status === "running" ? new Date() : null,
      }))).onConflictDoNothing().returning({ id: enrollments.id });
      enrolled += out.length;
    }
    return { enrolled, alreadyEnrolled: ids.length - enrolled };
  });

  app.post<{ Params: { id: string } }>("/campaigns/:id/start", async (req) => {
    const [c] = await db.update(campaigns).set({ status: "running", pauseReason: null })
      .where(and(eq(campaigns.id, req.params.id), eq(campaigns.orgId, req.orgId))).returning();
    if (!c) throw notFound("Campagne");
    // Les inscriptions en attente de démarrage deviennent dues immédiatement.
    await db.update(enrollments).set({ nextRunAt: new Date() })
      .where(and(eq(enrollments.campaignId, c.id), sql`${enrollments.state} in ('active','waiting')`, sql`${enrollments.nextRunAt} is null`));
    return c;
  });

  app.post<{ Params: { id: string } }>("/campaigns/:id/pause", async (req) => {
    const [c] = await db.update(campaigns).set({ status: "paused", pauseReason: "Pause manuelle" })
      .where(and(eq(campaigns.id, req.params.id), eq(campaigns.orgId, req.orgId))).returning();
    if (!c) throw notFound("Campagne");
    return c;
  });

  app.get<{ Params: { id: string } }>("/campaigns/:id/stats", async (req) => {
    const [c] = await db.select().from(campaigns).where(and(eq(campaigns.id, req.params.id), eq(campaigns.orgId, req.orgId)));
    if (!c) throw notFound("Campagne");
    const stats = await campaignStats(db, c.id);
    const perStep = await db.execute<{ node_id: string; type: string; n: string }>(sql`
      select node_id, type, count(distinct contact_id) as n from events
      where campaign_id = ${c.id} and not is_bot and node_id is not null group by node_id, type order by node_id`);
    return { campaign: c, ...stats, perStep: perStep.rows.map((r) => ({ nodeId: r.node_id, type: r.type, contacts: Number(r.n) })) };
  });

  app.get("/dashboard", async (req) => {
    const r = await db.execute<Record<string, string>>(sql`
      select
        (select count(*) from contacts where org_id = ${req.orgId}) as contacts,
        (select count(*) from contacts where org_id = ${req.orgId} and status = 'active') as active_contacts,
        (select count(*) from campaigns where org_id = ${req.orgId} and status = 'running') as running_campaigns,
        (select count(*) from events where org_id = ${req.orgId} and type = 'sent' and occurred_at > now() - interval '30 days') as sent_30d,
        (select count(distinct contact_id) from events where org_id = ${req.orgId} and type = 'reply' and occurred_at > now() - interval '30 days') as replies_30d,
        (select count(*) from events where org_id = ${req.orgId} and type = 'bounce' and occurred_at > now() - interval '30 days') as bounces_30d`);
    const row = r.rows[0] ?? {};
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  });
}
