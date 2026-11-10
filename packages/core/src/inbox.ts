/**
 * Analyse des messages reçus dans une boîte d'envoi : réponses, réponses automatiques et rebonds (DSN).
 * Indépendant du fournisseur : Gmail, Microsoft Graph et IMAP fournissent tous des en-têtes et un texte.
 */
import type { BounceInput } from "./bounce.js";

export interface InboundMessage {
  /** En-têtes du message, noms insensibles à la casse */
  headers: Record<string, string | undefined>;
  from: string;
  subject: string;
  /** Texte brut (corps, ou corps + parties message/delivery-status pour un DSN) */
  text: string;
}

export type InboundVerdict =
  | { kind: "reply"; refs: string[]; autoReply: boolean }
  | { kind: "bounce"; originalMessageId: string | null; recipient: string | null; bounce: BounceInput }
  | { kind: "ignore"; reason: string };

function header(m: InboundMessage, name: string): string {
  const key = Object.keys(m.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return (key ? m.headers[key] : undefined) ?? "";
}

/** Extrait les identifiants de message de In-Reply-To et References, sans chevrons, du plus récent au plus ancien. */
export function extractRefs(m: InboundMessage): string[] {
  const ids = (s: string) => [...s.matchAll(/<([^<>\s]+)>/g)].map((x) => x[1]!);
  const inReplyTo = ids(header(m, "in-reply-to"));
  const references = ids(header(m, "references")).reverse();
  return [...new Set([...inReplyTo, ...references])];
}

const BOUNCE_SENDER = /^(mailer-daemon|postmaster|mail delivery (subsystem|system)|microsoftexchange[0-9a-f]*)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery (status notification|has failed|failure)|returned mail|non remis|non distribuable|échec de (la )?remise|mail delivery failed|failure notice)/i;

export function isBounceMessage(m: InboundMessage): boolean {
  const from = m.from.replace(/^.*<|>.*$/g, "").split("@")[0] ?? m.from;
  const contentType = header(m, "content-type");
  return /multipart\/report.*delivery-status/i.test(contentType) || BOUNCE_SENDER.test(from) || BOUNCE_SENDER.test(m.from) || BOUNCE_SUBJECT.test(m.subject);
}

export function isAutoReplyMessage(m: InboundMessage): boolean {
  const auto = header(m, "auto-submitted").toLowerCase();
  if (auto && auto !== "no") return true;
  if (header(m, "x-autoreply") || header(m, "x-autorespond") || /auto_reply/i.test(header(m, "precedence"))) return true;
  return /^(absence|out of office|automatic reply|réponse automatique|auto[- ]?reply|en congé|absent)/i.test(m.subject.trim());
}

/**
 * Lit un rapport de non-remise (RFC 3464) ou un rebond « texte libre » :
 * identifiant du message d'origine, destinataire, code SMTP, code étendu et diagnostic.
 */
export function parseDsn(m: InboundMessage): { originalMessageId: string | null; recipient: string | null; bounce: BounceInput } {
  const t = m.text;
  const original = t.match(/^\s*Message-ID:\s*<([^<>\s]+)>/im)?.[1]
    ?? extractRefs(m)[0]
    ?? null;
  const recipient = t.match(/^\s*Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/im)?.[1]
    ?? t.match(/^\s*Original-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/im)?.[1]
    ?? t.match(/<([^<>\s@]+@[^<>\s]+)>[:\s]/)?.[1]
    ?? null;
  const enhanced = t.match(/^\s*Status:\s*([245]\.\d{1,3}\.\d{1,3})/im)?.[1] ?? t.match(/\b([45]\.\d{1,3}\.\d{1,3})\b/)?.[1];
  const diagnostic = t.match(/^\s*Diagnostic-Code:\s*(?:smtp;\s*)?(.+(?:\n[ \t]+.+)*)/im)?.[1]?.replace(/\s+/g, " ").trim();
  const codeText = diagnostic ?? t;
  const code = Number(codeText.match(/\b([45]\d\d)\b/)?.[1]) || undefined;
  const message = diagnostic ?? t.split(/\n/).map((l) => l.trim()).filter((l) => /\b[45]\d\d\b|\b[45]\.\d+\.\d+\b|user unknown|n'existe pas|does not exist|mailbox/i.test(l)).slice(0, 3).join(" ");
  return { originalMessageId: original, recipient: recipient?.toLowerCase() ?? null, bounce: { code, enhanced, message: message || m.subject } };
}

/** Classe un message entrant pour le moteur : réponse (humaine ou automatique), rebond ou à ignorer. */
export function classifyInbound(m: InboundMessage, ownAddress?: string): InboundVerdict {
  if (ownAddress && m.from.toLowerCase().includes(ownAddress.toLowerCase())) return { kind: "ignore", reason: "message envoyé par la boîte elle-même" };
  if (isBounceMessage(m)) {
    const dsn = parseDsn(m);
    return { kind: "bounce", ...dsn };
  }
  const refs = extractRefs(m);
  if (refs.length === 0) return { kind: "ignore", reason: "aucune référence à un message envoyé" };
  return { kind: "reply", refs, autoReply: isAutoReplyMessage(m) };
}
