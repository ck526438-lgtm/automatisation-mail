-- Renforcement de l'isolation multi-tenant par Row-Level Security.
-- L'application exécute `SET LOCAL app.org_id = '<uuid>'` au début de chaque transaction.
-- À appliquer après `pnpm db:push`, avec un rôle applicatif sans BYPASSRLS.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sending_domains','sending_accounts','contacts','tags','segments',
                           'templates','workflows','campaigns','enrollments','messages','events','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
                      USING (org_id = current_setting('app.org_id', true)::uuid)$p$, t);
  END LOOP;
END $$;

-- Partitionnement conseillé de la table events en production :
-- CREATE TABLE events (...) PARTITION BY RANGE (occurred_at);
-- CREATE TABLE events_2026_11 PARTITION OF events FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
