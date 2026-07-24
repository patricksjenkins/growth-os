-- Operator-invoked, data-preserving rollback for migration 074.
-- Disable the application flag first. Evidence-bearing tables are removed only
-- when they are empty; existing recovery history must be exported and retained.

DO $$
BEGIN
  IF (
    to_regclass('public.incident_reconciliation_events') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.incident_reconciliation_events LIMIT 1
    )
  ) OR (
    to_regclass('public.incident_work_item_links') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.incident_work_item_links LIMIT 1
    )
  ) THEN
    RAISE EXCEPTION
      'incident reconciliation evidence exists; retain/export evidence instead of dropping tables';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.incident_recovery_reconcile_rpc(
  uuid, uuid, uuid, integer, text, text, text, text, text,
  text, text, timestamptz, boolean
);

DROP TRIGGER IF EXISTS trg_incident_reconciliation_events_immutable
  ON public.incident_reconciliation_events;
DROP TRIGGER IF EXISTS trg_incident_work_item_links_immutable
  ON public.incident_work_item_links;
DROP TRIGGER IF EXISTS trg_incident_work_item_link_tenant_guard
  ON public.incident_work_item_links;
DROP FUNCTION IF EXISTS public.incident_work_item_link_tenant_guard();
DROP TABLE IF EXISTS public.incident_reconciliation_events;
DROP TABLE IF EXISTS public.incident_work_item_links;
