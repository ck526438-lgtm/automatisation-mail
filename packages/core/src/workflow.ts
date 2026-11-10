/**
 * Moteur de workflow : une séquence est un graphe orienté acyclique de nœuds.
 * Chaque contact inscrit (enrollment) pointe vers son nœud courant.
 * `advance()` est une fonction pure : elle reçoit l'état et l'historique d'événements,
 * et renvoie les effets à exécuter et le nouvel état. Les workers appliquent les effets.
 */

export type EventType = "sent" | "delivered" | "open" | "click" | "reply" | "bounce" | "complaint" | "unsubscribe" | "auto_reply";

export interface WorkflowEvent {
  type: EventType;
  /** Nœud d'envoi qui a produit le message concerné (pour « si ouvert l'e-mail X ») */
  nodeId?: string;
  bounceKind?: "hard" | "soft" | "block";
  occurredAt: string;
}

export interface DelaySpec {
  amount: number;
  unit: "minutes" | "hours" | "days";
}

export type Condition =
  | { kind: "event"; event: "open" | "click" | "reply"; ofNode?: string }
  | { kind: "tag"; tag: string }
  | { kind: "field"; field: string; op: "eq" | "neq" | "contains" | "exists"; value?: string };

export type WorkflowNode =
  | { id: string; type: "start"; next: string }
  | { id: string; type: "email"; templateId: string; threadWith?: string; next: string }
  | { id: string; type: "wait"; delay: DelaySpec; next: string }
  | { id: string; type: "condition"; condition: Condition; yes: string; no: string }
  | { id: string; type: "wait_for_event"; event: "open" | "click" | "reply"; ofNode?: string; timeout: DelaySpec; yes: string; no: string }
  | { id: string; type: "action"; action: { kind: "add_tag" | "remove_tag"; tag: string } | { kind: "webhook"; url: string } | { kind: "set_status"; status: string }; next: string }
  | { id: string; type: "end"; outcome?: "interested" | "completed" };

export interface WorkflowGraph {
  nodes: WorkflowNode[];
}

export interface ContactSnapshot {
  tags: string[];
  fields: Record<string, unknown>;
}

export type EnrollmentState = "active" | "waiting" | "completed" | "stopped";

export interface EnrollmentSnapshot {
  currentNodeId: string;
  state: EnrollmentState;
  /** Moment où l'enrollment est arrivé sur le nœud courant */
  enteredNodeAt: string;
}

export type Effect =
  | { kind: "send_email"; nodeId: string; templateId: string; threadWith?: string }
  | { kind: "add_tag"; tag: string }
  | { kind: "remove_tag"; tag: string }
  | { kind: "webhook"; url: string }
  | { kind: "set_status"; status: string };

export interface AdvanceResult {
  state: EnrollmentState;
  currentNodeId: string;
  enteredNodeAt: string;
  /** Prochaine évaluation, null si terminé ou en attente d'un envoi confirmé */
  nextRunAt: string | null;
  effects: Effect[];
  stopReason?: string;
  /** Chemin parcouru pendant cet appel (débogage, journal) */
  path: string[];
}

export class WorkflowValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Workflow invalide : ${issues.join(" ; ")}`);
  }
}

export function delayMs(d: DelaySpec): number {
  const unit = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }[d.unit];
  return Math.max(0, d.amount) * unit;
}

function successors(n: WorkflowNode): string[] {
  switch (n.type) {
    case "end":
      return [];
    case "condition":
    case "wait_for_event":
      return [n.yes, n.no];
    default:
      return [n.next];
  }
}

/** Valide le graphe : un seul départ, références existantes, aucun cycle, tous les nœuds atteignables. */
export function validateWorkflow(graph: WorkflowGraph): void {
  const issues: string[] = [];
  const byId = new Map<string, WorkflowNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) issues.push(`identifiant dupliqué « ${n.id} »`);
    byId.set(n.id, n);
  }
  const starts = graph.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) issues.push(`il faut exactement un nœud de départ (trouvé : ${starts.length})`);
  for (const n of graph.nodes) {
    for (const s of successors(n)) if (!byId.has(s)) issues.push(`« ${n.id} » pointe vers « ${s} » qui n'existe pas`);
    if (n.type === "email" && n.threadWith && byId.get(n.threadWith)?.type !== "email") {
      issues.push(`« ${n.id} » répond au fil d'un nœud qui n'est pas un e-mail`);
    }
  }
  if (issues.length === 0 && starts[0]) {
    const color = new Map<string, 0 | 1 | 2>();
    const visit = (id: string): void => {
      color.set(id, 1);
      for (const s of successors(byId.get(id)!)) {
        const c = color.get(s) ?? 0;
        if (c === 1) issues.push(`cycle détecté via « ${id} » → « ${s} »`);
        else if (c === 0) visit(s);
      }
      color.set(id, 2);
    };
    visit(starts[0].id);
    for (const n of graph.nodes) if (!color.has(n.id)) issues.push(`nœud « ${n.id} » inatteignable`);
  }
  if (issues.length) throw new WorkflowValidationError([...new Set(issues)]);
}

export function startNodeId(graph: WorkflowGraph): string {
  const start = graph.nodes.find((n) => n.type === "start");
  if (!start) throw new WorkflowValidationError(["aucun nœud de départ"]);
  return start.id;
}

/** Règles d'arrêt globales, prioritaires sur le graphe. */
export function globalStopReason(events: WorkflowEvent[]): string | undefined {
  for (const e of events) {
    if (e.type === "reply") return "reply";
    if (e.type === "unsubscribe") return "unsubscribed";
    if (e.type === "complaint") return "complaint";
    if (e.type === "bounce" && e.bounceKind !== "soft") return "bounced";
  }
  return undefined;
}

function matchesEvent(events: WorkflowEvent[], type: string, ofNode: string | undefined, since?: number): boolean {
  return events.some((e) => e.type === type && (!ofNode || e.nodeId === ofNode) && (since === undefined || Date.parse(e.occurredAt) >= since));
}

function evaluate(cond: Condition, contact: ContactSnapshot, events: WorkflowEvent[]): boolean {
  switch (cond.kind) {
    case "event":
      return matchesEvent(events, cond.event, cond.ofNode);
    case "tag":
      return contact.tags.includes(cond.tag);
    case "field": {
      const v = contact.fields[cond.field];
      const s = v === undefined || v === null ? "" : String(v);
      if (cond.op === "exists") return s !== "";
      if (cond.op === "eq") return s.toLowerCase() === (cond.value ?? "").toLowerCase();
      if (cond.op === "neq") return s.toLowerCase() !== (cond.value ?? "").toLowerCase();
      return s.toLowerCase().includes((cond.value ?? "").toLowerCase());
    }
  }
}

/**
 * Fait avancer un enrollment autant que possible à l'instant `now`.
 * S'arrête sur un envoi (un seul e-mail par appel, pour respecter quotas et espacement),
 * sur une attente non écoulée, ou sur une fin.
 */
export function advance(
  graph: WorkflowGraph,
  enrollment: EnrollmentSnapshot,
  contact: ContactSnapshot,
  events: WorkflowEvent[],
  now: Date = new Date(),
): AdvanceResult {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const effects: Effect[] = [];
  const path: string[] = [];
  let currentId = enrollment.currentNodeId;
  let enteredAt = enrollment.enteredNodeAt;

  const done = (state: EnrollmentState, nextRunAt: string | null, stopReason?: string): AdvanceResult => ({
    state, currentNodeId: currentId, enteredNodeAt: enteredAt, nextRunAt, effects, stopReason, path,
  });

  if (enrollment.state === "completed" || enrollment.state === "stopped") return done(enrollment.state, null);
  const stop = globalStopReason(events);
  if (stop) return done("stopped", null, stop);

  const move = (to: string) => {
    currentId = to;
    enteredAt = nowIso;
  };

  for (let guard = 0; guard < graph.nodes.length + 1; guard++) {
    const node = byId.get(currentId);
    if (!node) return done("stopped", null, `nœud introuvable « ${currentId} »`);
    path.push(node.id);
    switch (node.type) {
      case "start":
        move(node.next);
        continue;
      case "email": {
        effects.push({ kind: "send_email", nodeId: node.id, templateId: node.templateId, threadWith: node.threadWith });
        move(node.next);
        // On rend la main : le worker d'envoi planifiera la suite après l'envoi.
        return done("active", nowIso);
      }
      case "wait": {
        const dueAt = Date.parse(enteredAt) + delayMs(node.delay);
        if (nowMs < dueAt) return done("waiting", new Date(dueAt).toISOString());
        move(node.next);
        continue;
      }
      case "condition":
        move(evaluate(node.condition, contact, events) ? node.yes : node.no);
        continue;
      case "wait_for_event": {
        const entered = Date.parse(enteredAt);
        if (matchesEvent(events, node.event, node.ofNode, entered)) {
          move(node.yes);
          continue;
        }
        const timeoutAt = entered + delayMs(node.timeout);
        if (nowMs < timeoutAt) return done("waiting", new Date(timeoutAt).toISOString());
        move(node.no);
        continue;
      }
      case "action":
        effects.push(node.action.kind === "webhook" ? { kind: "webhook", url: node.action.url }
          : node.action.kind === "set_status" ? { kind: "set_status", status: node.action.status }
          : { kind: node.action.kind, tag: node.action.tag });
        move(node.next);
        continue;
      case "end":
        return done("completed", null, node.outcome);
    }
  }
  return done("stopped", null, "boucle détectée");
}

/** Séquence de prospection classique en 3 e-mails, utile comme modèle de départ. */
export function threeStepColdSequence(templates: [string, string, string]): WorkflowGraph {
  return {
    nodes: [
      { id: "start", type: "start", next: "email1" },
      { id: "email1", type: "email", templateId: templates[0], next: "wait1" },
      { id: "wait1", type: "wait", delay: { amount: 3, unit: "days" }, next: "clicked" },
      { id: "clicked", type: "condition", condition: { kind: "event", event: "click", ofNode: "email1" }, yes: "tag_hot", no: "email2" },
      { id: "tag_hot", type: "action", action: { kind: "add_tag", tag: "chaud" }, next: "email2" },
      { id: "email2", type: "email", templateId: templates[1], threadWith: "email1", next: "wait2" },
      { id: "wait2", type: "wait", delay: { amount: 4, unit: "days" }, next: "email3" },
      { id: "email3", type: "email", templateId: templates[2], threadWith: "email1", next: "end" },
      { id: "end", type: "end", outcome: "completed" },
    ],
  };
}
