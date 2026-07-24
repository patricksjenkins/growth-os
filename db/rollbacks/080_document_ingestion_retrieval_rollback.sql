-- Rollback 080 intentionally preserves ingestion evidence, registered versions,
-- citation chunks, and tenant controls. It disables the command and retrieval
-- boundaries without deleting data. Destruction requires a separately approved,
-- evidence-empty migration.

DROP FUNCTION IF EXISTS public.document_ingestion_register_rpc(
  uuid, uuid, text, text, bigint, text, text, text, text, jsonb, boolean
);
DROP FUNCTION IF EXISTS public.document_retrieval_search_rpc(
  uuid, text, text, text, text, integer, boolean
);

UPDATE public.document_ingestion_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       updated_at = now()
 WHERE enabled = true
    OR execution_mode <> 'disabled'
    OR kill_switch_engaged = false;
