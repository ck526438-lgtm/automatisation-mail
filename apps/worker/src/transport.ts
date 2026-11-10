import nodemailer, { type Transporter } from "nodemailer";
import { decryptSecret } from "@am/core";
import type { sendingAccounts } from "@am/db";
import { config } from "./config.js";

type Account = typeof sendingAccounts.$inferSelect;

const cache = new Map<string, { transporter: Transporter; key: string }>();

/** Transport SMTP par boîte, mis en cache et recréé si la configuration change. */
export function transportFor(account: Account): Transporter {
  if (account.provider !== "smtp") {
    throw new Error(`Fournisseur « ${account.provider} » pas encore pris en charge : utilisez SMTP (Gmail et Microsoft via OAuth arrivent en phase 1).`);
  }
  const key = [account.smtpHost, account.smtpPort, account.smtpSecure, account.smtpUser, account.credentialsEnc].join("|");
  const hit = cache.get(account.id);
  if (hit && hit.key === key) return hit.transporter;
  const pass = account.smtpUser && account.credentialsEnc ? decryptSecret(account.credentialsEnc, config.encryptionKey) : "";
  const transporter = nodemailer.createTransport({
    host: account.smtpHost ?? "localhost",
    port: account.smtpPort ?? 587,
    secure: account.smtpSecure,
    auth: account.smtpUser ? { user: account.smtpUser, pass } : undefined,
    pool: true,
    maxConnections: 2,
  });
  cache.set(account.id, { transporter, key });
  return transporter;
}
