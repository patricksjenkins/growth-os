-- 057_ops_incidents.sql
-- Operations Guardian — agent-level incident ledger.
--
-- The system already has DEPENDENCY-level monitoring (platform_health_checks +
-- system-monitor) and per-agent run rollups (admin-agent-hub). What was missing
-- is a durable record of AGENT-level incidents: an agent failing repeatedly, a
-- daily agent that stopped running, or an agent that "succeeds" but produces no
-- business output. This table is that record. It also tracks what automatic
-- remediation was attempted and whether the agent recovered, so a recurring
-- outage (prospecting was down 6 days) is impossible to miss.
--
-- Platform/admin-only data: RLS is enabled with NO policy, so only the
-- service-role key (used by the worker + admin API) can read/write it. Same
-- posture as the other global platform tables locked down in migration 049.

CREATE TABLE IF NOT EXISTS public.ops_incidents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid,                        -- platform/FGA tenant; nullable for global
  agent_name               text NOT NULL,
  issue_type               text NOT NULL,               -- no_successful_run | consecutive_failures | repeated_error | zero_output | stuck_jobs | rate_limit | cost_spike | healthy_no_output
  severity                 text NOT NULL DEFAULT 'amber',  -- red | amber | info
  status                   text NOT NULL DEFAULT 'open',   -- open | remediating | awaiting_approval | recovered | escalated
  permission_level         smallint NOT NULL DEFAULT 1,    -- 1 auto-fix | 2 approval-required | 3 escalate-only

  business_impact          text,
  error_signature          text,                        -- normalized short signature (used for dedup + "same error repeats")
  latest_error             text,
  diagnosis_summary        text,                        -- rules-based likely root cause (NOT LLM-generated)

  remediation_attempted    jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{at, action, level, result}]
  remediation_result       text,                        -- latest remediation outcome summary
  attempt_count            int NOT NULL DEFAULT 0,       -- auto-remediation attempts so far (circuit breaker)
  last_attempt_at          timestamptz,                 -- for cooldown enforcement

  requires_owner_approval  boolean NOT NULL DEFAULT false,
  approval_reason          text,
  attention_queue_id       uuid,                        -- link to the attention_queue item, if escalated

  links_to_logs            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {agent_hub, recent_jobs, ...}
  affected_jobs            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [job_id, ...]
  verification_result      text,                        -- recovered | still_failing | pending

  detected_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- One OPEN incident per (agent, issue_type). The guardian upserts against this
-- so a persistent problem updates the same row instead of spawning duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS ops_incidents_open_uniq
  ON public.ops_incidents (agent_name, issue_type)
  WHERE status IN ('open', 'remediating', 'awaiting_approval');

CREATE INDEX IF NOT EXISTS ops_incidents_status_idx   ON public.ops_incidents (status);
CREATE INDEX IF NOT EXISTS ops_incidents_detected_idx ON public.ops_incidents (detected_at DESC);

-- Platform/admin-only: lock the table to the service-role key.
ALTER TABLE public.ops_incidents ENABLE ROW LEVEL SECURITY;
