-- ============================================================================
-- 024_finance_period_locks.sql — Phase 1 Step 4: Monthly close / lock
--
-- Authored: 2026-05-23 — BI & Financial Sync, Phase 1 (per
-- ~/Desktop/FGA/dashboards/bi-sync-strategy.html §5 deliverable 3).
--
-- Locks a tenant's books for a given (year, month) after they're closed.
-- Once a period is locked:
--   - PATCH /api/finance/income/:id rejects if entry's date is in a locked month
--   - DELETE /api/finance/income/:id same
--   - PATCH/DELETE on expenses same
--   - New INSERTs into a locked month are also rejected (no backdating)
--
-- The lock enforcement happens in the application layer (api/routes/finance.js)
-- via a `assertPeriodEditable()` helper that checks this table before any
-- write. We deliberately do NOT enforce this at the DB layer — the service
-- role still needs to write corrections via admin override (with audit log
-- capturing every override).
--
-- Why: see strategy brief §4 Risk 1 + §6 "what if a number was changed
-- retroactively". Once a CPA-signed-off month is locked, the books can't
-- shift underneath them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS finance_period_locks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  year            INTEGER NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  month           INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  locked_at       TIMESTAMPTZ DEFAULT NOW(),
  locked_by       UUID,            -- supabase auth user id (the platform owner or tenant owner)
  locked_by_label TEXT,            -- e.g. 'patrick@fga.com'
  notes           TEXT,            -- optional reason / reconciliation summary
  reopened_at     TIMESTAMPTZ,     -- NULL if currently locked; set when reopened
  reopened_by     UUID,
  reopened_by_label TEXT,
  reopen_reason   TEXT,
  UNIQUE (tenant_id, year, month)  -- one lock row per period per tenant
);

CREATE INDEX IF NOT EXISTS idx_finance_period_locks_tenant
  ON finance_period_locks(tenant_id, year DESC, month DESC);

-- A period is "currently locked" when reopened_at IS NULL. A partial index
-- on that condition keeps the check cheap.
CREATE INDEX IF NOT EXISTS idx_finance_period_locks_active
  ON finance_period_locks(tenant_id, year, month)
  WHERE reopened_at IS NULL;

-- RLS — tenants see their own lock rows.
ALTER TABLE finance_period_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_iso_finance_period_locks ON finance_period_locks;
CREATE POLICY tenant_iso_finance_period_locks
  ON finance_period_locks FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::UUID);


-- ── Helper: is_period_locked() — used by the API ───────────────────────────
-- Returns TRUE if the given (tenant_id, year, month) is currently locked
-- (i.e. has a finance_period_locks row with reopened_at IS NULL). Called
-- by api/routes/finance.js before every PATCH/DELETE/INSERT.
CREATE OR REPLACE FUNCTION is_period_locked(
  p_tenant_id UUID,
  p_year INTEGER,
  p_month INTEGER
) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM finance_period_locks
    WHERE tenant_id = p_tenant_id
      AND year = p_year
      AND month = p_month
      AND reopened_at IS NULL
  );
$$ LANGUAGE SQL STABLE;
