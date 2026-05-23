-- ============================================================================
-- 026_sales_tax_schema_prep.sql — Section 10: Sales Tax structural prep
--
-- Authored: 2026-05-23 — BI & Financial Sync (per
-- ~/Desktop/FGA/dashboards/bi-sync-strategy.html §10 Sales Tax / Nexus).
--
-- Adds the four schema fields that make future sales-tax handling cheap
-- to enable. Zero behavior change today — all fields default to GA / 0
-- / nothing-taxable. Once FGA approaches economic nexus in another state
-- (Section 10 nexus monitor), turn on collection by populating these fields.
--
-- See strategy brief §10 for the why and §10's policy on Option A
-- (entry_type discriminator) vs Option B (separate table). We're going
-- with Option A: extend the existing CHECK constraint on finance_entries
-- to permit new entry_type values 'sales_tax_collected' and
-- 'sales_tax_remitted'. P&L reports filter to ('income', 'expense'),
-- so tax entries fall out of net income automatically.
--
-- Also adds the Stripe idempotency index referenced in migration 023
-- comments — used by the webhook handler in api/routes/stripe-webhook.js
-- to reject duplicate invoice.paid events.
-- ============================================================================

-- ── 1. tax_jurisdiction on tenant_config ───────────────────────────────────
-- State code that drives the future tax calc. Default to GA (FGA's home).
ALTER TABLE tenant_config
  ADD COLUMN IF NOT EXISTS tax_jurisdiction TEXT DEFAULT 'GA';

-- ── 2. Stripe idempotency index on finance_entries.metadata ─────────────────
-- The Stripe webhook (Phase 1 Step 3) creates finance_entries with
-- metadata.stripe_invoice_id. Make that uniquely indexed so a duplicate
-- delivery of the same invoice.paid event can't double-book the income.
--
-- Partial index — only enforced when the field exists. Other entries
-- (manual + Mercury + crew payroll) don't have this key, so they're
-- unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finance_entries_stripe_invoice_uniq
  ON finance_entries((metadata->>'stripe_invoice_id'))
  WHERE metadata ? 'stripe_invoice_id';


-- ── 3. Extend entry_type CHECK constraint to permit sales-tax types ────────
-- Note: the existing finance_entries table doesn't have an explicit
-- CHECK on entry_type (it's TEXT free-form), but the application enforces
-- 'income'|'expense'. We're adding a comment to document the new values
-- now allowed; the app will start writing them when the nexus monitor
-- triggers collection.
COMMENT ON COLUMN finance_entries.entry_type IS
  'Permitted values: income, expense, sales_tax_collected, sales_tax_remitted. ' ||
  'P&L reports filter to (income, expense); sales tax types are pass-through ' ||
  'liabilities, not revenue. See bi-sync-strategy.html §10.';


-- ── 4. metadata field docs (no schema change — JSONB is open) ───────────────
-- These fields are populated by the application layer on each transaction
-- once sales tax collection is enabled. Documenting here so the contract
-- is clear:
--
--   metadata.sales_tax_amount     DECIMAL  — tax collected on this entry
--   metadata.sales_tax_rate       DECIMAL  — rate at time of transaction
--   metadata.tax_jurisdiction     TEXT     — state code (per-transaction
--                                            override of tenant_config default)
--   metadata.stripe_invoice_id    TEXT     — for income entries from Stripe
--                                            (idempotency, see index above)
--   metadata.stripe_charge_id     TEXT     — charge-level ref for matching
--                                            against bank deposits


-- ── 5. Backfill: stamp existing tenants with default jurisdiction ──────────
UPDATE tenant_config
   SET tax_jurisdiction = 'GA'
 WHERE tax_jurisdiction IS NULL;
