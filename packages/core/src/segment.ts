/**
 * Segmentation dynamique : un arbre de règles ET/OU évalué sur un contact.
 * Le même arbre est compilé en SQL paramétré côté API (voir apps/api).
 */

export type FieldOp = "eq" | "neq" | "contains" | "not_contains" | "starts_with" | "exists" | "not_exists" | "gt" | "lt";

export type SegmentRule =
  | { all: SegmentRule[] }
  | { any: SegmentRule[] }
  | { not: SegmentRule }
  | { field: string; op: FieldOp; value?: string | number }
  | { tag: string; has: boolean }
  | { activity: "open" | "click" | "reply"; withinDays: number; has: boolean };

export interface SegmentContact {
  fields: Record<string, unknown>;
  tags: string[];
  /** Dernière date (ISO) de chaque type d'activité */
  lastActivity: Partial<Record<"open" | "click" | "reply", string>>;
}

export function matchesSegment(rule: SegmentRule, c: SegmentContact, now: Date = new Date()): boolean {
  if ("all" in rule) return rule.all.every((r) => matchesSegment(r, c, now));
  if ("any" in rule) return rule.any.some((r) => matchesSegment(r, c, now));
  if ("not" in rule) return !matchesSegment(rule.not, c, now);
  if ("tag" in rule) return c.tags.includes(rule.tag) === rule.has;
  if ("activity" in rule) {
    const last = c.lastActivity[rule.activity];
    const recent = last !== undefined && now.getTime() - Date.parse(last) <= rule.withinDays * 86_400_000;
    return recent === rule.has;
  }
  const raw = c.fields[rule.field];
  const present = raw !== undefined && raw !== null && raw !== "";
  const s = present ? String(raw).toLowerCase() : "";
  const v = rule.value === undefined ? "" : String(rule.value).toLowerCase();
  switch (rule.op) {
    case "exists": return present;
    case "not_exists": return !present;
    case "eq": return s === v;
    case "neq": return s !== v;
    case "contains": return s.includes(v);
    case "not_contains": return !s.includes(v);
    case "starts_with": return s.startsWith(v);
    case "gt": return present && Number(raw) > Number(rule.value);
    case "lt": return present && Number(raw) < Number(rule.value);
  }
}

const STANDARD_FIELDS: Record<string, string> = {
  email: "email", first_name: "first_name", last_name: "last_name", company: "company", title: "title", country: "country",
};

/**
 * Compile une règle en clause SQL PostgreSQL paramétrée.
 * Les champs inconnus sont lus dans la colonne JSONB `custom_fields`.
 * `params` est complété en place ; les placeholders sont $1, $2…
 */
export function segmentToSql(rule: SegmentRule, params: unknown[], alias = "c"): string {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if ("all" in rule) return rule.all.length ? `(${rule.all.map((r) => segmentToSql(r, params, alias)).join(" AND ")})` : "TRUE";
  if ("any" in rule) return rule.any.length ? `(${rule.any.map((r) => segmentToSql(r, params, alias)).join(" OR ")})` : "FALSE";
  if ("not" in rule) return `NOT ${segmentToSql(rule.not, params, alias)}`;
  if ("tag" in rule) {
    const sub = `EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ${alias}.id AND t.name = ${p(rule.tag)})`;
    return rule.has ? sub : `NOT ${sub}`;
  }
  if ("activity" in rule) {
    const sub = `EXISTS (SELECT 1 FROM events e WHERE e.contact_id = ${alias}.id AND e.type = ${p(rule.activity)} AND e.occurred_at >= now() - make_interval(days => ${p(rule.withinDays)}::int))`;
    return rule.has ? sub : `NOT ${sub}`;
  }
  if (!/^[a-zA-Z_][\w]*$/.test(rule.field)) throw new Error(`Nom de champ invalide : ${rule.field}`);
  const col = STANDARD_FIELDS[rule.field] ? `${alias}.${STANDARD_FIELDS[rule.field]}` : `(${alias}.custom_fields ->> ${p(rule.field)}::text)`;
  const lower = `lower(coalesce(${col}, ''))`;
  const v = rule.value === undefined ? "" : String(rule.value).toLowerCase();
  switch (rule.op) {
    case "exists": return `coalesce(${col}, '') <> ''`;
    case "not_exists": return `coalesce(${col}, '') = ''`;
    case "eq": return `${lower} = ${p(v)}`;
    case "neq": return `${lower} <> ${p(v)}`;
    case "contains": return `${lower} LIKE '%' || ${p(v)}::text || '%'`;
    case "not_contains": return `${lower} NOT LIKE '%' || ${p(v)}::text || '%'`;
    case "starts_with": return `${lower} LIKE ${p(v)}::text || '%'`;
    case "gt": return `(${col})::numeric > ${p(Number(rule.value))}::numeric`;
    case "lt": return `(${col})::numeric < ${p(Number(rule.value))}::numeric`;
  }
}
