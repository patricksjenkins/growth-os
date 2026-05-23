-- ============================================================================
-- 025_attention_queue.sql — Phase 1 Step 7: Unified "needs attention" surface
--
-- Authored: 2026-05-23 — BI & Financial Sync, Phase 1 (per
-- ~/Desktop/FGA/dashboards/bi-sync-strategy.html §9 Command Center patterns).
--
-- ONE backend abstraction shared by all seven Command Center surfaces:
--   • Action Ribbon at top of Reports (§9.1)
--   • Reconciliation Queue (§9.2)
--   • Quick-Categorize hotkeys (§9.3)
--   • Drill-down detail views (§9.4)
--   • Mobile Inbox with swipe (§9.5)
--   • Agent Health widget (reads agent_activity_log, but failure items
--     also write here so they surface in the ribbon) (§9.6)
--   • Tax Estimate Widget reads tax-prep output (no queue entry needed)
--
-- Producers (write into the queue):
--   • Stripe webhook — when an invoice.paid doesn't match an existing entry
--     ('reconciliation_stripe_unmatched')
--   • Stripe webhook — when a charge fails ('payment_failed')
--   • Mercury bank feed (Phase 4) — when a bank txn doesn't match a ledger
--     entry ('reconciliation_mercury_unmatched')
--   • Bookkeeping agent — when an expense lacks a category
--     ('categorization_needed')
--   • Bookkeeping agent — when duplicate entries detected
--     ('duplicate_suspected')
--   • Worker agents — on consecutive failures ('agent_failure')
--   • Usage cap monitor — when a tenant approaches a cap ('threshold_warning')
--   • Nexus monitor (Section 10) — when sales-tax nexus approaches
--     ('nexus_warning')
--
-- Consumers (read with filters):
--   • Action Ribbon: count by severity, group by type
--   • Reconciliation Queue: WHERE type LIKE 'reconciliation_%'
--   • Mobile Inbox: WHERE type IN ('categorization_needed', 'reconciliation_*')
--   • etc.
--
-- Items are resolved (not deleted) via UPDATE setting resolved_at. We keep
-- the historical record for the audit trail.
-- ============================================================================

CREATE TABLE IF NOT EXISTS attention_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,           -- e.g. 'reconciliation_stripe_unmatched'
  severity        TEXT NOT NULL DEFAULT 'amber' CHECK (severity IN ('red', 'amber', 'blue')),
  title           TEXT NOT NULL,           -- short headline shown in UI
  summary         TEXT,                    -- 1-2 sentences explaining what + why
  entity_type     TEXT,                    -- 'finance_entry', 'stripe_invoice', 'agent_run', etc.
  entity_id       UUID,                    -- FK-style reference (not enforced — entity_type varies)
  payload         JSONB DEFAULT '{}',      -- raw data the surface might want (amount, vendor, etc.)
  quick_actions   JSONB DEFAULT '[]',      -- e.g. [{label:'Categorize', verb:'POST', path:'/api/...'}]
  produced_by     TEXT NOT NULL,           -- 'stripe-webhook' | 'bookkeeping-agent' | 'usage-cap-monitor' etc.
  produced_at     TIMESTAMPTZ DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,             -- NULL while open
  resolved_by     UUID,                    -- supabase auth user
  resolved_by_label TEXT,
  resolution      TEXT,                    -- 'accepted' | 'dismissed' | 'auto_resolved' | etc.
  resolution_payload JSONB                 -- what the user did (category chosen, etc.)
);

CREATE INDEX IF NOT EXISTS idx_attention_queue_tenant_open
  ON attention_queue(tenant_id, produced_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attention_queue_type
  ON attention_queue(tenant_id, type)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attention_queue_severity
  ON attention_queue(tenant_id, severity)
  WHERE resolved_at IS NULL;

-- Composite for the Action Ribbon's "count by severity" query
CREATE INDEX IF NOT EXISTS idx_attention_queue_ribbon
  ON attention_queue(tenant_id, severity, type)
  WHERE resolved_at IS NULL;

-- RLS — tenants see their own queue
ALTER TABLE attention_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso_attention_queue ON attention_queue;
CREATE POLICY tenant_iso_attention_queue
  ON attention_queue FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);


-- ── Helper: count open items by severity ───────────────────────────────────
-- Used by the Action Ribbon. One query, returns the counters the ribbon
-- needs. Cheap because it hits the partial index above.
CREATE OR REPLACE FUNCTION attention_queue_counters(p_tenant_id UUID)
RETURNS TABLE(severity TEXT, count BIGINT) AS $$
  SELECT severity, COUNT(*)
    FROM attention_queue
   WHERE tenant_id = p_tenant_id
     AND resolved_at IS NULL
   GROUP BY severity;
$$ LANGUAGE SQL STABLE;
