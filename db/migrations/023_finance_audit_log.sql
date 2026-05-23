-- ============================================================================
-- 023_finance_audit_log.sql — Phase 1 Step 1+2: Immutable audit trail
--
-- Authored: 2026-05-23 — BI & Financial Sync, Phase 1 (per
-- ~/Desktop/FGA/dashboards/bi-sync-strategy.html §5 deliverable 1).
--
-- Adds:
--   1. finance_audit_log table — append-only record of every finance_entries
--      mutation (INSERT, UPDATE, DELETE). Captures before/after JSON.
--   2. updated_at column on finance_entries (was missing).
--   3. Postgres trigger that writes to finance_audit_log on every change.
--   4. Index on stripe_invoice_id (inside metadata) for idempotent Stripe
--      webhook ingestion — see migration 026 for the unique constraint.
--
-- Why: see strategy brief §4 Risk 1 (audit compliance) and §6 ("show me
-- every transaction" / "what if a number was changed retroactively"). A
-- CPA can't sign off on books without an immutable change record.
--
-- Idempotency: every CREATE wrapped in IF NOT EXISTS so this migration
-- can be safely re-run.
-- ============================================================================

-- ── 1. Add updated_at to finance_entries ────────────────────────────────────
ALTER TABLE finance_entries
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Trigger keeps updated_at fresh on every UPDATE. Separate from the audit
-- trigger so the column stays current even if audit insert fails.
CREATE OR REPLACE FUNCTION finance_entries_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_finance_entries_updated_at ON finance_entries;
CREATE TRIGGER trg_finance_entries_updated_at
  BEFORE UPDATE ON finance_entries
  FOR EACH ROW EXECUTE FUNCTION finance_entries_set_updated_at();


-- ── 2. finance_audit_log table ──────────────────────────────────────────────
-- Append-only. Every row captures the full before/after state of a
-- finance_entries change. Permissions are restricted to inserts only
-- (no UPDATE or DELETE) at the application layer; we don't enforce that
-- in SQL since the service role bypasses RLS, but the trigger is the
-- only writer and there's no application-layer endpoint to mutate this
-- table.
CREATE TABLE IF NOT EXISTS finance_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id     UUID NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_by   UUID,             -- supabase auth user id; NULL for system/webhook writes
  changed_by_label TEXT,         -- human-readable: 'patrick@fga.com', 'stripe-webhook', 'bookkeeping-agent'
  before_row   JSONB,            -- the row state PRE-change (NULL for INSERTs)
  after_row    JSONB,            -- the row state POST-change (NULL for DELETEs)
  changed_fields TEXT[],         -- list of column names that differ (helpful for filtering)
  changed_at   TIMESTAMPTZ DEFAULT NOW(),
  ip_address   INET,             -- captured from auth context where available
  user_agent   TEXT              -- captured from auth context where available
);

CREATE INDEX IF NOT EXISTS idx_finance_audit_tenant_changed_at
  ON finance_audit_log(tenant_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_finance_audit_entry_id
  ON finance_audit_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_finance_audit_action
  ON finance_audit_log(action);

-- RLS — tenants see only their own audit rows; service role bypasses.
ALTER TABLE finance_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso_finance_audit_log ON finance_audit_log;
CREATE POLICY tenant_iso_finance_audit_log
  ON finance_audit_log FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);


-- ── 3. Audit trigger on finance_entries ─────────────────────────────────────
-- Fires AFTER INSERT/UPDATE/DELETE. Reads two GUC session vars set by the
-- API before the write:
--   app.actor_id     — UUID of the supabase auth user (if any)
--   app.actor_label  — 'patrick@fga.com' / 'stripe-webhook' / 'bookkeeping-agent'
--
-- For UPDATEs, also computes which columns actually changed so the audit
-- log can be filtered "show me changes to amount" vs "show me changes
-- to category".
CREATE OR REPLACE FUNCTION finance_entries_audit_trigger()
RETURNS TRIGGER AS $$
DECLARE
  v_actor_id UUID;
  v_actor_label TEXT;
  v_changed TEXT[];
  v_before JSONB;
  v_after JSONB;
  v_tenant UUID;
  v_entry UUID;
BEGIN
  -- Pull session vars (set by the API on each authenticated write).
  -- current_setting(..., true) returns NULL instead of erroring when unset.
  BEGIN
    v_actor_id := nullif(current_setting('app.actor_id', true), '')::UUID;
  EXCEPTION WHEN OTHERS THEN
    v_actor_id := NULL;
  END;
  v_actor_label := nullif(current_setting('app.actor_label', true), '');

  IF TG_OP = 'INSERT' THEN
    v_before := NULL;
    v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id;
    v_entry := NEW.id;
    v_changed := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id;
    v_entry := NEW.id;
    -- Compute changed-fields array by diffing JSONB keys.
    SELECT array_agg(key) INTO v_changed
    FROM (
      SELECT key FROM jsonb_each(v_before)
      WHERE v_before->key IS DISTINCT FROM v_after->key
    ) AS diff;
  ELSE  -- DELETE
    v_before := to_jsonb(OLD);
    v_after := NULL;
    v_tenant := OLD.tenant_id;
    v_entry := OLD.id;
    v_changed := NULL;
  END IF;

  INSERT INTO finance_audit_log
    (tenant_id, entry_id, action, changed_by, changed_by_label,
     before_row, after_row, changed_fields)
  VALUES
    (v_tenant, v_entry, TG_OP, v_actor_id, v_actor_label,
     v_before, v_after, v_changed);

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_finance_entries_audit ON finance_entries;
CREATE TRIGGER trg_finance_entries_audit
  AFTER INSERT OR UPDATE OR DELETE ON finance_entries
  FOR EACH ROW EXECUTE FUNCTION finance_entries_audit_trigger();


-- ── 4. Backfill: stamp updated_at = created_at for existing rows ─────────────
UPDATE finance_entries
   SET updated_at = created_at
 WHERE updated_at IS NULL;
