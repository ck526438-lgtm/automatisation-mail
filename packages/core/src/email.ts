/**
 * Validation, normalisation et dédoublonnage des adresses e-mail.
 */

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const ROLE_PREFIXES = new Set([
  "admin", "contact", "info", "support", "sales", "ventes", "commercial", "hello", "bonjour",
  "noreply", "no-reply", "postmaster", "webmaster", "abuse", "billing", "facturation",
  "compta", "comptabilite", "rh", "hr", "jobs", "recrutement", "marketing", "office", "team",
]);

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "yopmail.com", "yopmail.fr", "guerrillamail.com", "10minutemail.com",
  "tempmail.com", "temp-mail.org", "trashmail.com", "sharklasers.com", "getnada.com",
  "dispostable.com", "maildrop.cc", "throwawaymail.com", "fakeinbox.com", "moakt.com",
]);

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export interface EmailCheck {
  valid: boolean;
  normalized: string;
  domain: string;
  isRole: boolean;
  isDisposable: boolean;
  reason?: "syntax" | "disposable";
}

export interface NormalizeOptions {
  /** Retire les points et le suffixe +tag des adresses Gmail. */
  collapseGmailAliases?: boolean;
}

export function normalizeEmail(raw: string, opts: NormalizeOptions = {}): string {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (opts.collapseGmailAliases && GMAIL_DOMAINS.has(domain)) {
    local = local.split("+")[0]!.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

export function checkEmail(raw: string, opts: NormalizeOptions = {}): EmailCheck {
  const normalized = normalizeEmail(raw, opts);
  const domain = normalized.split("@")[1] ?? "";
  const local = normalized.split("@")[0] ?? "";
  const syntaxOk = normalized.length <= 254 && local.length <= 64 && EMAIL_RE.test(normalized);
  const isDisposable = DISPOSABLE_DOMAINS.has(domain);
  const isRole = ROLE_PREFIXES.has(local.split("+")[0]!);
  return {
    valid: syntaxOk && !isDisposable,
    normalized,
    domain,
    isRole,
    isDisposable,
    reason: !syntaxOk ? "syntax" : isDisposable ? "disposable" : undefined,
  };
}

export type MergeStrategy = "skip" | "overwrite" | "fill_empty";

export interface ContactInput {
  email: string;
  [field: string]: unknown;
}

export interface DedupeResult<T extends ContactInput> {
  contacts: (T & { emailNormalized: string })[];
  duplicates: number;
  invalid: { row: number; email: string; reason: string }[];
  suppressed: number;
}

/**
 * Dédoublonne un lot de contacts importés et écarte les adresses invalides
 * ou présentes dans la liste de suppression.
 */
export function dedupeContacts<T extends ContactInput>(
  rows: T[],
  options: {
    strategy?: MergeStrategy;
    suppressed?: Set<string>;
    normalize?: NormalizeOptions;
  } = {},
): DedupeResult<T> {
  const strategy = options.strategy ?? "fill_empty";
  const byEmail = new Map<string, T & { emailNormalized: string }>();
  const invalid: DedupeResult<T>["invalid"] = [];
  let duplicates = 0;
  let suppressed = 0;

  rows.forEach((row, i) => {
    const check = checkEmail(String(row.email ?? ""), options.normalize);
    if (!check.valid) {
      invalid.push({ row: i + 1, email: String(row.email ?? ""), reason: check.reason ?? "syntax" });
      return;
    }
    if (options.suppressed?.has(check.normalized)) {
      suppressed++;
      return;
    }
    const existing = byEmail.get(check.normalized);
    if (!existing) {
      byEmail.set(check.normalized, { ...row, emailNormalized: check.normalized });
      return;
    }
    duplicates++;
    if (strategy === "overwrite") {
      byEmail.set(check.normalized, { ...existing, ...row, emailNormalized: check.normalized });
    } else if (strategy === "fill_empty") {
      const merged: Record<string, unknown> = { ...existing };
      for (const [k, v] of Object.entries(row)) {
        if ((merged[k] === undefined || merged[k] === null || merged[k] === "") && v !== "") merged[k] = v;
      }
      byEmail.set(check.normalized, merged as T & { emailNormalized: string });
    }
  });

  return { contacts: [...byEmail.values()], duplicates, invalid, suppressed };
}
