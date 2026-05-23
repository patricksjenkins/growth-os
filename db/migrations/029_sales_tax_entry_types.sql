-- ============================================================================
-- Migration 029 — Sales tax entry types + metadata
--
-- Section 10 of the BI & Financial Sync plan
-- (~/Desktop/FGA/dashboards/bi-sync-strategy.html §10).
--
-- Adds the two new entry types needed for the GL separation principle
-- ("sales tax is NEVER revenue") and the metadata fields that get
-- populated when tax-collection turns on. Empty/null on existing entries —
-- no behavior change until the nexus monitor agent flips the calculation.
-- ============================================================================

-- finance_entries.entry_type is a free-text column today. We rely on the
-- application layer to enforce the allowed values. Document the new types
-- here so future readers know what's valid.

COMMENT ON COLUMN finance_entries.entry_type IS
  'One of: ''income'', ''expense'', ''sales_tax_collected'', ''sales_tax_remitted''. The two sales_tax_* types are EXCLUDED from net-income calculations — they represent pass-through liability to state DORs.';

-- Helpful partial indexes for the nexus monitor + P&L aggregation queries
CREATE INDEX IF NOT EXISTS idx_finance_entries_sales_tax
  ON finance_entries (tenant_id, entry_type, date)
  WHERE entry_type IN ('sales_tax_collected', 'sales_tax_remitted');

-- The metadata JSONB already exists on finance_entries. We just document the
-- new well-known keys the nexus monitor + sales tax flows will use.
--
-- metadata.sales_tax_amount    decimal — the tax portion of a transaction
-- metadata.sales_tax_rate      decimal — the rate applied at the time
-- metadata.tax_jurisdiction    text    — destination state code (e.g. 'TX')
-- metadata.customer_state      text    — alternative key for nexus-monitor
-- metadata.taxjar_id           text    — external reference if TaxJar is wired

-- Track per-state sales tax permit registrations so the nexus monitor
-- knows which states FGA is collecting in vs not.
CREATE TABLE IF NOT EXISTS sales_tax_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state TEXT NOT NULL,                            -- 2-letter state code
  permit_number TEXT,                             -- state-assigned permit number
  registered_at DATE,                             -- date registration became active
  deactivated_at DATE,                            -- if ever closed
  filing_frequency TEXT,                          -- 'monthly' | 'quarterly' | 'annual'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, state)
);

COMMENT ON TABLE sales_tax_registrations IS
  'Tracks each state where the tenant has an active sales-tax permit. Nexus monitor uses this to distinguish "must register" from "already registered" alerts.';

CREATE INDEX IF NOT EXISTS idx_sales_tax_registrations_active
  ON sales_tax_registrations (tenant_id, state)
  WHERE deactivated_at IS NULL;

ALTER TABLE sales_tax_registrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_sales_tax_reg ON sales_tax_registrations
  FOR ALL
  USING (current_setting('app.is_admin', true) = 'true' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (current_setting('app.is_admin', true) = 'true' OR tenant_id = current_setting('app.tenant_id', true)::uuid);
