-- Operator-invoked rollback for migration 068.
-- Intentionally outside db/migrations so the forward runner cannot execute it.
-- attention_queue is not modified by the forward migration and needs no repair.

DO $$
BEGIN
  IF to_regclass('public.work_items') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.work_items LIMIT 1) THEN
    RAISE EXCEPTION
      'work-item evidence exists; disable control-plane flags and export records instead of dropping tables';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_work_items_audit ON public.work_items;
DROP TRIGGER IF EXISTS trg_work_items_tenant_guard ON public.work_items;
DROP TRIGGER IF EXISTS trg_work_items_set_revision ON public.work_items;
DROP TRIGGER IF EXISTS trg_work_item_events_immutable ON public.work_item_events;
DROP TRIGGER IF EXISTS trg_work_item_audit_immutable ON public.work_item_audit_log;
DROP FUNCTION IF EXISTS public.work_items_audit_trigger();
DROP FUNCTION IF EXISTS public.work_items_tenant_guard();
DROP FUNCTION IF EXISTS public.work_items_set_revision();
DROP FUNCTION IF EXISTS public.autonomous_os_immutable_row();
DROP TABLE IF EXISTS public.work_item_audit_log CASCADE;
DROP TABLE IF EXISTS public.work_item_events CASCADE;
DROP TABLE IF EXISTS public.work_items CASCADE;
