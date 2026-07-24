\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'work_items'
       AND column_name = 'priority_rank'
  ) THEN
    RAISE EXCEPTION 'migration 073 did not restore priority_rank';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'idx_work_items_tenant_open_ranked'
  ) THEN
    RAISE EXCEPTION 'migration 073 did not create ranked open-work index';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.work_items', 'SELECT')
     OR NOT has_table_privilege(
       'authenticated',
       'public.work_item_events',
       'SELECT'
     )
     OR NOT has_table_privilege(
       'authenticated',
       'public.work_item_audit_log',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'migration 073 did not restore deterministic read grants';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'work_items'
       AND policyname = 'tenant_iso_work_items'
       AND qual LIKE '%client_owner%'
       AND qual LIKE '%tenant_owner%'
  ) THEN
    RAISE EXCEPTION 'migration 073 did not add deployed tenant-owner roles';
  END IF;
END $$;
