-- ============================================================================
-- Migration 028 — Growth & Ops metrics + cohort tracking
--
-- Phase 3 Step 1 of the BI & Financial Sync plan
-- (~/Desktop/FGA/dashboards/bi-sync-strategy.html §3 Phase 3).
--
-- Adds:
--   - tenant_config.first_paid_at — timestamp of first non-zero invoice paid
--   - tenant_config.churned_at — timestamp the tenant cancelled
--   - tenant_metrics_snapshots — daily snapshot of MRR + status per tenant,
--     so we can chart cohort retention and MRR trend without recomputing
--     historicals every page load.
--
-- Existing data can be backfilled later — these are nullable.
-- ============================================================================

-- tenant_config is key/value. The migration adds new well-known keys via
-- a partial unique constraint check; no schema change needed.
--
-- Convention: each row is (tenant_id, key, value) where value is JSONB.
-- For cohort fields we use keys 'first_paid_at' and 'churned_at' with
-- value = ISO timestamp string.

CREATE TABLE IF NOT EXISTS tenant_metrics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  mrr DECIMAL(12, 2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL,           -- e.g. 'active', 'trial', 'paused', 'churned'
  tier TEXT,                       -- 'growth' | 'scale' | 'complimentary'
  metadata JSONB,                  -- room for ARR override, MRR contribution by source, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, snapshot_date)
);

COMMENT ON TABLE tenant_metrics_snapshots IS
  'Daily snapshot of tenant MRR + status. Populated by a daily cron job. Powers MRR trend, churn cohort analysis, and Net New MRR charts.';

CREATE INDEX IF NOT EXISTS idx_tenant_metrics_snapshots_by_date
  ON tenant_metrics_snapshots (snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_metrics_snapshots_by_tenant_date
  ON tenant_metrics_snapshots (tenant_id, snapshot_date DESC);

-- Optional RLS for tenant-scoped read (admin can see all)
ALTER TABLE tenant_metrics_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_metrics_snapshots ON tenant_metrics_snapshots
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid OR current_setting('app.is_admin', true) = 'true');

CREATE POLICY tenant_iso_metrics_snapshots_write ON tenant_metrics_snapshots
  FOR ALL
  USING (current_setting('app.is_admin', true) = 'true' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (current_setting('app.is_admin', true) = 'true' OR tenant_id = current_setting('app.tenant_id', true)::uuid);
