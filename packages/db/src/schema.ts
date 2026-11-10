/**
 * Schéma de données d'Automatisation Mail.
 * Chaque table métier porte `org_id` : l'isolation multi-tenant est appliquée
 * dans toutes les requêtes et peut être renforcée par Row-Level Security (voir sql/rls.sql).
 */
import { sql } from "drizzle-orm";
import {
  boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import type { WorkflowGraph, SegmentRule, SendWindow, DomainReport } from "@am/core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const orgId = () => uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" });

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("starter"),
  timezone: text("timezone").notNull().default("Africa/Abidjan"),
  /** Adresse postale obligatoire en pied de message (CAN-SPAM) */
  postalAddress: text("postal_address").notNull().default(""),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("organizations_api_key_idx").on(t.apiKeyHash)]);

export const users = pgTable("users", {
  id: id(),
  orgId: orgId(),
  email: text("email").notNull(),
  name: text("name"),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
  passwordHash: text("password_hash"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

/** Sessions de l'interface : seule l'empreinte SHA-256 du jeton est stockée. */
export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)]);

/** Invitations d'équipe : lien à usage unique, valable 7 jours. */
export const invitations = pgTable("invitations", {
  id: id(),
  orgId: orgId(),
  email: text("email").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
  tokenHash: text("token_hash").notNull(),
  invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("invitations_token_idx").on(t.tokenHash), index("invitations_org_idx").on(t.orgId)]);

export const sendingDomains = pgTable("sending_domains", {
  id: id(),
  orgId: orgId(),
  domain: text("domain").notNull(),
  spfOk: boolean("spf_ok").notNull().default(false),
  dkimOk: boolean("dkim_ok").notNull().default(false),
  dmarcOk: boolean("dmarc_ok").notNull().default(false),
  trackingDomain: text("tracking_domain"),
  lastReport: jsonb("last_report").$type<DomainReport>(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("sending_domains_org_domain_idx").on(t.orgId, t.domain)]);

export const sendingAccounts = pgTable("sending_accounts", {
  id: id(),
  orgId: orgId(),
  domainId: uuid("domain_id").references(() => sendingDomains.id, { onDelete: "set null" }),
  email: text("email").notNull(),
  fromName: text("from_name").notNull().default(""),
  provider: text("provider", { enum: ["smtp", "gmail", "outlook", "ses"] }).notNull().default("smtp"),
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  smtpSecure: boolean("smtp_secure").notNull().default(false),
  smtpUser: text("smtp_user"),
  /** Mot de passe SMTP/IMAP chiffré (AES-256-GCM, voir @am/core/crypto) */
  credentialsEnc: text("credentials_enc"),
  /** IMAP, pour lire réponses et rebonds des boîtes SMTP (même identifiant que SMTP) */
  imapHost: text("imap_host"),
  imapPort: integer("imap_port"),
  imapSecure: boolean("imap_secure").notNull().default(true),
  /** Jetons OAuth chiffrés (Gmail, Microsoft 365) */
  oauthRefreshEnc: text("oauth_refresh_enc"),
  oauthAccessEnc: text("oauth_access_enc"),
  oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
  /** Le fournisseur a révoqué l'accès : l'utilisateur doit reconnecter la boîte */
  needsReconnect: boolean("needs_reconnect").notNull().default(false),
  /** Curseur de synchronisation : historyId Gmail, date ISO Graph, dernier UID IMAP */
  syncCursor: text("sync_cursor"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  syncError: text("sync_error"),
  dailyLimit: integer("daily_limit").notNull().default(50),
  warmupEnabled: boolean("warmup_enabled").notNull().default(true),
  warmupStartedAt: timestamp("warmup_started_at", { withTimezone: true }).notNull().defaultNow(),
  healthScore: integer("health_score").notNull().default(100),
  paused: boolean("paused").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("sending_accounts_org_email_idx").on(t.orgId, t.email)]);

export const contacts = pgTable("contacts", {
  id: id(),
  orgId: orgId(),
  email: text("email").notNull(),
  emailNormalized: text("email_normalized").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  company: text("company"),
  title: text("title"),
  phone: text("phone"),
  country: text("country"),
  timezone: text("timezone"),
  customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default({}),
  status: text("status", { enum: ["active", "unsubscribed", "bounced", "complained"] }).notNull().default("active"),
  source: text("source").notNull().default("manual"),
  /** Preuve de consentement / base légale (RGPD) */
  consent: jsonb("consent").$type<{ basis: "consent" | "legitimate_interest"; at: string; proof?: string }>(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("contacts_org_email_idx").on(t.orgId, t.emailNormalized),
  index("contacts_org_status_idx").on(t.orgId, t.status),
]);

export const tags = pgTable("tags", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
}, (t) => [uniqueIndex("tags_org_name_idx").on(t.orgId, t.name)]);

export const contactTags = pgTable("contact_tags", {
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.contactId, t.tagId] })]);

export const segments = pgTable("segments", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  rules: jsonb("rules").$type<SegmentRule>().notNull(),
  createdAt: createdAt(),
});

export const templates = pgTable("templates", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  subject: text("subject").notNull(),
  bodyText: text("body_text").notNull(),
  bodyHtml: text("body_html"),
  createdAt: createdAt(),
});

export const workflows = pgTable("workflows", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  currentVersion: integer("current_version").notNull().default(1),
  createdAt: createdAt(),
});

/** Une version publiée est figée : les contacts déjà inscrits restent sur leur version. */
export const workflowVersions = pgTable("workflow_versions", {
  id: id(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  graph: jsonb("graph").$type<WorkflowGraph>().notNull(),
  publishedAt: createdAt(),
}, (t) => [uniqueIndex("workflow_versions_idx").on(t.workflowId, t.version)]);

export const campaigns = pgTable("campaigns", {
  id: id(),
  orgId: orgId(),
  name: text("name").notNull(),
  type: text("type", { enum: ["cold", "nurture", "newsletter"] }).notNull().default("cold"),
  status: text("status", { enum: ["draft", "running", "paused", "completed"] }).notNull().default("draft"),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  sendWindow: jsonb("send_window").$type<SendWindow>(),
  trackOpens: boolean("track_opens").notNull().default(false),
  trackClicks: boolean("track_clicks").notNull().default(true),
  pauseReason: text("pause_reason"),
  createdAt: createdAt(),
});

export const campaignAccounts = pgTable("campaign_accounts", {
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  sendingAccountId: uuid("sending_account_id").notNull().references(() => sendingAccounts.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.campaignId, t.sendingAccountId] })]);

export const enrollments = pgTable("enrollments", {
  id: id(),
  orgId: orgId(),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  workflowVersionId: uuid("workflow_version_id").notNull().references(() => workflowVersions.id),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  /** Le contact reste sur la même boîte pour tout le fil */
  sendingAccountId: uuid("sending_account_id").references(() => sendingAccounts.id, { onDelete: "set null" }),
  currentNodeId: text("current_node_id").notNull(),
  state: text("state", { enum: ["active", "waiting", "completed", "stopped"] }).notNull().default("active"),
  enteredNodeAt: timestamp("entered_node_at", { withTimezone: true }).notNull().defaultNow(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  stopReason: text("stop_reason"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("enrollments_campaign_contact_idx").on(t.campaignId, t.contactId),
  index("enrollments_due_idx").on(t.state, t.nextRunAt),
]);

export const messages = pgTable("messages", {
  id: id(),
  orgId: orgId(),
  enrollmentId: uuid("enrollment_id").references(() => enrollments.id, { onDelete: "set null" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  nodeId: text("node_id"),
  sendingAccountId: uuid("sending_account_id").references(() => sendingAccounts.id, { onDelete: "set null" }),
  /** En-tête Message-ID, pour rattacher réponses et rebonds */
  messageIdHeader: text("message_id_header").notNull(),
  inReplyTo: text("in_reply_to"),
  subject: text("subject").notNull(),
  status: text("status", { enum: ["queued", "sent", "failed", "bounced"] }).notNull().default("queued"),
  error: text("error"),
  /** Clé d'idempotence : enrollment + nœud, empêche le double envoi */
  idempotencyKey: text("idempotency_key").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("messages_message_id_idx").on(t.messageIdHeader),
  uniqueIndex("messages_idempotency_idx").on(t.idempotencyKey),
  index("messages_account_sent_idx").on(t.sendingAccountId, t.sentAt),
]);

/** Journal d'événements (à partitionner par mois en production, puis migrer vers ClickHouse). */
export const events = pgTable("events", {
  id: id(),
  orgId: orgId(),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
  nodeId: text("node_id"),
  type: text("type", { enum: ["sent", "delivered", "open", "click", "reply", "bounce", "complaint", "unsubscribe", "auto_reply"] }).notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  isBot: boolean("is_bot").notNull().default(false),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("events_campaign_type_idx").on(t.orgId, t.campaignId, t.type, t.occurredAt),
  index("events_contact_idx").on(t.contactId, t.occurredAt),
  // Déduplication des messages entrants lors des synchronisations successives
  index("events_inbound_idx").on(sql`(${t.meta} ->> 'inboundId')`),
]);

/** Liste de suppression : org_id nul = suppression globale à la plateforme. */
export const suppressions = pgTable("suppressions", {
  id: id(),
  orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  emailNormalized: text("email_normalized").notNull(),
  reason: text("reason", { enum: ["unsubscribe", "hard_bounce", "complaint", "manual", "spam_trap"] }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("suppressions_org_email_idx").on(t.orgId, t.emailNormalized)]);

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  orgId: orgId(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});
