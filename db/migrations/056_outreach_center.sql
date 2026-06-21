-- 056_outreach_center.sql
-- A Kut Above "Outreach Center": one connected system for Review Requests,
-- Quote Follow-Up, Referral Partner outreach, and Commercial Property outreach.
--
-- Design notes:
--  * Tenant-scoped, additive. All new tables get the JWT app_metadata RLS used by
--    customers/jobs/customer_reviews so the portal user client can read/write them.
--  * Quotes reuse the existing `jobs` table (status-driven) — no quotes table.
--  * SMS RULE (owner directive): texts only go to contacts tied to a COMPLETED job.
--    Enforced in core/outreach.js (canText), not in schema, but enrollments carry a
--    text_eligible snapshot for the UI.
--  * Reviews flow through this unified engine (customer_reviews stays for legacy
--    status but the live send path is outreach_enrollments/messages). AKA has 0
--    review rows today, so there is nothing to migrate.

-- ---------------------------------------------------------------------------
-- Contact-level safety flags on customers (Do Not Contact rules)
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS do_not_text      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS do_not_email     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS do_not_contact   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS do_not_ask_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS unsubscribed     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bad_contact      BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- outreach_templates — editable, versioned message templates per type/step
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  outreach_type TEXT NOT NULL,            -- review | quote | referral_partner | commercial
  step_index    INT  NOT NULL,           -- 1-based touch number
  day_offset    INT  NOT NULL,           -- days after enrollment day 1
  channel       TEXT NOT NULL DEFAULT 'email', -- email | sms  (one row per channel)
  subject       TEXT,                    -- email subject ({{tokens}})
  body          TEXT NOT NULL,           -- body ({{tokens}})
  label         TEXT,                    -- human label e.g. "Day 7 follow-up"
  version       INT  NOT NULL DEFAULT 1,
  active        BOOLEAN NOT NULL DEFAULT true,
  is_default    BOOLEAN NOT NULL DEFAULT true,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outreach_templates_lookup
  ON outreach_templates (tenant_id, outreach_type, step_index, channel) WHERE active;

-- ---------------------------------------------------------------------------
-- referral_partners — real-estate / insurance agents (cold, EMAIL ONLY)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_partners (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  name           TEXT,
  company        TEXT,
  partner_type   TEXT NOT NULL DEFAULT 'real_estate', -- real_estate | insurance
  email          TEXT,
  phone          TEXT,
  website        TEXT,
  city           TEXT,
  source_url     TEXT,
  notes          TEXT,
  confidence     NUMERIC,
  outreach_status TEXT NOT NULL DEFAULT 'new', -- new | drafted | active | replied | stopped | do_not_contact
  do_not_contact BOOLEAN NOT NULL DEFAULT false,
  unsubscribed   BOOLEAN NOT NULL DEFAULT false,
  candidate_key  TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_partners_candidate
  ON referral_partners (tenant_id, candidate_key) WHERE candidate_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referral_partners_tenant
  ON referral_partners (tenant_id, outreach_status);

-- ---------------------------------------------------------------------------
-- commercial_prospects — property owners/managers/communities (cold, EMAIL ONLY)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commercial_prospects (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  name           TEXT,                    -- property / company name
  contact_person TEXT,
  prospect_type  TEXT NOT NULL DEFAULT 'property_manager',
  email          TEXT,
  phone          TEXT,
  website        TEXT,
  address        TEXT,
  city           TEXT,
  source_url     TEXT,
  notes          TEXT,
  confidence     NUMERIC,
  outreach_status TEXT NOT NULL DEFAULT 'new',
  do_not_contact BOOLEAN NOT NULL DEFAULT false,
  unsubscribed   BOOLEAN NOT NULL DEFAULT false,
  candidate_key  TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commercial_prospects_candidate
  ON commercial_prospects (tenant_id, candidate_key) WHERE candidate_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commercial_prospects_tenant
  ON commercial_prospects (tenant_id, outreach_status);

-- ---------------------------------------------------------------------------
-- outreach_enrollments — the unified engine. One row = one recipient enrolled
-- in one outreach type's cadence. Links to whichever subject applies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_enrollments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  outreach_type TEXT NOT NULL,           -- review | quote | referral_partner | commercial
  -- connections to existing data (only one of these is set per type)
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  job_id                UUID REFERENCES jobs(id) ON DELETE SET NULL,
  referral_partner_id   UUID REFERENCES referral_partners(id) ON DELETE CASCADE,
  commercial_prospect_id UUID REFERENCES commercial_prospects(id) ON DELETE CASCADE,
  -- denormalized contact snapshot (so sending + channel logic is self-contained)
  contact_name   TEXT,
  contact_email  TEXT,
  contact_phone  TEXT,
  -- lifecycle
  status        TEXT NOT NULL DEFAULT 'active',
  -- active | paused | stopped | completed | needs_review | missing_contact
  cadence       TEXT NOT NULL DEFAULT 'standard',  -- light | standard | aggressive | custom
  cadence_days  INT[] ,                  -- explicit day offsets when custom/derived
  current_step  INT  NOT NULL DEFAULT 1,
  next_send_at  TIMESTAMPTZ,
  channel_pref  TEXT NOT NULL DEFAULT 'auto', -- auto | email | sms | both
  text_eligible BOOLEAN NOT NULL DEFAULT false, -- has a completed job (snapshot)
  paused_reason  TEXT,
  stopped_reason TEXT,
  replied_at     TIMESTAMPTZ,
  last_sent_at   TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by    TEXT NOT NULL DEFAULT 'owner',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- only one ACTIVE-ish enrollment per (type, subject). Use a coalesced subject key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_enroll_review
  ON outreach_enrollments (tenant_id, customer_id)
  WHERE outreach_type='review' AND status IN ('active','paused','needs_review','missing_contact');
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_enroll_quote
  ON outreach_enrollments (tenant_id, job_id)
  WHERE outreach_type='quote' AND status IN ('active','paused','needs_review','missing_contact');
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_enroll_partner
  ON outreach_enrollments (tenant_id, referral_partner_id)
  WHERE referral_partner_id IS NOT NULL AND status IN ('active','paused','needs_review','missing_contact');
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_enroll_commercial
  ON outreach_enrollments (tenant_id, commercial_prospect_id)
  WHERE commercial_prospect_id IS NOT NULL AND status IN ('active','paused','needs_review','missing_contact');
CREATE INDEX IF NOT EXISTS idx_outreach_enroll_due
  ON outreach_enrollments (tenant_id, status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_outreach_enroll_type
  ON outreach_enrollments (tenant_id, outreach_type, status);

-- ---------------------------------------------------------------------------
-- outreach_messages — one row per touch attempt (draft -> approved -> sent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  enrollment_id UUID NOT NULL REFERENCES outreach_enrollments(id) ON DELETE CASCADE,
  outreach_type TEXT NOT NULL,
  step_index    INT  NOT NULL,
  day_offset    INT  NOT NULL,
  channel       TEXT NOT NULL,           -- email | sms
  to_email      TEXT,
  to_phone      TEXT,
  subject       TEXT,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  -- draft | approved | scheduled | sent | failed | skipped
  scheduled_for TIMESTAMPTZ,
  approved_at   TIMESTAMPTZ,
  approved_by   TEXT,
  sent_at       TIMESTAMPTZ,
  provider_id   TEXT,                    -- resend / telnyx id
  error         TEXT,
  skip_reason   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_msg_step_channel
  ON outreach_messages (enrollment_id, step_index, channel);
CREATE INDEX IF NOT EXISTS idx_outreach_msg_enroll
  ON outreach_messages (enrollment_id, step_index);
CREATE INDEX IF NOT EXISTS idx_outreach_msg_status
  ON outreach_messages (tenant_id, status, scheduled_for);

-- ---------------------------------------------------------------------------
-- RLS — JWT app_metadata tenant isolation (service_role bypasses)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['outreach_templates','referral_partners','commercial_prospects','outreach_enrollments','outreach_messages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_iso_jwt_%I ON %I', t, t);
    EXECUTE format($f$
      CREATE POLICY tenant_iso_jwt_%I ON %I FOR ALL
        USING      (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
        WITH CHECK (auth.role() = 'service_role' OR tenant_id::text = (auth.jwt() -> 'app_metadata' ->> 'tenant_id'))
    $f$, t, t);
  END LOOP;
END $$;
