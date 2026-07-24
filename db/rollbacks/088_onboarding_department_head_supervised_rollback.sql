-- Rollback 088 removes supervised mutation paths while preserving accepted
-- reports, goals, work, decisions, exceptions, events, and evidence.

UPDATE public.onboarding_head_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       revision = revision + 1,
       updated_at = now();

DROP FUNCTION IF EXISTS public.onboarding_head_report_rpc(
  uuid, uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, text,
  boolean, jsonb, jsonb, jsonb, text, text, text, text, text, bigint, boolean
);
DROP FUNCTION IF EXISTS public.onboarding_customer_outcome_receipt_rpc(
  uuid, uuid, uuid, uuid, text, text, timestamptz, text, text, text, text
);
DROP FUNCTION IF EXISTS public.onboarding_head_case_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, text, text, jsonb, bigint,
  boolean, uuid, uuid, uuid, timestamptz, text, jsonb, text, text, uuid, text
);
DROP FUNCTION IF EXISTS public.onboarding_head_kill_switch_rpc(
  uuid, bigint, text
);
DROP FUNCTION IF EXISTS public.onboarding_head_validate_actor(
  uuid, text, text, text, text
);

REVOKE INSERT, UPDATE, DELETE ON
  public.onboarding_head_controls,
  public.onboarding_customer_outcome_receipts,
  public.onboarding_head_reports,
  public.onboarding_head_cases,
  public.onboarding_head_events
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE: immutable onboarding evidence survives rollback.
