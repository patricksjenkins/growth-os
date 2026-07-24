\set ON_ERROR_STOP on

-- Reproduce the previously released migration-068 shape in an ephemeral CI
-- database. Migration 073 must upgrade this shape without replacing the table.
DROP INDEX IF EXISTS public.idx_work_items_tenant_open;
DROP INDEX IF EXISTS public.idx_work_items_tenant_open_ranked;
ALTER TABLE public.work_items DROP COLUMN IF EXISTS priority_rank;
CREATE INDEX idx_work_items_tenant_open
  ON public.work_items (tenant_id, priority, due_at, created_at DESC)
  WHERE status NOT IN ('verified', 'dismissed', 'cancelled');

DROP POLICY IF EXISTS tenant_iso_work_items ON public.work_items;
CREATE POLICY tenant_iso_work_items
  ON public.work_items FOR SELECT TO authenticated
  USING (
    tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
    AND auth.jwt()->'app_metadata'->>'role'
      IN ('owner', 'platform_owner', 'founder', 'admin')
  );

DROP POLICY IF EXISTS tenant_iso_work_item_events ON public.work_item_events;
CREATE POLICY tenant_iso_work_item_events
  ON public.work_item_events FOR SELECT TO authenticated
  USING (
    tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
    AND auth.jwt()->'app_metadata'->>'role'
      IN ('owner', 'platform_owner', 'founder', 'admin')
  );

DROP POLICY IF EXISTS tenant_iso_work_item_audit_log
  ON public.work_item_audit_log;
CREATE POLICY tenant_iso_work_item_audit_log
  ON public.work_item_audit_log FOR SELECT TO authenticated
  USING (
    tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
    AND auth.jwt()->'app_metadata'->>'role'
      IN ('owner', 'platform_owner', 'founder', 'admin')
  );

REVOKE SELECT ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
FROM authenticated;
