-- 046_ai_safety_foundation_rollback.sql
-- Reverses 046_ai_safety_foundation.sql. Drops ONLY the new objects created
-- by that migration. No existing table data is touched.
--
-- The agent_jobs.batch_id column is additive and harmless; dropping it is
-- optional and only removes the (always-nullable) linkage column.

DROP INDEX IF EXISTS idx_agent_jobs_batch;
ALTER TABLE agent_jobs DROP COLUMN IF EXISTS batch_id;

DROP TABLE IF EXISTS ai_job_batches CASCADE;
DROP TABLE IF EXISTS ai_safety_events CASCADE;
DROP TABLE IF EXISTS ai_safety_switch_audit CASCADE;
DROP TABLE IF EXISTS ai_safety_switches CASCADE;
DROP TABLE IF EXISTS ai_usage_events CASCADE;
