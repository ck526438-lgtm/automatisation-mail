/**
 * Tâches de maintenance : score de santé des boîtes (toutes les heures)
 * et revérification DNS des domaines (une fois par jour).
 */
import { checkDomain, healthScore } from "@am/core";
import { eq, sendingAccounts, sendingDomains, sql, type Db } from "@am/db";

export async function refreshHealthScores(db: Db): Promise<number> {
  const { rows } = await db.execute<{ id: string; sent7: string; bounced7: string; sent30: string; complaints30: string; dns_ok: boolean | null }>(sql`
    select a.id,
      (select count(*) from messages m where m.sending_account_id = a.id and m.sent_at > now() - interval '7 days') as sent7,
      (select count(*) from messages m where m.sending_account_id = a.id and m.status = 'bounced' and m.sent_at > now() - interval '7 days') as bounced7,
      (select count(*) from messages m where m.sending_account_id = a.id and m.sent_at > now() - interval '30 days') as sent30,
      (select count(*) from events e join messages m on m.id = e.message_id where m.sending_account_id = a.id and e.type = 'complaint' and e.occurred_at > now() - interval '30 days') as complaints30,
      (select d.spf_ok and d.dkim_ok and d.dmarc_ok from sending_domains d where d.id = a.domain_id) as dns_ok
    from sending_accounts a`);
  for (const r of rows) {
    const sent7 = Number(r.sent7);
    const sent30 = Number(r.sent30);
    const score = healthScore({
      inboxRate: null, // mesuré par le réseau de warm-up (phase 4)
      bounceRate: sent7 ? Number(r.bounced7) / sent7 : 0,
      complaintRate: sent30 ? Number(r.complaints30) / sent30 : 0,
      blacklistHits: 0,
      // Un domaine non encore enregistré n'est pas pénalisé ; un domaine vérifié et en échec l'est.
      dnsOk: r.dns_ok !== false,
    });
    await db.update(sendingAccounts).set({ healthScore: score }).where(eq(sendingAccounts.id, r.id));
  }
  return rows.length;
}

export async function recheckDomains(db: Db): Promise<number> {
  const domains = await db.select().from(sendingDomains);
  for (const d of domains) {
    const report = await checkDomain(d.domain);
    const ok = (s: string) => s === "ok";
    await db.update(sendingDomains).set({
      spfOk: ok(report.spf.status), dkimOk: ok(report.dkim.status),
      dmarcOk: report.dmarc.status === "ok" || report.dmarc.status === "warning",
      lastReport: report, lastCheckedAt: new Date(),
    }).where(eq(sendingDomains.id, d.id));
    // Régression d'authentification : on suspend les boîtes du domaine.
    if (!report.sendable) await db.update(sendingAccounts).set({ paused: true }).where(eq(sendingAccounts.domainId, d.id));
  }
  return domains.length;
}
