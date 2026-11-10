/**
 * Worker d'envoi : contrôles de conformité et de délivrabilité, rendu, signature des liens, envoi SMTP.
 * Un envoi qui ne peut pas partir maintenant (fenêtre, quota, écart) est repoussé, jamais perdu.
 */
import { DelayedError, type Job } from "bullmq";
import {
  allowedCampaignVolume, appendComplianceFooter, hashSeed, instrumentHtml, isInWindow, nextWindowStart, randomGapMs,
  render, textToHtml, unsubscribeHeaders, unsubscribeUrl, DEFAULT_WINDOW, type SendWindow,
} from "@am/core";
import {
  campaigns, contacts, enrollments, eq, handleBounce, isSuppressed, messages, organizations, recordEvent,
  sendingAccounts, sendingDomains, sql, templates, workflowVersions, type Db,
} from "@am/db";
import { config } from "./config.js";
import { sendMessage, SendError } from "./mailbox/send.js";
import { MailboxDisconnectedError } from "./mailbox/tokens.js";
import type { SendJob } from "./scheduler.js";

async function postpone(job: Job<SendJob>, token: string | undefined, until: Date, reason: string): Promise<never> {
  await job.log(`Repoussé au ${until.toISOString()} : ${reason}`);
  await job.moveToDelayed(until.getTime(), token);
  throw new DelayedError();
}

async function fail(db: Db, messageId: string, reason: string): Promise<void> {
  await db.update(messages).set({ status: "failed", error: reason }).where(eq(messages.id, messageId));
}

export function makeSendProcessor(db: Db) {
  return async (job: Job<SendJob>, token?: string): Promise<string> => {
    const [msg] = await db.select().from(messages).where(eq(messages.id, job.data.messageId));
    if (!msg) return "message supprimé";
    if (msg.status !== "queued") return `déjà ${msg.status}`;

    const [contact] = await db.select().from(contacts).where(eq(contacts.id, msg.contactId));
    const [campaign] = msg.campaignId ? await db.select().from(campaigns).where(eq(campaigns.id, msg.campaignId)) : [];
    const [account] = msg.sendingAccountId ? await db.select().from(sendingAccounts).where(eq(sendingAccounts.id, msg.sendingAccountId)) : [];
    const [org] = await db.select().from(organizations).where(eq(organizations.id, msg.orgId));
    const [enrollment] = msg.enrollmentId ? await db.select().from(enrollments).where(eq(enrollments.id, msg.enrollmentId)) : [];
    if (!contact || !account || !org) {
      await fail(db, msg.id, "contact, boîte ou organisation introuvable");
      return "abandonné";
    }

    // 1. Conformité : jamais d'envoi vers une adresse désinscrite, en rebond ou en plainte.
    if (contact.status !== "active" || (await isSuppressed(db, msg.orgId, contact.email))) {
      await fail(db, msg.id, "adresse supprimée");
      return "supprimé";
    }
    if (enrollment && enrollment.state === "stopped") {
      await fail(db, msg.id, `séquence arrêtée (${enrollment.stopReason ?? ""})`);
      return "séquence arrêtée";
    }

    // 2. Campagne en pause ou boîte suspendue : on attend.
    if (campaign && campaign.status !== "running") return postpone(job, token, new Date(Date.now() + 3_600_000), `campagne ${campaign.status}`);
    if (account.paused) return postpone(job, token, new Date(Date.now() + 3_600_000), "boîte en pause");

    // 3. Fenêtre horaire dans le fuseau du contact.
    const window: SendWindow = { ...(campaign?.sendWindow ?? { ...DEFAULT_WINDOW, timezone: org.timezone }), ...(contact.timezone ? { timezone: contact.timezone } : {}) };
    const now = new Date();
    if (!isInWindow(now, window)) return postpone(job, token, nextWindowStart(now, window), "hors fenêtre d'envoi");

    // 4. Quota journalier (warm-up + score de santé).
    const day = Math.floor((now.getTime() - account.warmupStartedAt.getTime()) / 86_400_000);
    const allowed = account.warmupEnabled ? allowedCampaignVolume(day, account.dailyLimit, account.healthScore) : account.dailyLimit;
    const { rows: [usage] } = await db.execute<{ today: string; last: Date | null }>(sql`
      select count(*) filter (where sent_at >= date_trunc('day', now())) as today, max(sent_at) as last
      from messages where sending_account_id = ${account.id} and status in ('sent','bounced')`);
    if (Number(usage?.today ?? 0) >= allowed) {
      const tomorrow = new Date(now);
      tomorrow.setUTCHours(24, 0, 0, 0);
      return postpone(job, token, nextWindowStart(tomorrow, window), `quota atteint (${allowed}/jour)`);
    }

    // 5. Écart aléatoire entre deux envois de la même boîte.
    if (usage?.last) {
      const gap = randomGapMs(config.minGapSeconds, config.maxGapSeconds);
      const readyAt = new Date(usage.last).getTime() + gap;
      if (readyAt > now.getTime()) return postpone(job, token, new Date(readyAt), "espacement entre envois");
    }

    // 6. Rendu du contenu.
    const node = enrollment ? await nodeTemplate(db, enrollment.workflowVersionId, msg.nodeId) : null;
    const [tpl] = node ? await db.select().from(templates).where(eq(templates.id, node)) : [];
    if (!tpl) {
      await fail(db, msg.id, "template introuvable");
      return "abandonné";
    }
    const vars = {
      first_name: contact.firstName, last_name: contact.lastName, company: contact.company, title: contact.title,
      email: contact.email, prenom: contact.firstName, nom: contact.lastName, societe: contact.company, poste: contact.title,
      ...contact.customFields,
    };
    const seed = hashSeed(contact.id + (msg.nodeId ?? ""));
    const subject = render(tpl.subject, vars, { seed }).output.trim();
    const text = render(tpl.bodyText, vars, { seed }).output;
    let html = tpl.bodyHtml ? render(tpl.bodyHtml, vars, { seed, html: true }).output : textToHtml(text);

    const [domainRow] = account.domainId ? await db.select().from(sendingDomains).where(eq(sendingDomains.id, account.domainId)) : [];
    const trackingBase = domainRow?.trackingDomain ? `https://${domainRow.trackingDomain}` : config.publicUrl;
    html = instrumentHtml(html, {
      baseUrl: trackingBase, secret: config.trackingSecret, messageId: msg.id,
      trackOpens: campaign?.trackOpens ?? false, trackClicks: campaign?.trackClicks ?? true,
    });
    const unsub = unsubscribeUrl(trackingBase, msg.id, config.trackingSecret);
    const body = appendComplianceFooter({ html, text }, {
      unsubscribeUrl: unsub, senderName: account.fromName || org.name, postalAddress: org.postalAddress,
      style: campaign?.type === "cold" ? "prospection" : "newsletter",
    });

    // 7. Envoi (SMTP, Gmail API ou Microsoft Graph).
    try {
      await sendMessage(db, account, {
        from: account.fromName ? { name: account.fromName, address: account.email } : account.email,
        to: [contact.firstName, contact.lastName].filter(Boolean).length ? { name: [contact.firstName, contact.lastName].filter(Boolean).join(" "), address: contact.email } : contact.email,
        subject,
        text: body.text,
        html: body.html,
        messageId: `<${msg.messageIdHeader}>`,
        inReplyTo: msg.inReplyTo ? `<${msg.inReplyTo}>` : undefined,
        references: msg.inReplyTo ? [`<${msg.inReplyTo}>`] : undefined,
        headers: { ...unsubscribeHeaders(unsub), "X-AM-Message": msg.id },
      });
    } catch (err) {
      if (err instanceof SendError && err.permanent) {
        // Refus définitif du serveur destinataire : traité comme un rebond.
        await db.update(messages).set({ subject, sentAt: new Date(), status: "sent" }).where(eq(messages.id, msg.id));
        await handleBounce(db, { messageId: msg.id }, { code: err.responseCode && err.responseCode >= 500 ? err.responseCode : 550, message: err.message });
        return "rejeté (rebond)";
      }
      if (err instanceof MailboxDisconnectedError) {
        // Boîte déconnectée : on réessaie dans une heure, le temps que l'utilisateur la reconnecte.
        return postpone(job, token, new Date(Date.now() + 3_600_000), err.message);
      }
      throw err; // erreur temporaire : BullMQ réessaie avec backoff exponentiel
    }

    await db.update(messages).set({ subject, status: "sent", sentAt: new Date(), error: null }).where(eq(messages.id, msg.id));
    await recordEvent(db, { orgId: msg.orgId, type: "sent", messageId: msg.id, contactId: contact.id, campaignId: msg.campaignId, nodeId: msg.nodeId });
    return "envoyé";
  };
}

async function nodeTemplate(db: Db, versionId: string, nodeId: string | null): Promise<string | null> {
  if (!nodeId) return null;
  const [v] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, versionId));
  const node = v?.graph.nodes.find((n) => n.id === nodeId);
  return node?.type === "email" ? node.templateId : null;
}

