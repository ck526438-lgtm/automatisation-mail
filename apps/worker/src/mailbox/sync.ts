/**
 * Synchronisation des boîtes : lit les messages reçus depuis le dernier passage
 * (Gmail API, Microsoft Graph ou IMAP), puis rattache réponses, absences et rebonds
 * aux e-mails envoyés par la plateforme.
 */
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { classifyInbound, decryptSecret, type InboundMessage } from "@am/core";
import { desc, eq, handleBounce, handleReply, inboundAlreadyProcessed, sendingAccounts, sql, type Db } from "@am/db";
import { config } from "../config.js";
import { GMAIL_API, GRAPH_API } from "./send.js";
import { accessTokenFor, MailboxDisconnectedError } from "./tokens.js";

type Account = typeof sendingAccounts.$inferSelect;

export interface RawInbound {
  /** Identifiant chez le fournisseur (id Gmail, id Graph, UID IMAP) */
  id: string;
  raw: Buffer;
}

/** Recouvrement entre deux passages pour ne rien rater ; les doublons sont écartés par inboundId. */
const OVERLAP_MS = 10 * 60_000;
/** Premier passage : on remonte 3 jours en arrière. */
const FIRST_SYNC_MS = 3 * 86_400_000;
const MAX_PER_SYNC = 200;

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} : HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

async function fetchGmail(token: string, since: Date): Promise<RawInbound[]> {
  const auth = { authorization: `Bearer ${token}` };
  const q = `after:${Math.floor(since.getTime() / 1000)} -in:sent -in:chats`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GMAIL_API}/users/me/messages`);
    url.searchParams.set("q", q);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await json<{ messages?: { id: string }[]; nextPageToken?: string }>(await fetch(url, { headers: auth }), "Gmail liste");
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < MAX_PER_SYNC);
  const out: RawInbound[] = [];
  for (const id of ids.slice(0, MAX_PER_SYNC)) {
    const m = await json<{ raw: string }>(await fetch(`${GMAIL_API}/users/me/messages/${id}?format=raw`, { headers: auth }), "Gmail message");
    out.push({ id, raw: Buffer.from(m.raw, "base64url") });
  }
  return out;
}

async function fetchGraph(token: string, since: Date): Promise<RawInbound[]> {
  const auth = { authorization: `Bearer ${token}` };
  const ids: string[] = [];
  let next: string | undefined = `${GRAPH_API}/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}&$select=id&$top=50&$orderby=receivedDateTime`;
  while (next && ids.length < MAX_PER_SYNC) {
    const page: { value: { id: string }[]; "@odata.nextLink"?: string } = await json(await fetch(next, { headers: auth }), "Graph liste");
    ids.push(...page.value.map((m) => m.id));
    next = page["@odata.nextLink"];
  }
  const out: RawInbound[] = [];
  for (const id of ids.slice(0, MAX_PER_SYNC)) {
    const res = await fetch(`${GRAPH_API}/me/messages/${encodeURIComponent(id)}/$value`, { headers: auth });
    if (!res.ok) throw new Error(`Graph message : HTTP ${res.status}`);
    out.push({ id, raw: Buffer.from(await res.arrayBuffer()) });
  }
  return out;
}

async function fetchImap(account: Account, since: Date): Promise<{ items: RawInbound[]; lastUid?: number }> {
  const client = new ImapFlow({
    host: account.imapHost!,
    port: account.imapPort ?? 993,
    secure: account.imapSecure,
    auth: { user: account.smtpUser || account.email, pass: account.credentialsEnc ? decryptSecret(account.credentialsEnc, config.encryptionKey) : "" },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const lastUid = account.syncCursor ? Number(account.syncCursor) : undefined;
    // Avec un curseur UID : uniquement les nouveaux. Sinon : depuis la date.
    const uids = (lastUid ? await client.search({ uid: `${lastUid + 1}:*` }, { uid: true }) : await client.search({ since }, { uid: true })) || [];
    const wanted = uids.filter((u) => !lastUid || u > lastUid).slice(-MAX_PER_SYNC);
    const items: RawInbound[] = [];
    for (const uid of wanted) {
      const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (m && m.source) items.push({ id: `uid:${uid}`, raw: m.source });
    }
    return { items, lastUid: wanted.length ? Math.max(...wanted) : lastUid };
  } finally {
    lock.release();
    await client.logout().catch(() => undefined);
  }
}

/** Convertit un message analysé au format attendu par @am/core (en-têtes + texte, parties DSN incluses). */
export function toInbound(p: ParsedMail): InboundMessage {
  const headers: Record<string, string> = {};
  for (const h of p.headerLines) {
    const value = h.line.slice(h.line.indexOf(":") + 1).trim();
    headers[h.key] = headers[h.key] ? `${headers[h.key]} ${value}` : value;
  }
  // Les rapports de non-remise portent l'essentiel dans des parties message/delivery-status et text/rfc822-headers.
  const reportParts = p.attachments
    .filter((a) => /message\/(delivery-status|rfc822)|text\/rfc822-headers|message\/global-delivery-status/i.test(a.contentType))
    .map((a) => a.content.toString("utf8"));
  return {
    headers,
    from: p.from?.text ?? "",
    subject: p.subject ?? "",
    text: [p.text ?? "", ...reportParts].join("\n"),
  };
}

export interface SyncResult {
  scanned: number;
  replies: number;
  autoReplies: number;
  bounces: number;
  ignored: number;
}

export async function processInbound(db: Db, account: Account, items: RawInbound[]): Promise<SyncResult> {
  const r: SyncResult = { scanned: items.length, replies: 0, autoReplies: 0, bounces: 0, ignored: 0 };
  for (const item of items) {
    if (await inboundAlreadyProcessed(db, account.id, item.id)) {
      r.ignored++;
      continue;
    }
    const inbound = toInbound(await simpleParser(item.raw));
    const verdict = classifyInbound(inbound, account.email);
    const meta = { inboundId: item.id, accountId: account.id };

    if (verdict.kind === "reply") {
      const matched = await handleReply(db, {
        inReplyTo: verdict.refs, from: inbound.from, subject: inbound.subject, snippet: inbound.text,
        autoReply: verdict.autoReply, extraMeta: meta,
      });
      if (!matched) r.ignored++;
      else if (verdict.autoReply) r.autoReplies++;
      else r.replies++;
    } else if (verdict.kind === "bounce") {
      let ref: { messageIdHeader?: string; messageId?: string } | null = verdict.originalMessageId ? { messageIdHeader: verdict.originalMessageId } : null;
      // Sans Message-ID d'origine : dernier message envoyé par cette boîte au destinataire en échec.
      if (!ref && verdict.recipient) {
        const { rows: [m] } = await db.execute<{ id: string }>(sql`
          select m.id from messages m join contacts c on c.id = m.contact_id
          where m.sending_account_id = ${account.id} and c.email_normalized = ${verdict.recipient}
          order by m.sent_at desc nulls last limit 1`);
        if (m) ref = { messageId: m.id };
      }
      const done = ref ? await handleBounce(db, ref, verdict.bounce, meta) : null;
      if (done) r.bounces++;
      else r.ignored++;
    } else {
      r.ignored++;
    }
  }
  return r;
}

/** Synchronise une boîte. Renvoie null si la boîte n'a aucun moyen de lecture configuré. */
export async function syncAccount(db: Db, account: Account): Promise<SyncResult | null> {
  const startedAt = new Date();
  const since = account.lastSyncAt ? new Date(account.lastSyncAt.getTime() - OVERLAP_MS) : new Date(startedAt.getTime() - FIRST_SYNC_MS);
  try {
    let items: RawInbound[];
    let cursor = account.syncCursor;
    if (account.provider === "gmail") items = await fetchGmail(await accessTokenFor(db, account), since);
    else if (account.provider === "outlook") items = await fetchGraph(await accessTokenFor(db, account), since);
    else if (account.provider === "smtp" && account.imapHost) {
      const res = await fetchImap(account, since);
      items = res.items;
      cursor = res.lastUid !== undefined ? String(res.lastUid) : cursor;
    } else return null;

    const result = await processInbound(db, account, items);
    await db.update(sendingAccounts).set({ lastSyncAt: startedAt, syncCursor: cursor, syncError: null }).where(eq(sendingAccounts.id, account.id));
    return result;
  } catch (err) {
    const message = err instanceof MailboxDisconnectedError ? err.message : `Synchronisation : ${(err as Error).message}`;
    await db.update(sendingAccounts).set({ syncError: message.slice(0, 500) }).where(eq(sendingAccounts.id, account.id));
    throw err;
  }
}

/** Boîtes à synchroniser : OAuth connectées, ou SMTP avec IMAP configuré. */
export async function accountsToSync(db: Db): Promise<Account[]> {
  const all = await db.select().from(sendingAccounts).where(eq(sendingAccounts.needsReconnect, false)).orderBy(desc(sendingAccounts.lastSyncAt));
  return all.filter((a) => a.provider === "gmail" || a.provider === "outlook" || (a.provider === "smtp" && a.imapHost));
}
