-- Operator containment for migration 075.
--
-- Disable all work-item write flags before invoking. This rollback removes
-- only the additional guards; it does not mutate or erase work-item data.

DROP TRIGGER IF EXISTS trg_work_item_events_identity_guard
  ON public.work_item_events;
DROP FUNCTION IF EXISTS public.work_item_events_identity_guard();

-- Keep the forward-upgrade release invariant. Migration 072 may already have
-- been applied in its older form, so removing this behavior would revive stale
-- assignment state when an item is reopened.
CREATE OR REPLACE FUNCTION public.work_items_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'open' AND OLD.status <> 'open' THEN
    NEW.assignee_type := 'unassigned';
    NEW.assignee_id := NULL;
    NEW.claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

GRANT SELECT ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
TO service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
FROM service_role;
