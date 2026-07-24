\set ON_ERROR_STOP on

UPDATE public.work_items
   SET title = 'Legacy assigned work remains updateable'
 WHERE id = '90000000-0000-4000-8000-000000000001';

UPDATE public.work_items
   SET status = 'open'
 WHERE id = '90000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.work_items
     WHERE id = '90000000-0000-4000-8000-000000000001'
       AND title = 'Legacy assigned work remains updateable'
       AND status = 'open'
       AND assignee_type = 'unassigned'
       AND assignee_id IS NULL
       AND claimed_at IS NULL
       AND entity_type = 'legacy_record'
       AND entity_id = 'legacy-id'
  ) THEN
    RAISE EXCEPTION
      'migration 075 froze legacy fields or failed to clear reopened assignment';
  END IF;

  IF has_table_privilege(
    'service_role',
    'public.work_items',
    'INSERT, UPDATE, DELETE'
  ) THEN
    RAISE EXCEPTION 'service role retained direct work-item mutation authority';
  END IF;
END $$;
