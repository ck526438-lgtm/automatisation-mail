/**
 * Jetons signés pour le tracking (ouverture, clic) et la désinscription,
 * réécriture des liens, en-têtes List-Unsubscribe (RFC 2369 / RFC 8058).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TrackingPayload {
  /** Identifiant du message envoyé */
  m: string;
  /** Type : o = ouverture, c = clic, u = désinscription */
  t: "o" | "c" | "u";
  /** URL cible pour un clic */
  u?: string;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

export function signToken(payload: TrackingPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", secret).update(body).digest()).slice(0, 22);
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TrackingPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = b64url(createHmac("sha256", secret).update(body).digest()).slice(0, 22);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TrackingPayload;
    if (!parsed.m || !["o", "c", "u"].includes(parsed.t)) return null;
    if (parsed.u && !/^https?:\/\//i.test(parsed.u)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface TrackingOptions {
  /** Domaine de tracking, ex. https://t.client.com */
  baseUrl: string;
  secret: string;
  messageId: string;
  trackOpens: boolean;
  trackClicks: boolean;
}

/** Réécrit les liens http(s) et ajoute le pixel d'ouverture si demandé. */
export function instrumentHtml(html: string, o: TrackingOptions): string {
  const base = o.baseUrl.replace(/\/$/, "");
  let out = html;
  if (o.trackClicks) {
    out = out.replace(/(<a\b[^>]*\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (full, pre: string, q: string, url: string) => {
      if (url.startsWith(base)) return full;
      const token = signToken({ m: o.messageId, t: "c", u: url }, o.secret);
      return `${pre}${q}${base}/c/${token}${q}`;
    });
  }
  if (o.trackOpens) {
    const pixel = `<img src="${base}/o/${signToken({ m: o.messageId, t: "o" }, o.secret)}.gif" width="1" height="1" alt="" style="display:none">`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${pixel}</body>`) : out + pixel;
  }
  return out;
}

export function unsubscribeUrl(baseUrl: string, messageId: string, secret: string): string {
  return `${baseUrl.replace(/\/$/, "")}/u/${signToken({ m: messageId, t: "u" }, secret)}`;
}

/** En-têtes obligatoires pour la désinscription en un clic (exigée par Gmail et Yahoo). */
export function unsubscribeHeaders(url: string, mailto?: string): Record<string, string> {
  const targets = [`<${url}>`];
  if (mailto) targets.push(`<mailto:${mailto}?subject=unsubscribe>`);
  return { "List-Unsubscribe": targets.join(", "), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/** Ajoute le lien de désinscription et l'adresse légale en pied de message. */
export function appendComplianceFooter(
  body: { html: string; text: string },
  opts: { unsubscribeUrl: string; senderName: string; postalAddress: string; style: "prospection" | "newsletter" },
): { html: string; text: string } {
  const line = opts.style === "prospection"
    ? "Si vous ne souhaitez plus recevoir de messages de ma part, répondez simplement ou cliquez ici"
    : "Se désinscrire";
  const htmlFooter = `<p style="font-size:12px;color:#777;margin-top:24px">${opts.senderName} · ${opts.postalAddress}<br><a href="${opts.unsubscribeUrl}">${line}</a></p>`;
  const textFooter = `\n\n--\n${opts.senderName} · ${opts.postalAddress}\n${line} : ${opts.unsubscribeUrl}`;
  const html = /<\/body>/i.test(body.html) ? body.html.replace(/<\/body>/i, `${htmlFooter}</body>`) : body.html + htmlFooter;
  return { html, text: body.text + textFooter };
}

/** Une ouverture survenue moins de 2 s après l'envoi ou venant d'un proxy d'images est jugée automatique. */
export function isLikelyBotOpen(sentAt: Date, openedAt: Date, userAgent = ""): boolean {
  if (openedAt.getTime() - sentAt.getTime() < 2000) return true;
  return /GoogleImageProxy|YahooMailProxy|Barracuda|Mimecast|ProofPoint|bot|crawler|preview/i.test(userAgent);
}

/** Un clic de scanner de sécurité arrive très vite et sans navigateur réel. */
export function isLikelyBotClick(sentAt: Date, clickedAt: Date, userAgent = ""): boolean {
  if (clickedAt.getTime() - sentAt.getTime() < 5000) return true;
  return /bot|crawler|spider|Barracuda|Mimecast|ProofPoint|SafeLinks|python-requests|curl|wget/i.test(userAgent);
}
