-- Rollback 085 removes supervised command paths while preserving all accepted
-- reports, goals, work, decisions, exceptions, events, and evidence.

UPDATE public.reliability_head_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       revision = revision + 1,
       updated_at = now();

DROP FUNCTION IF EXISTS public.reliability_head_report_rpc(
  uuid, uuid, text, timestamptz, timestamptz, text, text, boolean,
  jsonb, jsonb, jsonb, text, text, text, text, text, bigint, boolean
);
DROP FUNCTION IF EXISTS public.reliability_head_case_command_rpc(
  uuid, uuid, text, bigint, text, text, text, text, text, jsonb, bigint,
  boolean, uuid, uuid, uuid, timestamptz, text, jsonb, text, text, text
);
DROP FUNCTION IF EXISTS public.reliability_head_kill_switch_rpc(
  uuid, bigint, text
);

REVOKE INSERT, UPDATE, DELETE ON
  public.reliability_head_controls,
  public.reliability_head_reports,
  public.reliability_head_cases,
  public.reliability_head_events
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE: immutable executive evidence survives rollback.
