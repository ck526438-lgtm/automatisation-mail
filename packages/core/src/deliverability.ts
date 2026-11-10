/**
 * Warm-up, score de santé et garde-fous de campagne.
 * Les paliers sont des valeurs de départ prudentes, à calibrer avec les résultats réels.
 */

export interface WarmupDay {
  /** E-mails de warm-up à échanger ce jour-là */
  warmup: number;
  /** Plafond d'e-mails de campagne autorisés ce jour-là */
  campaign: number;
}

/**
 * Plan pour le jour `day` (0 = jour de connexion de la boîte).
 * Semaine 1 : warm-up seul, 5 → 15 ; semaine 2 : 15 → 30 et jusqu'à 10 envois ;
 * semaine 3 : 30 → 40 et jusqu'à 30 ; ensuite maintien à 40 et plafond de la boîte.
 */
export function warmupPlan(day: number, mailboxDailyLimit = 50): WarmupDay {
  const d = Math.max(0, Math.floor(day));
  const lerp = (a: number, b: number, i: number, span: number) => Math.round(a + ((b - a) * i) / span);
  if (d < 7) return { warmup: lerp(5, 15, d, 6), campaign: 0 };
  if (d < 14) return { warmup: lerp(15, 30, d - 7, 6), campaign: Math.min(mailboxDailyLimit, lerp(0, 10, d - 7, 6)) };
  if (d < 21) return { warmup: lerp(30, 40, d - 14, 6), campaign: Math.min(mailboxDailyLimit, lerp(10, 30, d - 14, 6)) };
  return { warmup: 40, campaign: mailboxDailyLimit };
}

export interface HealthInputs {
  /** Part des e-mails de test arrivés en boîte de réception, 0–1 (null si pas encore mesuré) */
  inboxRate: number | null;
  /** Taux de rebonds sur 7 jours, 0–1 */
  bounceRate: number;
  /** Taux de plaintes sur 30 jours, 0–1 */
  complaintRate: number;
  /** Nombre de listes noires où le domaine ou l'IP apparaît */
  blacklistHits: number;
  /** SPF, DKIM et DMARC tous valides */
  dnsOk: boolean;
}

/** Score de santé de 0 à 100 d'une boîte d'envoi. */
export function healthScore(h: HealthInputs): number {
  let score = 100;
  if (h.inboxRate !== null) score -= Math.round((1 - Math.min(1, Math.max(0, h.inboxRate))) * 50);
  score -= Math.min(30, Math.round(h.bounceRate * 600)); // 5 % de rebonds = -30
  score -= Math.min(40, Math.round(h.complaintRate * 10_000)); // 0,3 % de plaintes = -30
  score -= Math.min(40, h.blacklistHits * 20);
  if (!h.dnsOk) score -= 25;
  return Math.max(0, Math.min(100, score));
}

/**
 * Volume de campagne autorisé aujourd'hui, compte tenu du warm-up et du score.
 * Sous 70 : moitié du volume ; sous 50 : envois suspendus.
 */
export function allowedCampaignVolume(day: number, mailboxDailyLimit: number, score: number): number {
  const base = warmupPlan(day, mailboxDailyLimit).campaign;
  if (score < 50) return 0;
  if (score < 70) return Math.floor(base / 2);
  return base;
}

export interface CampaignStats {
  sent: number;
  bounced: number;
  complaints: number;
}

export const LIMITS = {
  /** Au-delà : pause automatique de la campagne */
  bounceRate: 0.05,
  /** Seuil indiqué par Gmail et Yahoo pour les expéditeurs en volume */
  complaintRate: 0.003,
  /** Nombre minimal d'envois avant d'appliquer les seuils */
  minSample: 50,
} as const;

export function shouldPauseCampaign(s: CampaignStats): { pause: boolean; reason?: string } {
  if (s.sent < LIMITS.minSample) return { pause: false };
  if (s.bounced / s.sent > LIMITS.bounceRate) return { pause: true, reason: `taux de rebond ${(100 * s.bounced / s.sent).toFixed(1)} % > 5 %` };
  if (s.complaints / s.sent > LIMITS.complaintRate) return { pause: true, reason: `taux de plaintes ${(100 * s.complaints / s.sent).toFixed(2)} % > 0,3 %` };
  return { pause: false };
}

export interface SpamCheck {
  score: number;
  warnings: string[];
}

const TRIGGER_WORDS = [
  "gratuit", "100 %", "100%", "garanti", "urgent", "cliquez ici", "gagnez", "argent facile", "sans risque",
  "offre limitée", "félicitations", "free", "guarantee", "click here", "act now", "winner", "$$$", "€€€",
];

/** Analyse rapide du contenu avant envoi (0 = propre, plus c'est haut plus c'est risqué). */
export function contentSpamCheck(subject: string, body: string): SpamCheck {
  const warnings: string[] = [];
  let score = 0;
  const text = `${subject}\n${body}`.toLowerCase();
  const hits = TRIGGER_WORDS.filter((w) => text.includes(w));
  if (hits.length) {
    score += hits.length * 2;
    warnings.push(`Mots à risque : ${hits.join(", ")}`);
  }
  const links = (body.match(/https?:\/\//g) ?? []).length;
  if (links > 3) {
    score += links - 3;
    warnings.push(`${links} liens : visez 1 à 2 en prospection.`);
  }
  if (/<img\b/i.test(body)) {
    score += 2;
    warnings.push("Image dans le corps : évitez-la au premier contact.");
  }
  const letters = subject.replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (letters.length > 5 && letters === letters.toUpperCase()) {
    score += 3;
    warnings.push("Objet en majuscules.");
  }
  if ((subject.match(/!/g) ?? []).length > 1) {
    score += 2;
    warnings.push("Plusieurs points d'exclamation dans l'objet.");
  }
  const words = body.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  if (words > 200) {
    score += 1;
    warnings.push(`${words} mots : un premier e-mail court (50 à 125 mots) répond mieux.`);
  }
  return { score, warnings };
}
