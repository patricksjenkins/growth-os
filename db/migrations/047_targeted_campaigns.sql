-- 047_targeted_campaigns.sql
-- Targeted Campaign Prospecting Agent (2026-06-11).
--
-- A second, fully separate prospecting workflow: owner-defined, opportunity-
-- driven campaigns (e.g. "Florida pool-opening season") with their own
-- audience rules, messaging variants, pilot batch, daily batches, hard lead
-- goal, and per-campaign budget/API caps. Completely independent from the
-- standard prospecting agent's weekly-50 system — targeted leads use
-- lead_source='targeted_campaign_agent' so they never count toward the
-- standard agent's countQualifiedThisWeek() (which filters
-- lead_source='prospecting_agent').
--
-- The shared `leads` table stays the single source of truth for businesses;
-- campaign membership rows LINK leads to campaigns (including duplicates that
-- already existed) instead of duplicating lead records.

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaigns — one row per campaign (current working config).
-- Full config snapshots per edit live in targeted_campaign_versions.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Lifecycle status (snake_case):
  -- draft | strategy_review | messaging_review | ready_for_pilot |
  -- pilot_running | pilot_awaiting_approval | approved_to_continue | active |
  -- paused | audience_exhausted | budget_limit_reached | api_limit_reached |
  -- completed | cancelled | archived | failed
  status TEXT NOT NULL DEFAULT 'draft',
  -- Wizard step payloads (jsonb so the wizard can evolve without migrations):
  opportunity JSONB NOT NULL DEFAULT '{}',     -- { description, why_now, window_start, window_end }
  audience JSONB NOT NULL DEFAULT '{}',        -- { states[], industries[], employee_min, employee_max, website_rule: 'no_website'|'allow_any'|'require_website', excluded_keywords[] }
  qualification JSONB NOT NULL DEFAULT '{}',   -- { fit_score_threshold, require_phone, notes }
  solution JSONB NOT NULL DEFAULT '{}',        -- { modules[], pitch_angle }
  messaging JSONB NOT NULL DEFAULT '{}',       -- { strategy, follow_up_days }
  -- Goals + pacing (hard caps):
  goal_qualified INTEGER NOT NULL DEFAULT 100,   -- hard campaign goal — no lead past this
  pilot_size INTEGER NOT NULL DEFAULT 10,
  daily_batch_cap INTEGER NOT NULL DEFAULT 25,   -- clamped 1..25 in code
  -- Budget / API caps (whole-campaign totals; agent stops + flips status):
  budget JSONB NOT NULL DEFAULT '{}',          -- { max_serper_calls, max_ai_calls, max_apify_calls, max_cost_usd }
  -- Live counters (only mutated by the single locked run / approval routes):
  qualified_count INTEGER NOT NULL DEFAULT 0,        -- outreach-ready (email OR usable FB)
  outreach_ready_email_count INTEGER NOT NULL DEFAULT 0,
  fb_dm_ready_count INTEGER NOT NULL DEFAULT 0,
  candidates_processed INTEGER NOT NULL DEFAULT 0,
  serper_calls_used INTEGER NOT NULL DEFAULT 0,
  ai_calls_used INTEGER NOT NULL DEFAULT 0,
  apify_calls_used INTEGER NOT NULL DEFAULT 0,
  zero_yield_streak INTEGER NOT NULL DEFAULT 0,      -- consecutive batches with 0 new candidates → audience_exhausted
  -- Concurrency: at most ONE discovery run per campaign. Claimed atomically
  -- (UPDATE ... WHERE active_run_id IS NULL); stale locks cleared by age.
  active_run_id UUID,
  active_run_started_at TIMESTAMPTZ,
  current_version INTEGER NOT NULL DEFAULT 1,
  kill_switch BOOLEAN NOT NULL DEFAULT false,        -- campaign-level kill (status also goes paused)
  created_by TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_targeted_campaigns_tenant ON targeted_campaigns(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_targeted_campaigns_status ON targeted_campaigns(tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_versions — immutable config snapshot per edit/approval.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL DEFAULT '{}',
  created_by TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, version)
);
CREATE INDEX IF NOT EXISTS idx_tc_versions_campaign ON targeted_campaign_versions(campaign_id, version DESC);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_variants — messaging: 1 strategy (on campaign.messaging)
-- + 3 variants (A/B/C). Each variant carries email + FB DM + follow-up
-- templates with {{placeholders}} rendered per-lead at draft time (no AI
-- call per lead — variants are written/AI-assisted ONCE during the wizard).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                          -- 'A' | 'B' | 'C'
  email_subject TEXT,
  email_body TEXT,                              -- plain text w/ {{first_name}} {{company}} {{city}} {{industry}}
  fb_dm_body TEXT,
  follow_up_body TEXT,
  status TEXT NOT NULL DEFAULT 'draft',         -- 'draft' | 'approved'
  assigned_count INTEGER NOT NULL DEFAULT 0,    -- round-robin bookkeeping
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, label)
);
CREATE INDEX IF NOT EXISTS idx_tc_variants_campaign ON targeted_campaign_variants(campaign_id);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_batches — pilot + daily batches.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  batch_number INTEGER NOT NULL,
  batch_type TEXT NOT NULL DEFAULT 'daily',     -- 'pilot' | 'daily'
  batch_date DATE NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  target_count INTEGER NOT NULL DEFAULT 0,
  qualified_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',       -- 'running' | 'completed' | 'failed'
  stats JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (campaign_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_tc_batches_campaign ON targeted_campaign_batches(campaign_id, batch_number DESC);
-- One DAILY batch per campaign per ET day (pilot exempt).
CREATE UNIQUE INDEX IF NOT EXISTS uq_tc_batches_daily_per_day
  ON targeted_campaign_batches(campaign_id, batch_date) WHERE batch_type = 'daily';

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_runs — one row per agent execution (a run produces or
-- continues exactly one batch).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES targeted_campaign_batches(id) ON DELETE SET NULL,
  run_type TEXT NOT NULL DEFAULT 'daily',       -- 'pilot' | 'daily'
  status TEXT NOT NULL DEFAULT 'running',       -- 'running' | 'completed' | 'failed'
  stop_reason TEXT,
  stats JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tc_runs_campaign ON targeted_campaign_runs(campaign_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_memberships — links leads to campaigns. Duplicate
-- businesses found by a campaign LINK to the existing lead row
-- (is_existing_lead=true) — we never create a second lead record.
-- candidate_key is the idempotency key from the structured handoff contract.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  batch_id UUID REFERENCES targeted_campaign_batches(id) ON DELETE SET NULL,
  run_id UUID REFERENCES targeted_campaign_runs(id) ON DELETE SET NULL,
  variant_id UUID REFERENCES targeted_campaign_variants(id) ON DELETE SET NULL,
  candidate_key TEXT NOT NULL,                  -- idempotency key (campaign+company/domain/phone hash)
  campaign_version INTEGER NOT NULL DEFAULT 1,
  campaign_fit_score INTEGER,                   -- campaign-specific fit (separate from general score)
  general_score INTEGER,                        -- standard qualification-style score
  contact_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'outreach_ready_email' | 'fb_dm_ready' | 'not_ready'
  is_existing_lead BOOLEAN NOT NULL DEFAULT false,
  outcome JSONB NOT NULL DEFAULT '{}',          -- { email_sequence_id, fb_conversation_id, enrich_reason }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id),
  UNIQUE (campaign_id, candidate_key)
);
CREATE INDEX IF NOT EXISTS idx_tc_memberships_campaign ON targeted_campaign_memberships(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tc_memberships_lead ON targeted_campaign_memberships(lead_id);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_approvals — explicit human gates (strategy, messaging,
-- pilot launch, pilot result, continue-to-full).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,                          -- 'strategy' | 'messaging' | 'launch_pilot' | 'pilot_result' | 'continue'
  decision TEXT NOT NULL,                       -- 'approved' | 'rejected'
  decided_by TEXT DEFAULT 'admin',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tc_approvals_campaign ON targeted_campaign_approvals(campaign_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_usage — append-only per-run provider usage ledger.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  run_id UUID REFERENCES targeted_campaign_runs(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,                       -- 'serper' | 'anthropic' | 'apify'
  calls INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tc_usage_campaign ON targeted_campaign_usage(campaign_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_activity — campaign audit trail (status changes,
-- approvals, runs, kill switches, edits).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES targeted_campaigns(id) ON DELETE CASCADE,
  actor TEXT DEFAULT 'system',
  action TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tc_activity_campaign ON targeted_campaign_activity(campaign_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- targeted_campaign_recommendations — agent-proposed campaign opportunities.
-- NEVER auto-executed; owner accepts (creates a draft) or dismisses.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS targeted_campaign_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  rationale TEXT,
  suggested_config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'proposed',      -- 'proposed' | 'accepted' | 'dismissed'
  campaign_id UUID REFERENCES targeted_campaigns(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tc_recommendations_tenant ON targeted_campaign_recommendations(tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────
-- RLS — tenant isolation on every table (same pattern as 043).
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'targeted_campaigns','targeted_campaign_versions','targeted_campaign_variants',
    'targeted_campaign_batches','targeted_campaign_runs','targeted_campaign_memberships',
    'targeted_campaign_approvals','targeted_campaign_usage','targeted_campaign_activity',
    'targeted_campaign_recommendations'
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
