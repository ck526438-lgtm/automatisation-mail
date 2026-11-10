/**
 * Fenêtres d'envoi : n'envoyer qu'aux heures ouvrées, dans le fuseau du destinataire.
 */

export interface SendWindow {
  /** Fuseau IANA, ex. "Africa/Abidjan", "Europe/Paris" */
  timezone: string;
  /** Heure de début incluse (0–23) */
  startHour: number;
  /** Heure de fin exclue (1–24) */
  endHour: number;
  /** Jours autorisés, 1 = lundi … 7 = dimanche */
  days: number[];
}

export const DEFAULT_WINDOW: SendWindow = { timezone: "Africa/Abidjan", startHour: 8, endHour: 17, days: [1, 2, 3, 4, 5] };

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(d: Date, timezone: string): { weekday: number; hour: number; minute: number } {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, fmt);
  }
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return { weekday: WEEKDAY[get("weekday")] ?? 1, hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

export function isInWindow(d: Date, w: SendWindow): boolean {
  const { weekday, hour } = localParts(d, w.timezone);
  return w.days.includes(weekday) && hour >= w.startHour && hour < w.endHour;
}

/**
 * Premier instant ≥ `from` situé dans la fenêtre (précision : 5 minutes).
 * Renvoie `from` inchangé s'il est déjà dans la fenêtre.
 */
export function nextWindowStart(from: Date, w: SendWindow): Date {
  if (w.days.length === 0 || w.startHour >= w.endHour) throw new Error("Fenêtre d'envoi vide");
  if (isInWindow(from, w)) return from;
  const step = 5 * 60_000;
  let t = Math.ceil(from.getTime() / step) * step;
  const limit = from.getTime() + 8 * 86_400_000;
  for (; t <= limit; t += step) {
    const d = new Date(t);
    if (isInWindow(d, w)) return d;
  }
  throw new Error("Aucun créneau trouvé dans les 8 prochains jours");
}

/** Délai aléatoire entre deux envois d'une même boîte (60 à 300 s par défaut). */
export function randomGapMs(minSeconds = 60, maxSeconds = 300, random: () => number = Math.random): number {
  return Math.round((minSeconds + random() * (maxSeconds - minSeconds)) * 1000);
}
