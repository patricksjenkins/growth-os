-- ─────────────────────────────────────────────────────────────────────
-- 058_lead_suppressions.sql — central lead/contact-level suppression layer
--
-- ONE source of truth for "do not contact this person/company", augmenting
-- (never replacing) the existing per-channel suppression that already works:
--   - drip_suppressions      (email, drip campaign only)
--   - customers.do_not_*     (Outreach Center only)
--   - referral_partners / commercial_prospects flags
-- Those keep functioning unchanged. This table fills the gaps they don't
-- cover — lead-level do-not-contact, competitor, and bad-fit — and gives the
-- Growth Engine's canEnroll()/isSuppressed() helpers a single place to read.
--
-- Strictly additive. RLS tenant isolation mirrors 047_targeted_campaigns.sql.
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  email TEXT,                                   -- lower-cased on write
  phone TEXT,                                   -- last-10-digits, normalized on write
  domain TEXT,                                  -- bare host, normalized on write
  company_name TEXT,                            -- for company-level blocks
  reason TEXT NOT NULL,                         -- do_not_email | do_not_text | do_not_contact
                                                -- | unsubscribed | bounced | bad_contact
                                                -- | competitor | bad_fit | not_interested | owner_blocked
  channel TEXT NOT NULL DEFAULT 'all',          -- email | sms | all
  source TEXT,                                  -- where it came from (owner_ui, reply_classification, ...)
  note TEXT,
  created_by TEXT DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active suppression per (tenant, email) and per (tenant, phone) — re-adding
-- is an upsert, not a duplicate. Partial so NULL contact fields don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_suppr_email
  ON lead_suppressions(tenant_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_suppr_phone
  ON lead_suppressions(tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_suppr_lead   ON lead_suppressions(tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_suppr_domain ON lead_suppressions(tenant_id, domain) WHERE domain IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- RLS — tenant isolation (same pattern as 047).
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_suppressions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_iso_' || t
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        'tenant_iso_' || t, t
      );
    END IF;
  END LOOP;
END $$;
