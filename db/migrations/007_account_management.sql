-- ============================================================================
-- Migration 007: Account Management Tables
-- Health tracking, alerts, and lifecycle event logging
-- ============================================================================

-- === Account Health Log ===
-- Tracks health score snapshots over time per tenant
CREATE TABLE IF NOT EXISTS account_health_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  health_score TEXT NOT NULL CHECK (health_score IN ('green', 'yellow', 'red')),
  metrics JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- === Account Alerts ===
-- Actionable alerts for account issues (payment failures, health drops, etc.)
CREATE TABLE IF NOT EXISTS account_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,
  message TEXT,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- === Lifecycle Events ===
-- Audit trail of account status transitions
CREATE TABLE IF NOT EXISTS lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- === Indexes ===
CREATE INDEX IF NOT EXISTS idx_health_log_tenant ON account_health_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_health_log_created ON account_health_log(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON account_alerts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_alerts_unresolved ON account_alerts(tenant_id, resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_lifecycle_tenant ON lifecycle_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_created ON lifecycle_events(created_at);

-- === RLS ===
ALTER TABLE account_health_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lifecycle_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_iso_health_log ON account_health_log FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_iso_alerts ON account_alerts FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_iso_lifecycle ON lifecycle_events FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
