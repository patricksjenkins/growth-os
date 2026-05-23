-- ============================================================================
-- Migration 031 — Owner equity entry types
--
-- Documents two new entry_type values that the application layer now
-- supports:
--
--   'owner_contribution' — money the owner puts INTO the business
--                          (personal → business bank). Not income, not
--                          taxable. Increases owner's equity.
--   'owner_draw'         — money the owner takes OUT of the business
--                          (business → personal). Not an expense, not
--                          deductible. Decreases owner's equity.
--
-- For a single-member LLC taxed as sole prop, owner contributions and
-- draws are excluded from Schedule C (net income). They affect the
-- owner's basis in the business, tracked separately.
--
-- All P&L aggregations across the API + tax-prep agent + year-end
-- report MUST filter to entry_type IN ('income', 'expense') and exclude
-- the four pass-through types (sales_tax_*, owner_*).
-- ============================================================================

COMMENT ON COLUMN finance_entries.entry_type IS
  'One of: ''income'', ''expense'', ''sales_tax_collected'', ''sales_tax_remitted'', ''owner_contribution'', ''owner_draw''. The four non-(income/expense) types are EXCLUDED from net-income calculations: sales_tax_* are pass-through liability to state DORs; owner_contribution and owner_draw are equity movements that affect owner basis, not Schedule C profit.';

CREATE INDEX IF NOT EXISTS idx_finance_entries_owner_equity
  ON finance_entries (tenant_id, entry_type, date)
  WHERE entry_type IN ('owner_contribution', 'owner_draw');
