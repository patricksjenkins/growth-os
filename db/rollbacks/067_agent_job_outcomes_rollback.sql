-- Operator-invoked rollback for migration 067.
-- This file is intentionally outside db/migrations so the forward migration
-- runner can never execute it automatically.

DO $$
BEGIN
  IF to_regclass('public.agent_job_outcomes') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.agent_job_outcomes LIMIT 1) THEN
    RAISE EXCEPTION
      'outcome evidence exists; disable observability and export records instead of dropping the table';
  END IF;
END $$;

DROP TABLE IF EXISTS public.agent_job_outcomes;
