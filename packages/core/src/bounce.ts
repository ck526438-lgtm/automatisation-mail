/**
 * Classification des rebonds (DSN / réponses SMTP).
 *  - hard  : adresse définitivement invalide → suppression
 *  - soft  : problème temporaire → nouvelles tentatives
 *  - block : refus lié à la réputation / au contenu → alerte délivrabilité
 */

export type BounceKind = "hard" | "soft" | "block";

export interface BounceInput {
  /** Code SMTP de base, ex. 550 */
  code?: number;
  /** Code étendu RFC 3463, ex. "5.1.1" */
  enhanced?: string;
  /** Texte du diagnostic renvoyé par le serveur distant */
  message?: string;
}

export interface BounceVerdict {
  kind: BounceKind;
  reason: string;
}

const BLOCK_PATTERNS = [
  /spamhaus|barracuda|spamcop|blacklist|blocklist|block list|black list/i,
  /reputation|poor reputation|rejected due to policy|policy reasons/i,
  /spam|junk|unsolicited/i,
  /dmarc|spf.*fail|dkim.*fail|not authenticated|unauthenticated/i,
];

const HARD_PATTERNS = [
  /user unknown|unknown user|no such user|does not exist|doesn't exist|not found/i,
  /mailbox unavailable|invalid recipient|recipient rejected|address rejected|no mailbox/i,
  /account (has been )?disabled|account inactive|n'existe pas|adresse inconnue/i,
];

const SOFT_PATTERNS = [
  /mailbox (is )?full|quota|over quota|insufficient storage|boîte pleine/i,
  /try again later|temporar|greylist|deferred|rate limit|too many/i,
];

export function classifyBounce(input: BounceInput): BounceVerdict {
  const msg = input.message ?? "";
  const enhanced = input.enhanced ?? extractEnhanced(msg);
  const code = input.code ?? extractCode(msg);

  if (BLOCK_PATTERNS.some((re) => re.test(msg)) || enhanced === "5.7.1" || enhanced?.startsWith("5.7.")) {
    return { kind: "block", reason: "refus de réputation, d'authentification ou de politique" };
  }
  if (enhanced) {
    const [cls, subject, detail] = enhanced.split(".").map(Number);
    if (cls === 4) return { kind: "soft", reason: `erreur temporaire ${enhanced}` };
    if (cls === 5) {
      if (subject === 2 && detail === 2) return { kind: "soft", reason: "boîte pleine (5.2.2)" };
      if (subject === 1 || subject === 2) return { kind: "hard", reason: `adresse invalide ${enhanced}` };
    }
  }
  if (SOFT_PATTERNS.some((re) => re.test(msg))) return { kind: "soft", reason: "problème temporaire" };
  if (HARD_PATTERNS.some((re) => re.test(msg))) return { kind: "hard", reason: "adresse inexistante" };
  if (code !== undefined) {
    if (code >= 400 && code < 500) return { kind: "soft", reason: `code SMTP ${code}` };
    if (code >= 500) return { kind: "hard", reason: `code SMTP ${code}` };
  }
  return { kind: "soft", reason: "rebond non classé, traité comme temporaire" };
}

function extractEnhanced(msg: string): string | undefined {
  return msg.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/)?.[0];
}

function extractCode(msg: string): number | undefined {
  const m = msg.match(/\b([45]\d\d)\b/);
  return m ? Number(m[1]) : undefined;
}

/** Délais de nouvelle tentative pour un soft bounce : 1 h, 6 h, 24 h. */
export const SOFT_BOUNCE_RETRY_DELAYS_MS = [3_600_000, 21_600_000, 86_400_000] as const;

/** Renvoie le délai avant la prochaine tentative, ou null s'il faut traiter comme hard. */
export function nextSoftBounceRetry(attempt: number): number | null {
  return SOFT_BOUNCE_RETRY_DELAYS_MS[attempt] ?? null;
}
