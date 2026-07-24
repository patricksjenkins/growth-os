-- Rollback 084 contains lead-action automation without destroying evidence.
-- Existing action rows and immutable receipts remain available for audit.

UPDATE public.lead_action_automation_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       updated_at = now();

DROP FUNCTION IF EXISTS public.lead_action_command_rpc(
  uuid, uuid, uuid, text, text, bigint, text, text, text, text, text,
  jsonb, boolean, text, text, timestamptz, timestamptz, text, text,
  text, text, text, text, text, text, text
);
DROP FUNCTION IF EXISTS public.lead_action_kill_switch_rpc(uuid, text);

REVOKE INSERT, UPDATE, DELETE ON
  public.lead_action_automation_controls,
  public.lead_actions,
  public.lead_action_receipts
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE or DROP VIEW: immutable evidence and cohort
-- interpretation survive rollback while every write path is disabled.
