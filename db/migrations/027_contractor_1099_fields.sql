-- ============================================================================
-- Migration 027 — 1099-NEC contractor tracking
--
-- Phase 2 Step 2 of the BI & Financial Sync plan
-- (~/Desktop/FGA/dashboards/bi-sync-strategy.html §3 Phase 2).
--
-- Adds the fields needed to issue a 1099-NEC at year-end to any crew member
-- whose total payments via crew_daily_log exceed $600 in a tax year.
--
-- 1099-NEC requires:
--   - Recipient's legal name (already on crew_members.name)
--   - Recipient's TIN (EIN for businesses, SSN for individuals)
--   - Recipient's address
--   - Total nonemployee compensation paid in box 1
--   - Payer info (FGA's name + EIN — held in tenant_config, not here)
--
-- Encryption-at-rest note: we store tax_id in plaintext today, protected
-- ONLY by row-level security (tenant scope). Real KMS-backed encryption
-- is a Phase 4 polish. Don't expose this column on any public endpoint.
-- ============================================================================

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS is_1099_contractor BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS tax_id TEXT;  -- EIN or SSN (no formatting — digits only)

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS tax_id_kind TEXT CHECK (tax_id_kind IS NULL OR tax_id_kind IN ('ein', 'ssn'));

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS address_line1 TEXT;

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS address_line2 TEXT;

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS city TEXT;

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS state TEXT;

ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS postal_code TEXT;

-- Capture the legal entity name separately if the contractor is a business
-- (so 1099 box "Recipient's name" can use it instead of the crew_members.name
-- which might be a person nickname like "Mike's crew").
ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS legal_business_name TEXT;

COMMENT ON COLUMN crew_members.is_1099_contractor IS
  'TRUE if this person is paid as a 1099-NEC contractor (not a W-2 employee). Drives year-end 1099 generation.';
COMMENT ON COLUMN crew_members.tax_id IS
  'Plaintext EIN (businesses) or SSN (individuals). Protected by RLS only. Required for 1099-NEC if paid $600+ in a tax year.';
COMMENT ON COLUMN crew_members.tax_id_kind IS
  'Either ''ein'' or ''ssn''. Drives which 1099-NEC box to check.';

-- Partial index — only contractors actually need this lookup. Fast index
-- for the 1099 generator's "find all 1099-eligible crew" query.
CREATE INDEX IF NOT EXISTS idx_crew_members_1099_lookup
  ON crew_members (tenant_id, is_1099_contractor)
  WHERE is_1099_contractor = true;
