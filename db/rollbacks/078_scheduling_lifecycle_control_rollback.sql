-- Rollback 078 intentionally preserves scheduling evidence and lifecycle data.
-- It only disables the command boundary. Table removal requires a separately
-- approved, evidence-empty destructive migration.

DROP FUNCTION IF EXISTS public.appointment_lifecycle_command_rpc(
  uuid, uuid, text, bigint, text, text, text, text, text, jsonb,
  boolean, timestamptz, text
);
DROP FUNCTION IF EXISTS public.scheduling_lifecycle_kill_switch_rpc(uuid, text);

UPDATE public.scheduling_automation_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       updated_at = now()
 WHERE enabled = true
    OR execution_mode <> 'disabled'
    OR kill_switch_engaged = false;
