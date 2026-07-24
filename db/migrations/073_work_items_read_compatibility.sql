-- ============================================================================
-- Migration 073: Work-item read compatibility and real owner roles
-- Date: 2026-07-24
--
-- Forward upgrade for databases that may already have applied migration 068
-- before priority_rank, explicit grants, and deployed tenant-owner roles were
-- added. The transaction prevents a visible policy gap.
--
-- ROLLBACK: db/rollbacks/073_work_items_read_compatibility_rollback.sql
-- ============================================================================

BEGIN;

ALTER TABLE public.work_items
  ADD COLUMN IF NOT EXISTS priority_rank smallint
  GENERATED ALWAYS AS (
    CASE priority
      WHEN 'critical' THEN 0
      WHEN 'high' THEN 1
      WHEN 'normal' THEN 2
      ELSE 3
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_work_items_tenant_open_ranked
  ON public.work_items (
    tenant_id, priority_rank, due_at, created_at DESC
  )
  WHERE status NOT IN ('verified', 'dismissed', 'cancelled');

DROP POLICY IF EXISTS tenant_iso_work_items ON public.work_items;
CREATE POLICY tenant_iso_work_items
  ON public.work_items FOR SELECT TO authenticated
  USING (
    tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
    AND auth.jwt()->'app_metadata'->>'role'
      IN (
        'owner', 'platform_owner', 'founder', 'admin',
        'client_owner', 'tenant_owner'
      )
  );

DROP POLICY IF EXISTS tenant_iso_work_item_events ON public.work_item_events;
CREATE POLICY tenant_iso_work_item_events
  ON public.work_item_events FOR SELECT TO authenticated
  USING (
    tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
    AND auth.jwt()->'app_metadata'->>'role'
      IN (
        'owner', 'platform_owner', 'founder', 'admin',
        'client_owner', 'tenant_owner'
      )
  );

DROP POLICY IF EXISTS tenant_iso_work_item_audit_log
  ON public.work_item_audit_log;
CREATE POLICY tenant_iso_work_item_audit_log
  ON public.work_item_audit_log FOR SELECT TO authenticated
  USING (
    tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
    AND auth.jwt()->'app_metadata'->>'role'
      IN (
        'owner', 'platform_owner', 'founder', 'admin',
        'client_owner', 'tenant_owner'
      )
  );

GRANT SELECT ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
FROM authenticated;

COMMIT;
