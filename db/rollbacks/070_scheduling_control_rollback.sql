-- Operator-invoked rollback for migration 070.

DO $$
BEGIN
  IF to_regclass('public.appointment_workflows') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.appointment_workflows LIMIT 1) THEN
    RAISE EXCEPTION
      'appointment data exists; disable scheduling writes and export records instead of dropping tables';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_appointment_events_tenant_guard
  ON public.appointment_events;
DROP FUNCTION IF EXISTS public.appointment_events_tenant_guard();
DROP TRIGGER IF EXISTS trg_appointment_workflows_tenant_guard
  ON public.appointment_workflows;
DROP FUNCTION IF EXISTS public.appointment_workflows_tenant_guard();
DROP TABLE IF EXISTS public.appointment_events;
DROP TABLE IF EXISTS public.appointment_workflows;
DROP TABLE IF EXISTS public.scheduling_policies;
