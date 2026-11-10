/**
 * Rendu des templates : variables {{prenom}}, valeurs de repli {{prenom|là}},
 * et spintax {Bonjour|Salut|Hello} pour varier les envois.
 */

export type TemplateVars = Record<string, string | number | null | undefined>;

/** Générateur pseudo-aléatoire déterministe (mulberry32) : même graine = même variante. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Résout le spintax, y compris imbriqué : {a|{b|c}}. */
export function spin(text: string, seed = 1): string {
  const next = rng(seed);
  let out = text;
  const innermost = /\{([^{}]*\|[^{}]*)\}/;
  let guard = 0;
  while (innermost.test(out) && guard++ < 1000) {
    out = out.replace(innermost, (_, body: string) => {
      const options = body.split("|");
      return options[Math.floor(next() * options.length)] ?? "";
    });
  }
  return out;
}

const VAR_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** Liste des variables utilisées par un template (pour l'aperçu et la validation à l'import). */
export function extractVariables(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) found.add(m[1]!);
  return [...found];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export interface RenderOptions {
  /** Échappe les valeurs pour un rendu HTML. */
  html?: boolean;
  /** Graine du spintax ; par défaut fixe pour un même destinataire. */
  seed?: number;
}

export interface RenderResult {
  output: string;
  missing: string[];
}

export function render(template: string, vars: TemplateVars, opts: RenderOptions = {}): RenderResult {
  const missing: string[] = [];
  // Les variables d'abord, pour qu'une valeur contenant « | » ne soit pas lue comme du spintax.
  const placeholders: string[] = [];
  const withVars = template.replace(VAR_RE, (_, name: string, fallback?: string) => {
    const raw = name.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), vars);
    let value = raw === null || raw === undefined || raw === "" ? undefined : String(raw);
    if (value === undefined) {
      if (fallback === undefined) missing.push(name);
      value = fallback ?? "";
    }
    placeholders.push(opts.html ? escapeHtml(value) : value);
    return `\u0000${placeholders.length - 1}\u0000`;
  });
  const spun = spin(withVars, opts.seed ?? 1);
  const output = spun.replace(/\u0000(\d+)\u0000/g, (_, i: string) => placeholders[Number(i)] ?? "");
  return { output, missing };
}

/** Convertit un texte brut en HTML minimal (paragraphes et retours à la ligne). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
