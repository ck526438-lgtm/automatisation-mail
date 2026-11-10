/**
 * Vérification de l'authentification d'un domaine d'envoi : SPF, DKIM, DMARC, MX.
 * Le résolveur est injectable pour les tests ; par défaut node:dns/promises.
 */
import { promises as nodeDns } from "node:dns";

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
}

export type CheckStatus = "ok" | "warning" | "missing" | "error";

export interface ProtocolResult {
  status: CheckStatus;
  record?: string;
  details: string[];
}

export interface DomainReport {
  domain: string;
  spf: ProtocolResult;
  dkim: ProtocolResult;
  dmarc: ProtocolResult;
  mx: ProtocolResult;
  /** true si les trois protocoles sont au moins « ok » ou « warning » */
  sendable: boolean;
  checkedAt: string;
}

const defaultResolver: DnsResolver = {
  resolveTxt: (n) => nodeDns.resolveTxt(n),
  resolveMx: (n) => nodeDns.resolveMx(n),
};

const LOOKUP_MECHANISMS = /^(?:[+\-~?])?(include|a|mx|ptr|exists|redirect)(?:[:=/]|$)/i;

async function txt(resolver: DnsResolver, name: string): Promise<string[]> {
  try {
    return (await resolver.resolveTxt(name)).map((parts) => parts.join(""));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw err;
  }
}

/** Compte récursivement les mécanismes SPF qui déclenchent une requête DNS (limite RFC 7208 : 10). */
async function countSpfLookups(resolver: DnsResolver, record: string, depth = 0, seen = new Set<string>()): Promise<number> {
  if (depth > 10) return 11;
  let count = 0;
  for (const term of record.split(/\s+/).slice(1)) {
    const m = term.match(LOOKUP_MECHANISMS);
    if (!m) continue;
    count++;
    const mech = m[1]!.toLowerCase();
    if (mech === "include" || mech === "redirect") {
      const target = term.split(/[:=]/)[1];
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const nested = (await txt(resolver, target)).find((r) => r.toLowerCase().startsWith("v=spf1"));
      if (nested) count += await countSpfLookups(resolver, nested, depth + 1, seen);
    }
  }
  return count;
}

export async function checkSpf(domain: string, resolver: DnsResolver = defaultResolver, expectedInclude?: string): Promise<ProtocolResult> {
  try {
    const records = (await txt(resolver, domain)).filter((r) => r.toLowerCase().startsWith("v=spf1"));
    if (records.length === 0) return { status: "missing", details: ["Aucun enregistrement SPF trouvé."] };
    if (records.length > 1) return { status: "error", record: records.join(" | "), details: ["Plusieurs enregistrements SPF : un seul est autorisé."] };
    const record = records[0]!;
    const details: string[] = [];
    let status: CheckStatus = "ok";
    const lookups = await countSpfLookups(resolver, record);
    if (lookups > 10) {
      status = "error";
      details.push(`${lookups} requêtes DNS : la limite de 10 est dépassée.`);
    } else details.push(`${lookups} requête(s) DNS sur 10 autorisées.`);
    if (/\s\+all\b/.test(record)) {
      status = "error";
      details.push("« +all » autorise n'importe quel serveur : à supprimer.");
    } else if (!/[~-]all\b/.test(record)) {
      if (status === "ok") status = "warning";
      details.push("Terminez par « ~all » ou « -all ».");
    }
    if (expectedInclude && !record.includes(`include:${expectedInclude}`)) {
      if (status === "ok") status = "warning";
      details.push(`Ajoutez « include:${expectedInclude} » pour votre fournisseur d'envoi.`);
    }
    return { status, record, details };
  } catch (err) {
    return { status: "error", details: [`Erreur DNS : ${(err as Error).message}`] };
  }
}

export async function checkDmarc(domain: string, resolver: DnsResolver = defaultResolver): Promise<ProtocolResult> {
  try {
    const record = (await txt(resolver, `_dmarc.${domain}`)).find((r) => r.toLowerCase().startsWith("v=dmarc1"));
    if (!record) return { status: "missing", details: ["Aucun enregistrement DMARC sur _dmarc." + domain] };
    const tags = parseTags(record);
    const details: string[] = [];
    let status: CheckStatus = "ok";
    const policy = tags.p?.toLowerCase();
    if (!policy || !["none", "quarantine", "reject"].includes(policy)) {
      return { status: "error", record, details: ["Balise « p= » absente ou invalide."] };
    }
    details.push(`Politique : ${policy}.`);
    if (policy === "none") {
      status = "warning";
      details.push("p=none surveille sans protéger : passez à quarantine puis reject une fois les rapports propres.");
    }
    if (!tags.rua) details.push("Ajoutez « rua=mailto:… » pour recevoir les rapports agrégés.");
    return { status, record, details };
  } catch (err) {
    return { status: "error", details: [`Erreur DNS : ${(err as Error).message}`] };
  }
}

export async function checkDkim(domain: string, selectors: string[], resolver: DnsResolver = defaultResolver): Promise<ProtocolResult> {
  try {
    for (const selector of selectors) {
      const record = (await txt(resolver, `${selector}._domainkey.${domain}`)).find((r) => /v=DKIM1|k=rsa|p=/i.test(r));
      if (!record) continue;
      const tags = parseTags(record);
      if (!tags.p) return { status: "error", record, details: [`Sélecteur « ${selector} » : clé publique révoquée (p= vide).`] };
      // Une clé RSA 2048 bits encodée en base64 fait environ 392 caractères ; 1024 bits environ 216.
      const keyLen = tags.p.replace(/\s/g, "").length;
      const weak = keyLen < 300;
      return {
        status: weak ? "warning" : "ok",
        record,
        details: [`Sélecteur « ${selector} » trouvé.`, weak ? "Clé probablement 1024 bits : passez à 2048 bits." : "Clé 2048 bits ou plus."],
      };
    }
    return { status: "missing", details: [`Aucune clé DKIM pour les sélecteurs : ${selectors.join(", ")}.`] };
  } catch (err) {
    return { status: "error", details: [`Erreur DNS : ${(err as Error).message}`] };
  }
}

export async function checkMx(domain: string, resolver: DnsResolver = defaultResolver): Promise<ProtocolResult> {
  try {
    const mx = await resolver.resolveMx(domain);
    if (mx.length === 0) return { status: "missing", details: ["Aucun MX : les réponses et rebonds ne pourront pas arriver."] };
    const sorted = [...mx].sort((a, b) => a.priority - b.priority);
    return { status: "ok", record: sorted.map((m) => `${m.priority} ${m.exchange}`).join(", "), details: [`${mx.length} serveur(s) MX.`] };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return { status: "missing", details: ["Aucun MX."] };
    return { status: "error", details: [`Erreur DNS : ${(err as Error).message}`] };
  }
}

/** Sélecteurs DKIM courants (Google Workspace, Microsoft 365, SES, Mailgun, génériques). */
export const COMMON_DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "k1", "mail", "dkim", "s1", "s2", "mx"];

export async function checkDomain(
  domain: string,
  options: { resolver?: DnsResolver; dkimSelectors?: string[]; spfInclude?: string } = {},
): Promise<DomainReport> {
  const resolver = options.resolver ?? defaultResolver;
  const d = domain.trim().toLowerCase();
  const [spf, dkim, dmarc, mx] = await Promise.all([
    checkSpf(d, resolver, options.spfInclude),
    checkDkim(d, options.dkimSelectors ?? COMMON_DKIM_SELECTORS, resolver),
    checkDmarc(d, resolver),
    checkMx(d, resolver),
  ]);
  const passing = (r: ProtocolResult) => r.status === "ok" || r.status === "warning";
  return { domain: d, spf, dkim, dmarc, mx, sendable: passing(spf) && passing(dkim) && passing(dmarc), checkedAt: new Date().toISOString() };
}

function parseTags(record: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of record.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}
