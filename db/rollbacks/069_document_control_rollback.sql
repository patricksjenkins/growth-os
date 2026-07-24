-- Operator-invoked rollback for migration 069.
-- Existing storage objects are intentionally preserved for recovery/export.

DO $$
BEGIN
  IF to_regclass('public.appointment_workflows') IS NOT NULL THEN
    RAISE EXCEPTION
      'rollback 070 before 069; scheduling depends on document control';
  END IF;
  IF to_regclass('public.documents') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.documents LIMIT 1) THEN
    RAISE EXCEPTION
      'document data exists; disable the feature and export an object/version manifest instead of dropping tables';
  END IF;
END $$;

DROP POLICY IF EXISTS tenant_documents_delete ON storage.objects;
DROP POLICY IF EXISTS tenant_documents_update ON storage.objects;
DROP POLICY IF EXISTS tenant_documents_insert ON storage.objects;
DROP POLICY IF EXISTS tenant_documents_select ON storage.objects;

DROP TABLE IF EXISTS public.document_events;
DROP TABLE IF EXISTS public.document_links;
DROP TABLE IF EXISTS public.document_chunks;
DROP TABLE IF EXISTS public.document_versions;
DROP TABLE IF EXISTS public.documents;
