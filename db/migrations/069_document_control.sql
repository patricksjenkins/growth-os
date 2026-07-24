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

CREATE TABLE IF NOT EXISTS public.document_access_grants (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  document_id              uuid NOT NULL,
  principal_type           text NOT NULL
                             CHECK (principal_type IN ('role', 'user', 'agent')),
  principal_id             text NOT NULL CHECK (char_length(principal_id) BETWEEN 1 AND 200),
  permissions              text[] NOT NULL DEFAULT ARRAY['read']::text[]
                             CHECK (
                               permissions <@ ARRAY[
                                 'read', 'create_version', 'review',
                                 'approve', 'publish', 'retire', 'link', 'manage'
                               ]::text[]
                             ),
  expires_at               timestamptz,
  granted_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  FOREIGN KEY (document_id, tenant_id)
    REFERENCES public.documents(id, tenant_id) ON DELETE CASCADE
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
CREATE INDEX IF NOT EXISTS idx_document_access_principal
  ON public.document_access_grants (
    tenant_id, principal_type, principal_id, document_id
  )
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_access_active_principal
  ON public.document_access_grants (
    document_id, principal_type, principal_id
  )
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION public.can_read_document(
  p_tenant_id uuid,
  p_document_id uuid
)
RETURNS boolean AS $$
DECLARE
  v_role text := auth.jwt()->'app_metadata'->>'role';
  v_user_id text := auth.uid()::text;
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM public.documents document
     WHERE document.id = p_document_id
       AND document.tenant_id = p_tenant_id
       AND document.deleted_at IS NULL
       AND p_tenant_id =
         NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
       AND (
         v_role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
         OR (
           v_role = 'manager'
           AND document.classification <> 'restricted'
         )
         OR (
           v_role IN ('member', 'viewer')
           AND document.classification IN ('public', 'client')
         )
         OR EXISTS (
           SELECT 1
             FROM public.document_access_grants grant_row
            WHERE grant_row.document_id = document.id
              AND grant_row.tenant_id = document.tenant_id
              AND grant_row.revoked_at IS NULL
              AND (
                grant_row.expires_at IS NULL
                OR grant_row.expires_at > now()
              )
              AND (
                (grant_row.principal_type = 'role' AND grant_row.principal_id = v_role)
                OR (
                  grant_row.principal_type = 'user'
                  AND grant_row.principal_id = v_user_id
                )
              )
              AND (
                'read' = ANY(grant_row.permissions)
                OR 'manage' = ANY(grant_row.permissions)
              )
         )
       )
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = public, auth, pg_temp;

CREATE OR REPLACE FUNCTION public.storage_document_id(path text)
RETURNS uuid AS $$
BEGIN
  RETURN (storage.foldername(path))[2]::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE
   SET search_path = public, storage, pg_temp;

CREATE OR REPLACE FUNCTION public.storage_tenant_id(path text)
RETURNS uuid AS $$
BEGIN
  RETURN (storage.foldername(path))[1]::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE
   SET search_path = public, storage, pg_temp;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_access_grants ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
  document_column text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'documents',
    'document_versions',
    'document_chunks',
    'document_links',
    'document_events'
  ] LOOP
    document_column := CASE
      WHEN table_name = 'documents' THEN 'id'
      ELSE 'document_id'
    END;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = table_name
         AND policyname = 'tenant_iso_' || table_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated ' ||
        'USING (public.can_read_document(tenant_id, %I))',
        'tenant_iso_' || table_name,
        table_name,
        document_column
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'document_access_grants'
       AND policyname = 'tenant_iso_document_access_grants'
  ) THEN
    CREATE POLICY tenant_iso_document_access_grants
      ON public.document_access_grants FOR SELECT TO authenticated
      USING (
        tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
        AND auth.jwt()->'app_metadata'->>'role'
          IN (
            'owner', 'platform_owner', 'founder', 'admin',
            'client_owner', 'tenant_owner'
          )
      );
  END IF;
END $$;

GRANT SELECT ON
  public.documents,
  public.document_versions,
  public.document_chunks,
  public.document_links,
  public.document_events,
  public.document_access_grants
TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON
  public.documents,
  public.document_versions,
  public.document_chunks,
  public.document_links,
  public.document_events,
  public.document_access_grants
FROM authenticated;

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
        AND public.can_read_document(
          public.storage_tenant_id(name),
          public.storage_document_id(name)
        )
      );
  END IF;

END $$;
