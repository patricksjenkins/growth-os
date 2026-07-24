-- Operator-invoked rollback for migration 067.
-- This file is intentionally outside db/migrations so the forward migration
-- runner can never execute it automatically.

DROP TABLE IF EXISTS public.agent_job_outcomes CASCADE;
