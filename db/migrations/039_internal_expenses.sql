-- Growth OS — Migration 039: Internal Expense Tracker (FGA-internal only)
--
-- This is NOT a customer/tenant feature. It is FGA's own expense tracking:
-- upload a receipt/invoice -> OCR/AI extract -> pending draft -> review ->
-- approve/reject. It is intentionally NOT scoped by tenant_id and is reachable
-- ONLY through admin-gated routes (/api/admin/expenses/*). RLS is enabled and
-- denies anon/authenticated entirely; the service-role client (used by admin
-- routes) bypasses RLS. This is defense-in-depth on top of adminMiddleware.

CREATE TABLE IF NOT EXISTS internal_expenses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core extracted / entered fields
  vendor_name           TEXT,
  document_type         TEXT,              -- receipt | invoice | screenshot | unknown
  document_number       TEXT,
  expense_date          DATE,
  due_date              DATE,
  currency              TEXT DEFAULT 'USD',
  category              TEXT,              -- one of the default categories
  expense_type          TEXT,             -- Operating expense, Customer delivery expense, etc.
  subtotal_amount       NUMERIC(12,2),
  tax_amount            NUMERIC(12,2),
  total_amount          NUMERIC(12,2),
  payment_status        TEXT DEFAULT 'unknown', -- paid | unpaid | reimbursable | pending | unknown
  recurring             BOOLEAN DEFAULT false,
  recurrence_frequency  TEXT,             -- monthly | annual | quarterly | one-time | unknown
  related_customer_id   TEXT,             -- free-text note in v1 (not an FK)
  related_project_id    TEXT,
  notes                 TEXT,

  -- Line items kept as JSONB in v1 (avoid an over-built child table)
  line_items            JSONB DEFAULT '[]'::jsonb,

  -- Source / file
  source_type           TEXT DEFAULT 'upload',  -- upload | manual | mobile_capture
  file_path             TEXT,             -- object path in the private 'internal-expenses' bucket
  file_mime             TEXT,
  file_size_bytes       INTEGER,
  ocr_text              TEXT,             -- raw extracted text (for audit / future search)

  -- AI / review metadata
  ai_confidence         NUMERIC(4,3),     -- 0.000 - 1.000
  extraction_status     TEXT DEFAULT 'pending',   -- pending | extracted | failed | manual
  review_status         TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected

  -- Dedupe / idempotency
  dedupe_key            TEXT,             -- vendor|docnum|date|total fingerprint
  idempotency_key       TEXT,

  -- Audit
  created_by            UUID,             -- auth.users.id of the admin who uploaded
  reviewed_by           UUID,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Indexes for the dashboard + filters
CREATE INDEX IF NOT EXISTS idx_internal_expenses_review_status ON internal_expenses (review_status);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_expense_date  ON internal_expenses (expense_date);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_vendor        ON internal_expenses (vendor_name);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_category      ON internal_expenses (category);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_recurring     ON internal_expenses (recurring);
CREATE INDEX IF NOT EXISTS idx_internal_expenses_dedupe        ON internal_expenses (dedupe_key);
-- Idempotency: at most one row per non-null idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS uq_internal_expenses_idem
  ON internal_expenses (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- updated_at trigger (reuse the project's convention: a generic touch function)
CREATE OR REPLACE FUNCTION touch_internal_expenses_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_internal_expenses_touch ON internal_expenses;
CREATE TRIGGER trg_internal_expenses_touch
  BEFORE UPDATE ON internal_expenses
  FOR EACH ROW EXECUTE FUNCTION touch_internal_expenses_updated_at();

-- RLS: enable and DENY everyone except service-role. The admin routes use the
-- service client (bypasses RLS); no anon/authenticated user should ever read
-- this table. We intentionally create NO permissive policy for anon/auth.
ALTER TABLE internal_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_expenses FORCE ROW LEVEL SECURITY;

-- Explicit service-role-only policy (belt and suspenders alongside FORCE RLS).
DROP POLICY IF EXISTS internal_expenses_service_only ON internal_expenses;
CREATE POLICY internal_expenses_service_only ON internal_expenses
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
