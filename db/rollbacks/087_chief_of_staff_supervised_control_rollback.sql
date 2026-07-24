-- Rollback 087 contains the Chief of Staff write plane while retaining all
-- accepted reports, coordination records, and immutable audit evidence.

UPDATE public.cos_supervision_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       updated_at = now();

DROP FUNCTION IF EXISTS public.chief_of_staff_command_rpc(
  uuid, uuid, text, uuid, text, text, text, text, text, uuid, uuid,
  timestamptz, jsonb, date, date, uuid, uuid, bigint, text, text,
  text, text, text, jsonb, boolean
);
DROP FUNCTION IF EXISTS public.cos_report_command_rpc(
  uuid, text, text, uuid, integer, text, uuid, uuid, date, date, text, text,
  jsonb, bigint, text, text, text, text, text, jsonb, boolean
);
DROP FUNCTION IF EXISTS public.cos_assert_service_and_control(uuid, boolean);
DROP FUNCTION IF EXISTS public.cos_kill_switch_rpc(uuid, text);

REVOKE INSERT, UPDATE, DELETE ON
  public.cos_supervision_controls,
  public.department_report_contracts,
  public.department_reports,
  public.cos_coordination_cycles,
  public.cos_coordination_records,
  public.cos_supervised_events
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE: supervised evidence survives rollback.
