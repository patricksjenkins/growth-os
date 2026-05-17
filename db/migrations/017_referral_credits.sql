-- Migration 017: referral_credits
--
-- Tracks referral attribution + payout queue for Module 10 (Referral Engine).
-- When a customer (the referrer) sends a friend who becomes a paying lead
-- (the referee), a row goes into this table. When the referee's job closes,
-- the row gets marked owed → paid.
--
-- Sales claim 10.4: "Tags referred leads with referrer's name"
--   Implementation: referrer_lead_id + referee_lead_id link the two.
-- Sales claim 10.5: "Queues payout when referred job closes"
--   Implementation: status='pending' until referee status=won, then
--   referral-request agent's payout sweep flips to 'owed'. Manual
--   acknowledgement (cash/credit handed over) flips to 'paid'.
-- Sales claim 10.6: "Referral leaderboard view"
--   Implementation: GET /api/admin/referrals returns aggregated counts
--   per referrer (total referred, won, $ owed) for ranking.

CREATE TABLE IF NOT EXISTS referral_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The original happy customer who referred someone in
  referrer_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  -- The new lead that came in because of the referrer
  referee_lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  -- Snapshot of bonus amount at attribution time (tenant.referral_bonus
  -- may change later; preserve the promised amount)
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  -- Lifecycle:
  --   pending  — referee created, job not yet closed
  --   owed     — referee status flipped to won, payout owed to referrer
  --   paid     — owner marked it paid (cash, credit, gift, whatever)
  --   void     — referee status flipped to lost, no credit owed
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT, -- e.g. 'manual', 'sms_link', 'chat_marker'
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  owed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referral_credits_tenant ON referral_credits(tenant_id);
CREATE INDEX IF NOT EXISTS idx_referral_credits_referrer ON referral_credits(tenant_id, referrer_lead_id);
CREATE INDEX IF NOT EXISTS idx_referral_credits_referee ON referral_credits(tenant_id, referee_lead_id);
CREATE INDEX IF NOT EXISTS idx_referral_credits_status ON referral_credits(tenant_id, status);

ALTER TABLE referral_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_referral_credits ON referral_credits FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
