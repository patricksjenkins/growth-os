-- Rollback 081 intentionally preserves all finance-close evidence and state.
-- It removes mutation paths, engages containment, and leaves read-only records
-- available for audit/export.

UPDATE public.finance_close_automation_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       updated_at = now();

DROP FUNCTION IF EXISTS public.finance_close_command_rpc(
  uuid, uuid, date, text, text, bigint, text, text, text, text, text,
  jsonb, boolean, uuid, text, uuid, timestamptz, uuid[]
);
DROP FUNCTION IF EXISTS public.finance_close_kill_switch_rpc(uuid, text);

REVOKE INSERT, UPDATE, DELETE ON
  public.finance_close_automation_controls,
  public.finance_close_cycles,
  public.finance_close_exceptions,
  public.finance_close_tasks,
  public.finance_close_events
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE: immutable evidence survives rollback.
