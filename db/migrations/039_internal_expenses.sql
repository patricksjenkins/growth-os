CREATE TABLE IF NOT EXISTS internal_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name TEXT,
  document_type TEXT,
  document_number TEXT,
  expense_date DATE,
  due_date DATE,
  currency TEXT DEFAULT 'USD',
  category TEXT,
  expense_type TEXT,
  subtotal_amount NUMERIC(12,2),
  tax_amount NUMERIC(12,2),
  total_amount NUMERIC(12,2),
  payment_status TEXT DEFAULT 'unknown',
  recurring BOOLEAN DEFAULT false,
  recurrence_frequency TEXT,
  related_customer_id TEXT,
  related_project_id TEXT,
  notes TEXT,
  line_items JSONB DEFAULT '[]'::jsonb,
  source_type TEXT DEFAULT 'upload',
  file_path TEXT,
  file_mime TEXT,
  file_size_bytes INTEGER,
  ocr_text TEXT,
  ai_confidence NUMERIC(4,3),
  extraction_status TEXT DEFAULT 'pending',
  review_status TEXT NOT NULL DEFAULT 'pending',
  dedupe_key TEXT,
  idempotency_key TEXT,
  created_by UUID,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_internal_expenses_review_status ON internal_expenses (review_status);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_expense_date ON internal_expenses (expense_date);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_vendor ON internal_expenses (vendor_name);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_category ON internal_expenses (category);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_recurring ON internal_expenses (recurring);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_dedupe ON internal_expenses (dedupe_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_expenses_idem ON internal_expenses (idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE internal_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_expenses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS internal_expenses_service_only ON internal_expenses;
CREATE POLICY internal_expenses_service_only ON internal_expenses FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
