-- Operator containment for migration 073.
--
-- Disable FGA_OS_CONTROL_PLANE_API_ENABLED to roll back behavior. The
-- generated column and expanded tenant-owner read policies are deliberately
-- retained because dropping them would break upgraded clients or weaken
-- deterministic access. This removes only the optional ranked index.

DROP INDEX IF EXISTS public.idx_work_items_tenant_open_ranked;
