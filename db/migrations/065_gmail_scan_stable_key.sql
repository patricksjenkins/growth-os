-- 065_gmail_scan_stable_key.sql
--
-- BUG FIX (2026-07-08, caught on the second live scan).
--
-- gmail_invoice_scans deduped on (tenant_id, gmail_message_id, attachment_id).
-- Gmail's `attachmentId` is an EPHEMERAL token: it is regenerated on every
-- messages.get call and differs between fetches. So the "have we already
-- scanned this?" check never matched, and every weekly run would have
-- re-imported every invoice as a fresh pending draft.
--
-- Observed: 2 distinct gmail_message_id values produced 6 distinct
-- attachment_id values across 2 scans, and 6 pending drafts where there should
-- have been 3. The idempotency_key on internal_expenses was built from the same
-- unstable value, so the second safety net failed for the identical reason.
--
-- The books were never at risk — drafts are review-gated — but the review queue
-- would have filled with duplicates every Monday.
--
-- Fix: key on a STABLE identity: the attachment's position in the MIME tree,
-- its filename, and its byte size ("<index>:<filename>:<size>"). All three are
-- deterministic for a given message. attachment_id is retained for debugging
-- only and must never be used for identity again.

ALTER TABLE gmail_invoice_scans ADD COLUMN IF NOT EXISTS attachment_key TEXT;

COMMENT ON COLUMN gmail_invoice_scans.attachment_key IS
  'Stable attachment identity "<mime part index>:<filename>:<size>". Dedupe on THIS, never on attachment_id (Gmail regenerates that per fetch).';
COMMENT ON COLUMN gmail_invoice_scans.attachment_id IS
  'Gmail ephemeral attachment token — debugging only. Changes between messages.get calls. NEVER use for identity.';

-- Backfill: existing rows predate the key. Filename alone uniquely identifies
-- the attachments we have (2 messages, 3 distinct filenames).
UPDATE gmail_invoice_scans
SET attachment_key = COALESCE(filename, '')
WHERE attachment_key IS NULL;

-- Drop the duplicate PENDING drafts created by the re-scan, keeping the
-- earliest scan row per (message, filename). Guarded to review_status='pending'
-- so an approved expense — which would have a linked finance_entries row — can
-- never be deleted by this migration.
WITH ranked AS (
  SELECT id, internal_expense_id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, gmail_message_id, COALESCE(attachment_key, '')
           ORDER BY created_at ASC
         ) AS rn
  FROM gmail_invoice_scans
)
DELETE FROM internal_expenses
WHERE review_status = 'pending'
  AND id IN (SELECT internal_expense_id FROM ranked WHERE rn > 1 AND internal_expense_id IS NOT NULL);

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, gmail_message_id, COALESCE(attachment_key, '')
           ORDER BY created_at ASC
         ) AS rn
  FROM gmail_invoice_scans
)
DELETE FROM gmail_invoice_scans
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Re-key the uniqueness guarantee onto the stable value.
DROP INDEX IF EXISTS uq_gmail_invoice_scans_msg_att;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gmail_invoice_scans_msg_key
  ON gmail_invoice_scans (tenant_id, gmail_message_id, COALESCE(attachment_key, ''));
