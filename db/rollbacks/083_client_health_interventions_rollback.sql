-- Rollback 083 intentionally preserves all client-health signal, intervention,
-- action, and outcome evidence. It removes mutation paths and engages the
-- containment boundary while leaving records readable for audit.

UPDATE public.client_health_automation_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       revision = revision + 1,
       updated_at = now();

DROP FUNCTION IF EXISTS public.client_health_signal_snapshot_rpc(
  uuid, uuid, uuid, text, text, jsonb, jsonb, text, text, text, text,
  text, bigint, boolean
);
DROP FUNCTION IF EXISTS public.client_health_intervention_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, text, text, jsonb,
  bigint, boolean, uuid, uuid, uuid, timestamptz, jsonb, text, text
);
DROP FUNCTION IF EXISTS public.client_health_kill_switch_rpc(
  uuid, bigint, text
);

REVOKE INSERT, UPDATE, DELETE ON
  public.client_health_automation_controls,
  public.client_health_signal_snapshots,
  public.client_health_interventions,
  public.client_health_intervention_events
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE: immutable evidence survives rollback.
