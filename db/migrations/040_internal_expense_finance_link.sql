ALTER TABLE internal_expenses ADD COLUMN IF NOT EXISTS finance_entry_id UUID;
CREATE INDEX IF NOT EXISTS idx_internal_expenses_finance_entry ON internal_expenses (finance_entry_id);
