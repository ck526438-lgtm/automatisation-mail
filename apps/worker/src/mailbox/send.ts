/**
 * Envoi d'un message par le bon canal : SMTP, Gmail API ou Microsoft Graph.
 * Le MIME est composé une seule fois (nodemailer) pour que Message-ID, In-Reply-To
 * et List-Unsubscribe soient identiques quel que soit le fournisseur.
 */
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type { sendingAccounts, Db } from "@am/db";
import { transportFor } from "../transport.js";
import { accessTokenFor } from "./tokens.js";

type Account = typeof sendingAccounts.$inferSelect;

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
export const GRAPH_API = "https://graph.microsoft.com/v1.0";

/** Erreur d'envoi : `permanent` = refus définitif du destinataire (traité comme rebond). */
export class SendError extends Error {
  constructor(message: string, public readonly permanent: boolean, public readonly responseCode?: number) {
    super(message);
  }
}

export async function composeMime(options: Mail.Options): Promise<Buffer> {
  return new MailComposer(options).compile().build();
}

async function providerError(res: Response, provider: string): Promise<SendError> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    detail = typeof j.error === "string" ? j.error : j.error?.message ?? detail;
  } catch { /* texte brut */ }
  // 429 et 5xx : temporaire, BullMQ réessaie. 400 « invalid recipient » : définitif.
  const permanent = res.status === 400 && /invalid (to|recipient)|recipient address rejected/i.test(detail);
  return new SendError(`${provider} HTTP ${res.status} : ${detail}`, permanent, res.status);
}

export async function sendMessage(db: Db, account: Account, options: Mail.Options): Promise<void> {
  if (account.provider === "smtp") {
    try {
      await transportFor(account).sendMail(options);
    } catch (err) {
      const e = err as Error & { responseCode?: number; response?: string };
      if (e.responseCode && e.responseCode >= 500) throw new SendError(e.response ?? e.message, true, e.responseCode);
      throw err;
    }
    return;
  }

  const raw = await composeMime(options);
  const token = await accessTokenFor(db, account);

  if (account.provider === "gmail") {
    const res = await fetch(`${GMAIL_API}/users/me/messages/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: raw.toString("base64url") }),
    });
    if (!res.ok) throw await providerError(res, "Gmail");
    return;
  }

  if (account.provider === "outlook") {
    // Graph accepte un message MIME complet encodé en base64, en text/plain.
    const res = await fetch(`${GRAPH_API}/me/sendMail`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: raw.toString("base64"),
    });
    if (!res.ok) throw await providerError(res, "Microsoft Graph");
    return;
  }

  throw new Error(`Fournisseur « ${account.provider} » non pris en charge`);
}
