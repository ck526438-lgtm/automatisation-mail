/**
 * Données de démonstration : une organisation, une boîte SMTP vers Mailpit,
 * trois templates, une séquence en 3 étapes et quelques contacts.
 * Lancer : pnpm db:seed (après pnpm db:push)
 */
import { encryptSecret, hashPassword, normalizeEmail, threeStepColdSequence } from "@am/core";
import { createDb, hashApiKey } from "./index.js";
import * as s from "./schema.js";

const apiKey = process.env.API_DEV_KEY ?? "dev-key-change-me";
const encKey = process.env.ENCRYPTION_KEY ?? "0".repeat(64);

const { db, pool } = createDb();

const [org] = await db.insert(s.organizations).values({
  name: "Démo Automatisation Mail",
  postalAddress: "Cocody, Abidjan, Côte d'Ivoire",
  apiKeyHash: hashApiKey(apiKey),
}).onConflictDoUpdate({ target: s.organizations.apiKeyHash, set: { name: "Démo Automatisation Mail" } }).returning();
if (!org) throw new Error("Organisation non créée");

// Compte propriétaire de démonstration pour l'interface
const demoEmail = process.env.DEMO_EMAIL ?? "demo@automatisation-mail.local";
const demoPassword = process.env.DEMO_PASSWORD ?? "Demo-Abidjan-2026";
await db.insert(s.users).values({ orgId: org.id, email: demoEmail, name: "Compte démo", role: "owner", passwordHash: await hashPassword(demoPassword) })
  .onConflictDoNothing();

const [account] = await db.insert(s.sendingAccounts).values({
  orgId: org.id,
  email: "commercial@demo.local",
  fromName: "Équipe Démo",
  provider: "smtp",
  smtpHost: process.env.DEV_SMTP_HOST ?? "localhost",
  smtpPort: Number(process.env.DEV_SMTP_PORT ?? 1025),
  smtpUser: "",
  credentialsEnc: encryptSecret("", encKey),
  dailyLimit: 200,
  // Boîte de démonstration considérée comme déjà « chaude »
  warmupStartedAt: new Date(Date.now() - 60 * 86_400_000),
}).onConflictDoNothing().returning();

const tpl = await db.insert(s.templates).values([
  { orgId: org.id, name: "Premier contact", subject: "{Question rapide|Une idée} pour {{company|votre équipe}}", bodyText: "Bonjour {{first_name|}},\n\nJ'ai vu que {{company|votre entreprise}} se développe. Nous aidons les équipes commerciales à automatiser leur prospection sans abîmer leur délivrabilité.\n\nSeriez-vous ouvert(e) à un échange de 15 minutes cette semaine ?\n\nBien à vous," },
  { orgId: org.id, name: "Relance 1", subject: "Re: suivi", bodyText: "Bonjour {{first_name|}},\n\nJe me permets de remonter mon message. Est-ce un sujet pour vous en ce moment ?" },
  { orgId: org.id, name: "Relance finale", subject: "Re: suivi", bodyText: "Bonjour {{first_name|}},\n\nDernier message de ma part : si ce n'est pas le bon moment, aucun souci. Je reste disponible." },
]).returning();

const [wf] = await db.insert(s.workflows).values({ orgId: org.id, name: "Prospection 3 étapes" }).returning();
await db.insert(s.workflowVersions).values({
  workflowId: wf!.id,
  version: 1,
  graph: threeStepColdSequence([tpl[0]!.id, tpl[1]!.id, tpl[2]!.id]),
});

const [campaign] = await db.insert(s.campaigns).values({
  orgId: org.id,
  name: "Démo — dirigeants PME",
  workflowId: wf!.id,
  // Fenêtre large pour pouvoir tester à toute heure en local
  sendWindow: { timezone: "Africa/Abidjan", startHour: 0, endHour: 24, days: [1, 2, 3, 4, 5, 6, 7] },
}).returning();
if (account) await db.insert(s.campaignAccounts).values({ campaignId: campaign!.id, sendingAccountId: account.id });

const people = [
  ["awa.kone@exemple.ci", "Awa", "Koné", "Kone Logistique", "Directrice générale"],
  ["yao.kouassi@exemple.ci", "Yao", "Kouassi", "Kouassi BTP", "Directeur commercial"],
  ["fatou.diallo@exemple.sn", "Fatou", "Diallo", "Diallo Consulting", "Fondatrice"],
] as const;
await db.insert(s.contacts).values(people.map(([email, firstName, lastName, company, title]) => ({
  orgId: org.id, email, emailNormalized: normalizeEmail(email), firstName, lastName, company, title, source: "seed",
  consent: { basis: "legitimate_interest" as const, at: new Date().toISOString() },
}))).onConflictDoNothing();

console.log(`✔ Données de démo créées. Organisation ${org.id}`);
console.log(`  Interface : ${demoEmail} / ${demoPassword}`);
console.log(`  Clé API : ${apiKey}`);
console.log(`  Campagne : ${campaign!.id} (inscrivez les contacts via POST /v1/campaigns/:id/enroll)`);
await pool.end();
