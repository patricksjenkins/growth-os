-- 046_ai_safety_foundation.sql
-- Layered AI safety system — Release 1 (monitoring only), 2026-06-10.
--
-- BACKWARD-COMPATIBLE / ADDITIVE ONLY. This migration creates NEW tables.
-- It does NOT alter, drop, constrain, or backfill any existing table, and it
-- adds NO unique constraints to existing data (duplicate audit must happen
-- first per the rollout plan). Existing tenants/agents/jobs are untouched and
-- remain fully enabled. Safe to run on a live database.
--
-- ROLLBACK: see 046_ai_safety_foundation_rollback.sql (drops only these new
-- objects; no existing data is affected).
--
-- Tables created:
--   ai_usage_events   — one row per AI provider call (Phase 3 tracking)
--   ai_safety_switches— kill switches + circuit breakers (Phase 6/7)
--   ai_safety_events  — would-block / threshold / alert audit log (Phase 5/13/14)
--   ai_job_batches    — guarded-enqueue batch tracking (Phase 11)

-- ---------------------------------------------------------------------------
-- ai_usage_events: authoritative, persistent per-call usage ledger.
-- Counters (per minute/hour/day, per tenant/agent/job/lead) are derived by
-- querying this table so they survive process restarts and are shared across
-- every Railway replica/process (Phase 12 foundation).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- tenant_id is NULLABLE on purpose: legacy/untracked calls (Phase 3 monitor
  -- mode) still get logged with a NULL tenant rather than being rejected.
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'anthropic',     -- 'anthropic' | 'google'
  model TEXT,
  operation_type TEXT,                            -- e.g. 'outreach_draft', 'chat', 'classification'
  agent_name TEXT,
  job_id UUID,
  lead_id UUID,
  campaign_id UUID,
  campaign_stage TEXT,
  initiated_by TEXT,                              -- user email or 'system'
  is_automated BOOLEAN NOT NULL DEFAULT true,
  request_source TEXT,                            -- best-effort source file/operation
  -- Token + cost accounting (filled post-call; nullable for failures).
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd NUMERIC(12,6),
  -- Per-logical-operation attempt counter (retry-multiplication tracking).
  attempt INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL DEFAULT 'success',        -- 'success' | 'failed'
  error TEXT,
  -- Monitor-mode bookkeeping: was full metadata present?
  untracked BOOLEAN NOT NULL DEFAULT false,       -- true = missing tenant/agent metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_created ON ai_usage_events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_agent_created ON ai_usage_events(agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_job ON ai_usage_events(job_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_lead_created ON ai_usage_events(lead_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- ai_safety_switches: unified store for KILL SWITCHES and CIRCUIT BREAKERS.
--   kind  = 'kill_switch' | 'circuit_breaker'
--   scope = 'global' | 'provider' | 'tenant' | 'agent' | 'job_type'
--   scope_value = the provider/tenant id/agent name/job type ('*' for global)
-- A row's presence + state controls behavior ONLY when the matching
-- enforcement flag is enabled. With enforcement OFF (default) these are pure
-- monitoring/manual records and never block.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_safety_switches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,                             -- 'kill_switch' | 'circuit_breaker'
  scope TEXT NOT NULL,                            -- 'global'|'provider'|'tenant'|'agent'|'job_type'
  scope_value TEXT NOT NULL DEFAULT '*',
  -- state: 'closed' = normal/allowed, 'open' = tripped/blocked (when enforced).
  -- DEFAULT 'closed' guarantees a fresh row never blocks existing operation.
  state TEXT NOT NULL DEFAULT 'closed',
  reason TEXT,
  trigger_detail JSONB DEFAULT '{}'::jsonb,
  auto_reactivate BOOLEAN NOT NULL DEFAULT false,
  opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, scope, scope_value)
);

CREATE INDEX IF NOT EXISTS idx_ai_switches_lookup ON ai_safety_switches(kind, scope, scope_value);

-- Full audit trail of every switch/breaker state change (Phase 7 requirement:
-- previous value, new value, actor, timestamp, reason, scope).
CREATE TABLE IF NOT EXISTS ai_safety_switch_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  switch_id UUID REFERENCES ai_safety_switches(id) ON DELETE SET NULL,
  kind TEXT,
  scope TEXT,
  scope_value TEXT,
  previous_state TEXT,
  new_state TEXT,
  actor TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_switch_audit_created ON ai_safety_switch_audit(created_at DESC);

-- ---------------------------------------------------------------------------
-- ai_safety_events: every threshold breach, would-block decision, duplicate
-- detection, untracked-call flag, large-batch flag, and alert. In monitor
-- mode this is where "what WOULD have been blocked" is recorded.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_safety_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,                       -- 'threshold_exceeded'|'would_block'|'duplicate'|'untracked_call'|'large_batch'|'retry_excess'|'switch_change'|'alert'
  severity TEXT NOT NULL DEFAULT 'info',          -- 'info'|'warning'|'critical'
  rule TEXT,                                       -- which rule/threshold triggered
  scope TEXT,                                      -- 'tenant'|'agent'|'job'|'lead'|'provider'|'global'
  scope_value TEXT,
  enforced BOOLEAN NOT NULL DEFAULT false,        -- false = monitor-only (logged, not blocked)
  agent_name TEXT,
  job_id UUID,
  lead_id UUID,
  detail JSONB DEFAULT '{}'::jsonb,
  -- Alert dedup key + cooldown bookkeeping (Phase 14).
  dedup_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_safety_events_created ON ai_safety_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_safety_events_type ON ai_safety_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_safety_events_dedup ON ai_safety_events(dedup_key, created_at DESC);

-- ---------------------------------------------------------------------------
-- ai_job_batches: a guarded-enqueue batch. A 104-lead backfill becomes ONE
-- row with item_count = 104 (Phase 11), so a burst is visible/cancellable as
-- a unit instead of 104 unrelated jobs that each slip under a per-run limit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_job_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  source TEXT,                                     -- e.g. 'admin_route', 'manual_script', 'enrichment_auto'
  reason TEXT,                                     -- e.g. 'apify_email_one_shot_2026-06-09'
  agent_name TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  -- 'pending_approval' only used when AI_MANUAL_BATCH_APPROVAL_ENABLED is on;
  -- DEFAULT 'open' means batches flow normally with enforcement off.
  status TEXT NOT NULL DEFAULT 'open',             -- 'open'|'pending_approval'|'approved'|'paused'|'cancelled'|'completed'
  flagged_large BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  detail JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_job_batches_tenant_created ON ai_job_batches(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_job_batches_status ON ai_job_batches(status, created_at DESC);

-- Link agent_jobs to a batch WITHOUT altering agent_jobs' existing behavior:
-- a NEW nullable column. Existing inserts that omit it default to NULL and are
-- completely unaffected (no NOT NULL, no FK cascade surprises).
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_agent_jobs_batch ON agent_jobs(batch_id);

-- ---------------------------------------------------------------------------
-- RLS: enable + tenant isolation, matching the 043_outreach_batches pattern.
-- The server uses the service-role client (bypasses RLS) for platform-level
-- safety bookkeeping; these policies protect any tenant-scoped reads.
-- NULL tenant_id rows (untracked/global) are visible only to the service role.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_usage_events','ai_safety_events','ai_job_batches'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_iso_' || t) THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        'tenant_iso_' || t, t
      );
    END IF;
  END LOOP;
END $$;

-- ai_safety_switches + audit are PLATFORM-level (not tenant-scoped); leave RLS
-- off so they behave like other platform tables accessed via service role.
