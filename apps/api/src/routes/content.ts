import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { contentSpamCheck, extractVariables, render, validateWorkflow, WorkflowValidationError, type WorkflowGraph } from "@am/core";
import { and, desc, eq, templates, workflows, workflowVersions } from "@am/db";
import type { AppDeps } from "../app.js";

const delay = z.object({ amount: z.number().nonnegative(), unit: z.enum(["minutes", "hours", "days"]) });
const condition = z.union([
  z.object({ kind: z.literal("event"), event: z.enum(["open", "click", "reply"]), ofNode: z.string().optional() }),
  z.object({ kind: z.literal("tag"), tag: z.string() }),
  z.object({ kind: z.literal("field"), field: z.string(), op: z.enum(["eq", "neq", "contains", "exists"]), value: z.string().optional() }),
]);
const node = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("start"), next: z.string() }),
  z.object({ id: z.string(), type: z.literal("email"), templateId: z.string(), threadWith: z.string().optional(), next: z.string() }),
  z.object({ id: z.string(), type: z.literal("wait"), delay, next: z.string() }),
  z.object({ id: z.string(), type: z.literal("condition"), condition, yes: z.string(), no: z.string() }),
  z.object({ id: z.string(), type: z.literal("wait_for_event"), event: z.enum(["open", "click", "reply"]), ofNode: z.string().optional(), timeout: delay, yes: z.string(), no: z.string() }),
  z.object({ id: z.string(), type: z.literal("action"), action: z.union([
    z.object({ kind: z.enum(["add_tag", "remove_tag"]), tag: z.string() }),
    z.object({ kind: z.literal("webhook"), url: z.string().url() }),
    z.object({ kind: z.literal("set_status"), status: z.string() }),
  ]), next: z.string() }),
  z.object({ id: z.string(), type: z.literal("end"), outcome: z.enum(["interested", "completed"]).optional() }),
]);
const graphSchema = z.object({ nodes: z.array(node).min(2) });

export function registerContentRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get("/templates", async (req) => db.select().from(templates).where(eq(templates.orgId, req.orgId)).orderBy(desc(templates.createdAt)));

  app.post("/templates", async (req, reply) => {
    const body = z.object({ name: z.string().min(1), subject: z.string().min(1), bodyText: z.string().min(1), bodyHtml: z.string().optional() }).parse(req.body);
    const [t] = await db.insert(templates).values({ orgId: req.orgId, ...body }).returning();
    return reply.status(201).send({ ...t, variables: extractVariables(`${body.subject} ${body.bodyText}`), spam: contentSpamCheck(body.subject, body.bodyHtml ?? body.bodyText) });
  });

  /** Aperçu d'un template avec des valeurs d'exemple, plus l'analyse anti-spam. */
  app.post("/templates/preview", async (req) => {
    const body = z.object({ subject: z.string(), bodyText: z.string(), vars: z.record(z.string()).default({}), seed: z.number().optional() }).parse(req.body);
    const subject = render(body.subject, body.vars, { seed: body.seed });
    const text = render(body.bodyText, body.vars, { seed: body.seed });
    return { subject: subject.output, bodyText: text.output, missing: [...new Set([...subject.missing, ...text.missing])], spam: contentSpamCheck(subject.output, text.output) };
  });

  app.get("/workflows", async (req) => db.select().from(workflows).where(eq(workflows.orgId, req.orgId)));

  app.get<{ Params: { id: string } }>("/workflows/:id", async (req, reply) => {
    const [wf] = await db.select().from(workflows).where(and(eq(workflows.id, req.params.id), eq(workflows.orgId, req.orgId)));
    if (!wf) return reply.status(404).send({ error: "Workflow introuvable" });
    const versions = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, wf.id)).orderBy(desc(workflowVersions.version));
    return { ...wf, versions };
  });

  app.post("/workflows", async (req, reply) => {
    const body = z.object({ name: z.string().min(1), graph: graphSchema }).parse(req.body);
    await assertValidGraph(body.graph as WorkflowGraph, req.orgId);
    const [wf] = await db.insert(workflows).values({ orgId: req.orgId, name: body.name }).returning();
    await db.insert(workflowVersions).values({ workflowId: wf!.id, version: 1, graph: body.graph as WorkflowGraph });
    return reply.status(201).send(wf);
  });

  /** Publie une nouvelle version : les contacts déjà inscrits restent sur la leur. */
  app.post<{ Params: { id: string } }>("/workflows/:id/versions", async (req, reply) => {
    const body = z.object({ graph: graphSchema }).parse(req.body);
    const [wf] = await db.select().from(workflows).where(and(eq(workflows.id, req.params.id), eq(workflows.orgId, req.orgId)));
    if (!wf) return reply.status(404).send({ error: "Workflow introuvable" });
    await assertValidGraph(body.graph as WorkflowGraph, req.orgId);
    const version = wf.currentVersion + 1;
    await db.insert(workflowVersions).values({ workflowId: wf.id, version, graph: body.graph as WorkflowGraph });
    await db.update(workflows).set({ currentVersion: version }).where(eq(workflows.id, wf.id));
    return reply.status(201).send({ ...wf, currentVersion: version });
  });

  async function assertValidGraph(graph: WorkflowGraph, orgId: string) {
    try {
      validateWorkflow(graph);
    } catch (e) {
      if (e instanceof WorkflowValidationError) throw Object.assign(new Error(e.message), { statusCode: 422 });
      throw e;
    }
    const ids = graph.nodes.flatMap((n) => (n.type === "email" ? [n.templateId] : []));
    const found = await db.select({ id: templates.id }).from(templates).where(eq(templates.orgId, orgId));
    const known = new Set(found.map((t) => t.id));
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) throw Object.assign(new Error(`Templates inconnus : ${unknown.join(", ")}`), { statusCode: 422 });
  }
}
