-- Rollback 090 contains all Finance Head mutation paths but retains reports,
-- attribution links, cases, and immutable event evidence.

UPDATE public.finance_governance_head_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       updated_at = now();

DROP FUNCTION IF EXISTS public.finance_governance_head_command_rpc(
  uuid, text, uuid, uuid, uuid, date, text, uuid[], text, text, text,
  jsonb, text, text, uuid, uuid, timestamptz, jsonb, text, text,
  bigint, text, text, text, text, jsonb, boolean
);
DROP FUNCTION IF EXISTS
  public.finance_governance_head_kill_switch_rpc(uuid, text);
DROP FUNCTION IF EXISTS
  public.finance_governance_evidence_is_minimized(jsonb);
DROP FUNCTION IF EXISTS
  public.finance_governance_report_metadata_is_minimized(jsonb);
DROP FUNCTION IF EXISTS
  public.finance_governance_case_contract_is_minimized(text, jsonb);
DROP FUNCTION IF EXISTS
  public.finance_governance_json_has_forbidden_key(jsonb);

REVOKE INSERT, UPDATE, DELETE ON
  public.finance_governance_head_controls,
  public.finance_governance_head_reports,
  public.finance_governance_report_attributions,
  public.finance_governance_head_cases,
  public.finance_governance_head_events
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE: evidence survives rollback.
