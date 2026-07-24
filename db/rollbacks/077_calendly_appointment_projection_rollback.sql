-- Operator containment for migration 077.
-- Disable scheduling writes and remove the exact tenant cohort first.
-- Existing appointment and event history is retained.

DROP FUNCTION IF EXISTS public.appointment_provider_event_rpc(
  uuid, text, text, text, text, uuid, timestamptz, timestamptz,
  text, text, boolean
);

DROP TRIGGER IF EXISTS trg_appointment_events_immutable
  ON public.appointment_events;

GRANT SELECT ON
  public.scheduling_policies,
  public.appointment_workflows,
  public.appointment_events
TO service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.scheduling_policies,
  public.appointment_workflows,
  public.appointment_events
FROM service_role;
