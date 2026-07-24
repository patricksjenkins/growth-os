-- ============================================================================
-- Migration 069: Canonical tenant-safe document control foundation
-- Date: 2026-07-24
--
-- Additive and inactive by default. No existing asset, gallery, expense, or
-- onboarding storage path is changed. Application writes remain gated by
-- FGA_OS_DOCUMENT_CENTER_WRITES_ENABLED.
--
-- Private object path contract:
--   <tenant_uuid>/<document_uuid>/<version_number>/<safe_filename>
--
-- ROLLBACK: db/rollbacks/069_document_control_rollback.sql
-- ============================================================================

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'fga-documents',
  'fga-documents',
  false,
  26214400,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv',
    'image/png',
    'image/jpeg',
    'image/webp'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM storage.buckets
     WHERE id = 'fga-documents'
       AND public = true
  ) THEN
    RAISE EXCEPTION
      'fga-documents bucket already exists as public; refusing to weaken document isolation';
  END IF;
END $$;

UPDATE storage.buckets
   SET file_size_limit = 26214400,
       allowed_mime_types = ARRAY[
         'application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'text/plain',
         'text/csv',
         'image/png',
         'image/jpeg',
         'image/webp'
       ]::text[]
 WHERE id = 'fga-documents'
   AND public = false;

CREATE TABLE IF NOT EXISTS public.documents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  title                    text NOT NULL,
  document_type            text NOT NULL,
  lifecycle_status         text NOT NULL DEFAULT 'draft'
                             CHECK (lifecycle_status IN ('draft', 'in_review', 'approved', 'published', 'retired')),
  classification           text NOT NULL DEFAULT 'internal'
                             CHECK (classification IN ('public', 'client', 'internal', 'restricted')),
  owner_type               text,
  owner_id                 uuid,
  source_provider          text NOT NULL DEFAULT 'native',
  source_external_id       text,
  source_url               text,
  current_version_number   integer NOT NULL DEFAULT 0 CHECK (current_version_number >= 0),
  tags                     text[] NOT NULL DEFAULT '{}'::text[],
  effective_at             timestamptz,
  review_due_at            timestamptz,
  approved_at              timestamptz,
  published_at             timestamptz,
  retired_at               timestamptz,
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  UNIQUE (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS public.document_versions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  document_id              uuid NOT NULL,
  version_number           integer NOT NULL CHECK (version_number > 0),
  storage_bucket           text NOT NULL DEFAULT 'fga-documents',
  storage_path             text NOT NULL,
  original_filename        text NOT NULL,
  mime_type                text NOT NULL,
  byte_size                bigint NOT NULL CHECK (byte_size >= 0 AND byte_size <= 26214400),
  sha256                   text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  change_summary           text,
  ingestion_status         text NOT NULL DEFAULT 'pending'
                             CHECK (ingestion_status IN ('pending', 'processing', 'ready', 'failed', 'quarantined')),
  malware_scan_status      text NOT NULL DEFAULT 'pending'
                             CHECK (malware_scan_status IN ('pending', 'clean', 'blocked', 'failed')),
  extracted_text_status    text NOT NULL DEFAULT 'pending'
                             CHECK (extracted_text_status IN ('pending', 'ready', 'not_supported', 'failed')),
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (document_id, version_number),
  UNIQUE (tenant_id, storage_path),
  CHECK (storage_bucket = 'fga-documents'),
  CHECK (
    storage_path LIKE
      tenant_id::text || '/' ||
      document_id::text || '/' ||
      version_number::text || '/%'
  ),
  FOREIGN KEY (document_id, tenant_id)
    REFERENCES public.documents(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.document_chunks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  document_id              uuid NOT NULL,
  version_id               uuid NOT NULL,
  chunk_index              integer NOT NULL CHECK (chunk_index >= 0),
  content                  text NOT NULL,
  token_count              integer,
  page_number              integer,
  section_label            text,
  citation_anchor          text NOT NULL,
  search_vector            tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, chunk_index),
  FOREIGN KEY (document_id, tenant_id)
    REFERENCES public.documents(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, tenant_id)
    REFERENCES public.document_versions(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.document_links (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  document_id              uuid NOT NULL,
  entity_type              text NOT NULL,
  entity_id                uuid NOT NULL,
  relationship             text NOT NULL DEFAULT 'reference',
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, entity_type, entity_id, relationship),
  FOREIGN KEY (document_id, tenant_id)
    REFERENCES public.documents(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.document_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  document_id              uuid NOT NULL,
  version_id               uuid,
  event_type               text NOT NULL,
  actor_type               text NOT NULL DEFAULT 'system',
  actor_id                 uuid,
  previous_state           jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_state               jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason                   text,
  correlation_id           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, tenant_id)
    REFERENCES public.documents(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, tenant_id)
    REFERENCES public.document_versions(id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_status
  ON public.documents (tenant_id, lifecycle_status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_documents_tenant_review
  ON public.documents (tenant_id, review_due_at)
  WHERE deleted_at IS NULL AND review_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_document_versions_hash
  ON public.document_versions (tenant_id, sha256);
CREATE INDEX IF NOT EXISTS idx_document_chunks_search
  ON public.document_chunks USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_document_links_entity
  ON public.document_links (tenant_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_document_events_document
  ON public.document_events (tenant_id, document_id, created_at DESC);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'documents',
    'document_versions',
    'document_chunks',
    'document_links',
    'document_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = table_name
         AND policyname = 'tenant_iso_' || table_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated ' ||
        'USING (' ||
          'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
          'AND auth.jwt()->''app_metadata''->>''role'' ' ||
            'IN (''owner'', ''platform_owner'', ''founder'', ''admin'')' ||
        ')',
        'tenant_iso_' || table_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'storage'
       AND tablename = 'objects'
       AND policyname = 'tenant_documents_select'
  ) THEN
    CREATE POLICY tenant_documents_select
      ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'fga-documents'
        AND (storage.foldername(name))[1] =
          NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')
        AND auth.jwt()->'app_metadata'->>'role'
          IN ('owner', 'platform_owner', 'founder', 'admin')
      );
  END IF;

END $$;
