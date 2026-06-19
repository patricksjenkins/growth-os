-- 054_connected_customer_workflow.sql
-- Track A of the connected customer workflow: enter a customer/job/payment once,
-- have it flow across Income -> Customers -> Jobs -> Review requests.
--
-- SAFETY CONTRACT (read before changing):
--   * ADDITIVE ONLY. Every column added here is nullable with no default
--     backfill, so existing rows are untouched and financial TOTALS cannot move.
--   * Foreign keys use ON DELETE SET NULL. Deleting a customer or job can NEVER
--     cascade-delete a finance_entries row -- the money record survives, it just
--     loses its link. This protects the $2.24M of real AKA income history.
--   * No legacy backfill happens here. Linking the 1,522 historical income rows
--     is a separate, human-reviewed step (Track B) and is intentionally NOT in
--     this migration.
--   * finance_entries / customers / jobs are SHARED platform tables (3 tenants).
--     These columns are platform-wide additions, safe for every tenant.

-- ---------------------------------------------------------------------------
-- customers: promote the (currently portal-account-only, 0 service rows) table
-- so it can also hold real service customers (has_account=false). All nullable.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address          TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city             TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS source           TEXT;     -- e.g. income_entry | manual | lead | review
ALTER TABLE customers ADD COLUMN IF NOT EXISTS service_type     TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS first_job_date   DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_job_date    DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_revenue    NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS job_count        INTEGER NOT NULL DEFAULT 0;
-- normalized name kept as a generated column so matching/dedup is consistent
-- and indexable without re-deriving in app code on every read.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS name_normalized  TEXT
  GENERATED ALWAYS AS (btrim(regexp_replace(lower(coalesce(name,'')), '\s+', ' ', 'g'))) STORED;

CREATE INDEX IF NOT EXISTS idx_customers_tenant            ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_namenorm   ON customers(tenant_id, name_normalized);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_phone      ON customers(tenant_id, phone);

-- ---------------------------------------------------------------------------
-- finance_entries: link an income row to the customer it was for and the job
-- it paid for. Nullable; ON DELETE SET NULL keeps the money row intact.
-- ---------------------------------------------------------------------------
ALTER TABLE finance_entries ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE finance_entries ADD COLUMN IF NOT EXISTS job_id      UUID REFERENCES jobs(id)      ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_finance_entries_customer ON finance_entries(customer_id);
CREATE INDEX IF NOT EXISTS idx_finance_entries_job      ON finance_entries(job_id);

-- ---------------------------------------------------------------------------
-- jobs: jobs already link to lead_id; add a direct customer link so a job
-- recorded from a payment (no lead) still ties to the customer.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);

-- ---------------------------------------------------------------------------
-- customer_reviews: tie a review request back to the real customer + job so
-- review eligibility can be driven by completed/paid work instead of a loose
-- name string. customer_reviews still keeps its own name/email/phone snapshot.
-- ---------------------------------------------------------------------------
ALTER TABLE customer_reviews ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE customer_reviews ADD COLUMN IF NOT EXISTS job_id      UUID REFERENCES jobs(id)      ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customer_reviews_customer ON customer_reviews(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_reviews_job      ON customer_reviews(job_id);
