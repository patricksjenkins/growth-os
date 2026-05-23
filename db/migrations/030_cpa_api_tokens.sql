-- ============================================================================
-- Migration 030 — CPA Read-Only API Tokens
--
-- Stretch Enhancement #12 of the BI & Financial Sync plan
-- (~/Desktop/FGA/dashboards/bi-sync-strategy.html §8 Tier C).
--
-- Long-lived read-only API tokens that a CPA's accounting tool can use
-- to pull transaction data directly — eliminating the email-ZIP-import
-- workflow for tax season.
--
-- Tokens:
--   - Scoped to a specific tax_year (Jan 1 - Dec 31)
--   - Read-only — limited to /api/finance/report/* + /api/finance/audit-log
--   - 60-day TTL after generation (renewable)
--   - Random 32-byte hex (no Supabase JWT, no auth pollution)
-- ============================================================================

CREATE TABLE IF NOT EXISTS cpa_api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,                  -- SHA-256 of the cleartext token; cleartext never stored
  tax_year INTEGER NOT NULL,
  label TEXT NOT NULL,                              -- e.g. "John Smith CPA — Smith & Co" (human-readable)
  created_by UUID,                                  -- auth.users.id of the issuing actor (Patrick)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ
);

COMMENT ON TABLE cpa_api_tokens IS
  'Long-lived read-only API tokens scoped to one tax year. CPA''s accounting tool authenticates with X-FGA-CPA-Token header.';
COMMENT ON COLUMN cpa_api_tokens.token_hash IS
  'SHA-256 hash of the cleartext token. The cleartext is shown to Patrick ONCE at generation and never stored.';

CREATE INDEX IF NOT EXISTS idx_cpa_api_tokens_lookup
  ON cpa_api_tokens (token_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cpa_api_tokens_tenant_active
  ON cpa_api_tokens (tenant_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE cpa_api_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_cpa_tokens ON cpa_api_tokens
  FOR ALL
  USING (current_setting('app.is_admin', true) = 'true' OR tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (current_setting('app.is_admin', true) = 'true' OR tenant_id = current_setting('app.tenant_id', true)::uuid);
