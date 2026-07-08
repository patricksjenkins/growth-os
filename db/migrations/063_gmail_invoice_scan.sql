-- 063_gmail_invoice_scan.sql
--
-- Weekly Gmail invoice scanning (2026-07-08).
--
-- Two changes:
--
-- 1. email_connections becomes MULTI-MAILBOX. Patrick's invoices arrive at both
--    patrick@firstgenautomate.com and his personal Gmail, so the old
--    UNIQUE (tenant_id, provider) constraint — one Gmail per tenant — has to go.
--    Replaced by UNIQUE (tenant_id, provider, email_address), plus a partial
--    unique index guaranteeing exactly ONE primary mailbox per provider.
--
--    `is_primary` exists because core/drip-gmail.js getGmailConnection() must
--    keep resolving to a single inbox (the drip reply-sync polls one mailbox).
--    Without it, a second row would make that .maybeSingle() throw and silently
--    break outreach reply handling.
--
-- 2. gmail_invoice_scans — a durable log of every Gmail message/attachment the
--    scanner has already looked at, whatever the outcome. This is deliberately
--    NOT keyed off internal_expenses.idempotency_key: if Patrick REJECTS a draft
--    (which deletes the row), the next weekly scan must not re-import the same
--    attachment and re-queue work he already dismissed.

-- ---------------------------------------------------------------------------
-- 1. Multi-mailbox email_connections
-- ---------------------------------------------------------------------------

ALTER TABLE email_connections DROP CONSTRAINT IF EXISTS email_connections_tenant_id_provider_key;

ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS scan_invoices BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS last_invoice_scan_at TIMESTAMPTZ;

-- Backfill: the oldest connection per (tenant, provider) becomes the primary.
-- The dropped constraint guarantees there is at most one row per pair today,
-- but DISTINCT ON keeps this correct if the migration is ever re-run later.
UPDATE email_connections ec
SET is_primary = true
WHERE ec.id IN (
  SELECT DISTINCT ON (tenant_id, provider) id
  FROM email_connections
  ORDER BY tenant_id, provider, created_at ASC
);

-- Existing Gmail inboxes opt into invoice scanning by default; a newly
-- connected mailbox sets this explicitly at connect time.
UPDATE email_connections SET scan_invoices = true WHERE provider = 'gmail';

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_connections_tenant_provider_address
  ON email_connections (tenant_id, provider, email_address);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_connections_primary
  ON email_connections (tenant_id, provider) WHERE is_primary;

-- ---------------------------------------------------------------------------
-- 2. Scan log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gmail_invoice_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES email_connections(id) ON DELETE SET NULL,
  mailbox TEXT,
  gmail_message_id TEXT NOT NULL,
  attachment_id TEXT,
  filename TEXT,
  -- imported | duplicate | skipped_unsupported | skipped_no_attachment | error
  outcome TEXT NOT NULL,
  internal_expense_id UUID,
  detail TEXT,
  message_date TIMESTAMPTZ,
  from_address TEXT,
  subject TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (message, attachment). A message with no attachment logs once
-- with attachment_id NULL, hence the COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gmail_invoice_scans_msg_att
  ON gmail_invoice_scans (tenant_id, gmail_message_id, COALESCE(attachment_id, ''));

CREATE INDEX IF NOT EXISTS idx_gmail_invoice_scans_recent
  ON gmail_invoice_scans (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gmail_invoice_scans_expense
  ON gmail_invoice_scans (internal_expense_id) WHERE internal_expense_id IS NOT NULL;

ALTER TABLE gmail_invoice_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_invoice_scans FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gmail_invoice_scans_service_only ON gmail_invoice_scans;
CREATE POLICY gmail_invoice_scans_service_only ON gmail_invoice_scans
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
