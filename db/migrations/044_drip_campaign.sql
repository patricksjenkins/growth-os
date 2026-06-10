-- 044_drip_campaign.sql
-- Automated email drip-campaign system (2026-06-09).
--
-- Campaign Day 1 = the SUCCESSFUL send timestamp of the user-approved initial
-- outreach email (set inside sendEmailOutreachSequence). Follow-ups fire on
-- Days 7/17/30/45/60/90/120/150/180. A genuine reply stops the campaign and
-- moves the prospect to Replied; after a successful Day 60 send with no reply
-- the lead moves to Long-Term Follow-Up; after Day 180 to No Response.
--
-- Tables:
--   drip_campaigns        campaign shell + versioning + activation state
--   drip_campaign_steps   the 9 touch-point templates (per campaign version)
--   drip_enrollments      one active enrollment per lead, scheduling cursor
--   drip_sends            one row per touch-point send attempt (idempotent)
--   drip_inbound          Gmail-synced inbound emails + classification audit
--   drip_coupons          per-prospect Stripe promotion codes (Day 30 offer)
--   drip_suppressions     unsubscribed / bounced addresses — never email again

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drip_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Prospect Drip Campaign',
  -- 'draft' | 'pending_approval' | 'active' | 'paused' | 'archived'
  status TEXT NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  -- previous version this one was cloned from (edit-after-activate flow)
  source_campaign_id UUID REFERENCES drip_campaigns(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_by TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drip_campaigns_tenant ON drip_campaigns(tenant_id, status);

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drip_campaign_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES drip_campaigns(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 7 | 17 | 30 | 45 | 60 | 90 | 120 | 150 | 180
  day_offset INT NOT NULL,
  -- strategic purpose label, e.g. 'helpful_follow_up', 'first_month_free_offer'
  purpose TEXT NOT NULL,
  subject_template TEXT NOT NULL DEFAULT '',
  body_html_template TEXT NOT NULL DEFAULT '',
  -- 'draft' | 'approved'
  status TEXT NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  edited_by_user BOOLEAN NOT NULL DEFAULT false,
  -- model, prompt notes, sources consulted, generation timestamp
  generation_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, day_offset)
);

CREATE INDEX IF NOT EXISTS idx_drip_steps_campaign ON drip_campaign_steps(campaign_id, day_offset);

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drip_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES drip_campaigns(id) ON DELETE CASCADE,
  campaign_version INT NOT NULL DEFAULT 1,
  -- 'active' | 'paused' | 'review' | 'replied' | 'unsubscribed' | 'bounced'
  -- | 'stopped' | 'completed' (post-Day-180 -> lead status no_response)
  status TEXT NOT NULL DEFAULT 'active',
  -- Campaign Day 1: timestamp of the SUCCESSFUL approved initial send
  day1_at TIMESTAMPTZ NOT NULL,
  -- scheduling cursor: which touch point fires next and when
  next_step_day INT,
  next_send_at TIMESTAMPTZ,
  -- pause bookkeeping (OOO auto-pause stores the detected return date)
  paused_reason TEXT,
  paused_until TIMESTAMPTZ,
  stopped_reason TEXT,
  stopped_by TEXT,
  -- reply matching
  gmail_thread_id TEXT,
  last_inbound_at TIMESTAMPTZ,
  -- migration of pre-existing prospects: at most one catch-up touch
  catch_up_used BOOLEAN NOT NULL DEFAULT false,
  enrolled_by TEXT NOT NULL DEFAULT 'system',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one live enrollment per lead at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_drip_enrollments_active_lead
  ON drip_enrollments(lead_id)
  WHERE status IN ('active', 'paused', 'review');
CREATE INDEX IF NOT EXISTS idx_drip_enrollments_due
  ON drip_enrollments(tenant_id, status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_drip_enrollments_lead ON drip_enrollments(lead_id);

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drip_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  enrollment_id UUID NOT NULL REFERENCES drip_enrollments(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  step_id UUID REFERENCES drip_campaign_steps(id) ON DELETE SET NULL,
  day_offset INT NOT NULL,
  -- 'scheduled' | 'sending' | 'sent' | 'failed' | 'skipped'
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  resend_id TEXT,
  -- rendered (post-personalization) content actually sent — audit trail
  subject TEXT,
  body_html TEXT,
  error TEXT,
  skip_reason TEXT,
  attempts INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a touch point can complete at most once per enrollment
  UNIQUE (enrollment_id, day_offset)
);

CREATE INDEX IF NOT EXISTS idx_drip_sends_tenant ON drip_sends(tenant_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_drip_sends_lead ON drip_sends(lead_id, day_offset);

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drip_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  enrollment_id UUID REFERENCES drip_enrollments(id) ON DELETE SET NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT,
  from_address TEXT,
  subject TEXT,
  snippet TEXT,
  received_at TIMESTAMPTZ,
  -- 'genuine_reply' | 'out_of_office' | 'bounce' | 'auto_reply'
  -- | 'unsubscribe_request' | 'ambiguous'
  classification TEXT,
  confidence NUMERIC,
  classification_reason TEXT,
  -- 'deterministic' | 'ai'
  classified_by TEXT,
  -- what the system did: 'stopped_campaign' | 'paused_ooo' | 'bounced_stop'
  -- | 'suppressed' | 'queued_for_review' | 'ignored'
  action_taken TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  review_decision TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, gmail_message_id)
);

CREATE INDEX IF NOT EXISTS idx_drip_inbound_review
  ON drip_inbound(tenant_id, classification) WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_drip_inbound_lead ON drip_inbound(lead_id);

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drip_coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES drip_enrollments(id) ON DELETE SET NULL,
  stripe_coupon_id TEXT,
  stripe_promotion_code_id TEXT,
  -- the human-visible code, e.g. FGA-ACME-7G2K
  code TEXT NOT NULL,
  -- Campaign Day 90
  expires_at TIMESTAMPTZ NOT NULL,
  max_redemptions INT NOT NULL DEFAULT 1,
  -- 'active' | 'expired' | 'redeemed' | 'revoked'
  status TEXT NOT NULL DEFAULT 'active',
  redeemed_at TIMESTAMPTZ,
  redeemed_session_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id)
);

CREATE INDEX IF NOT EXISTS idx_drip_coupons_code ON drip_coupons(code);

-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drip_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  -- 'unsubscribe_link' | 'unsubscribe_header' | 'reply_request' | 'bounce' | 'manual'
  reason TEXT NOT NULL,
  source TEXT,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_drip_suppressions_email ON drip_suppressions(tenant_id, email);

-- ---------------------------------------------------------------------------
-- RLS: same tenant-isolation pattern as the rest of the schema. The admin API
-- and worker use the service client (bypasses RLS); these policies protect
-- any anon/tenant-scoped access path.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'drip_campaigns', 'drip_campaign_steps', 'drip_enrollments',
    'drip_sends', 'drip_inbound', 'drip_coupons', 'drip_suppressions'
  ] LOOP
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
