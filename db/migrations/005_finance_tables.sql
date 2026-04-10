-- ============================================================================
-- Migration 005: Finance Extended Tables
-- Adds crew_daily_log and debt_tracker for full financial tracking
-- Extends finance_entries with customer_name and job_type for income tracking
-- ============================================================================

-- === Crew Daily Log ===
CREATE TABLE IF NOT EXISTS crew_daily_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  crew_member_id UUID NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  worked BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(crew_member_id, date)
);

-- === Debt Tracker ===
CREATE TABLE IF NOT EXISTS debt_tracker (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  original_amount DECIMAL NOT NULL DEFAULT 0,
  current_balance DECIMAL NOT NULL DEFAULT 0,
  monthly_payment DECIMAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- === Extend finance_entries for income tracking ===
ALTER TABLE finance_entries ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE finance_entries ADD COLUMN IF NOT EXISTS job_type TEXT;

-- === Extend crew_members for is_active flag ===
ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- === Indexes ===
CREATE INDEX IF NOT EXISTS idx_crew_log_tenant ON crew_daily_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_crew_log_member_date ON crew_daily_log(crew_member_id, date);
CREATE INDEX IF NOT EXISTS idx_debt_tenant ON debt_tracker(tenant_id);
CREATE INDEX IF NOT EXISTS idx_finance_tenant_type ON finance_entries(tenant_id, entry_type);
CREATE INDEX IF NOT EXISTS idx_finance_tenant_date ON finance_entries(tenant_id, date);

-- === RLS ===
ALTER TABLE crew_daily_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE debt_tracker ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_iso_crew_log ON crew_daily_log FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY tenant_iso_debt ON debt_tracker FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
