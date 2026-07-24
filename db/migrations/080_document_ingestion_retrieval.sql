-- ============================================================================
-- Migration 080: Safe document ingestion and permissioned retrieval (G18)
-- Date: 2026-07-24
--
-- Additive and default-off. This migration registers content metadata and
-- immutable evidence only. It does not upload, download, call, or configure a
-- storage provider. Supabase Storage is the only supported adapter contract,
-- and provider dispatch is structurally disabled.
--
-- ROLLBACK: db/rollbacks/080_document_ingestion_retrieval_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.document_ingestion_controls (
  tenant_id                  uuid PRIMARY KEY
                               REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                    boolean NOT NULL DEFAULT false,
  execution_mode             text NOT NULL DEFAULT 'disabled'
                               CHECK (execution_mode IN ('disabled', 'shadow')),
  kill_switch_engaged        boolean NOT NULL DEFAULT true,
  source_provider            text NOT NULL DEFAULT 'supabase_storage'
                               CHECK (source_provider = 'supabase_storage'),
  provider_dispatch_enabled  boolean NOT NULL DEFAULT false
                               CHECK (provider_dispatch_enabled = false),
  activated_by               uuid,
  activation_evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision                   bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.document_ingestion_receipts (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL
                               REFERENCES public.tenants(id) ON DELETE RESTRICT,
  document_id                uuid NOT NULL,
  created_version_id         uuid,
  matched_version_id         uuid,
  disposition                text NOT NULL
                               CHECK (disposition IN (
                                 'accepted',
                                 'duplicate_same_document',
                                 'duplicate_same_tenant'
                               )),
  source_provider            text NOT NULL
                               CHECK (source_provider = 'supabase_storage'),
  storage_bucket             text NOT NULL
                               CHECK (storage_bucket = 'fga-documents'),
  storage_path               text,
  original_filename          text NOT NULL
                               CHECK (char_length(original_filename) BETWEEN 1 AND 160),
  mime_type                  text NOT NULL,
  byte_size                  bigint NOT NULL
                               CHECK (byte_size BETWEEN 0 AND 26214400),
  sha256                     text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  evidence                   jsonb NOT NULL,
  evidence_digest            text NOT NULL
                               CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at       timestamptz NOT NULL,
  idempotency_key            text NOT NULL
                               CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint        text NOT NULL
                               CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint       text NOT NULL
                               CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  actor_type                 text NOT NULL CHECK (actor_type = 'service'),
  actor_id                   text NOT NULL
                               CHECK (char_length(btrim(actor_id)) BETWEEN 2 AND 160),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (document_id, tenant_id)
    REFERENCES public.documents(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_version_id, tenant_id)
    REFERENCES public.document_versions(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (matched_version_id, tenant_id)
    REFERENCES public.document_versions(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (
      disposition = 'accepted'
      AND created_version_id IS NOT NULL
      AND matched_version_id IS NULL
      AND storage_path IS NOT NULL
    )
    OR
    (
      disposition IN ('duplicate_same_document', 'duplicate_same_tenant')
      AND created_version_id IS NULL
      AND matched_version_id IS NOT NULL
      AND storage_path IS NULL
    )
  ),
  CHECK (jsonb_typeof(evidence) = 'object' AND evidence <> '{}'::jsonb),
  CHECK (evidence_observed_at <= created_at + interval '5 minutes')
);

CREATE INDEX IF NOT EXISTS idx_document_ingestion_receipts_document
  ON public.document_ingestion_receipts
    (tenant_id, document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_ingestion_receipts_digest
  ON public.document_ingestion_receipts
    (tenant_id, sha256, created_at DESC);

CREATE OR REPLACE FUNCTION public.document_ingestion_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'document_ingestion_evidence_is_immutable';
END;
$$;

CREATE OR REPLACE FUNCTION public.document_citation_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'document_citation_evidence_is_immutable';
END;
$$;

CREATE OR REPLACE FUNCTION public.document_chunk_citation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_version_number integer;
  v_expected_anchor text;
BEGIN
  SELECT version.version_number
    INTO v_version_number
    FROM public.document_versions version
   WHERE version.id = NEW.version_id
     AND version.tenant_id = NEW.tenant_id
     AND version.document_id = NEW.document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'document_chunk_version_not_found_for_document_tenant';
  END IF;
  v_expected_anchor :=
    'document:' || NEW.document_id::text ||
    ':v' || v_version_number::text ||
    ':chunk:' || NEW.chunk_index::text;
  IF NEW.citation_anchor IS DISTINCT FROM v_expected_anchor THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'document_chunk_citation_anchor_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.document_version_content_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'document_version_content_is_immutable';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.change_summary IS DISTINCT FROM OLD.change_summary
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'document_version_content_is_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_chunks_citation_guard
  ON public.document_chunks;
CREATE TRIGGER trg_document_chunks_citation_guard
  BEFORE INSERT ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.document_chunk_citation_guard();

DROP TRIGGER IF EXISTS trg_document_versions_content_immutable
  ON public.document_versions;
CREATE TRIGGER trg_document_versions_content_immutable
  BEFORE UPDATE OR DELETE ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION public.document_version_content_guard();

DROP TRIGGER IF EXISTS trg_document_chunks_immutable
  ON public.document_chunks;
CREATE TRIGGER trg_document_chunks_immutable
  BEFORE UPDATE OR DELETE ON public.document_chunks
  FOR EACH ROW EXECUTE FUNCTION public.document_citation_immutable_row();

DROP TRIGGER IF EXISTS trg_document_events_immutable
  ON public.document_events;
CREATE TRIGGER trg_document_events_immutable
  BEFORE UPDATE OR DELETE ON public.document_events
  FOR EACH ROW EXECUTE FUNCTION public.document_citation_immutable_row();

DROP TRIGGER IF EXISTS trg_document_ingestion_receipts_immutable
  ON public.document_ingestion_receipts;
CREATE TRIGGER trg_document_ingestion_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.document_ingestion_receipts
  FOR EACH ROW EXECUTE FUNCTION public.document_ingestion_immutable_row();

CREATE OR REPLACE FUNCTION public.document_ingestion_control_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.provider_dispatch_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_ingestion_provider_dispatch_forbidden';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode <> 'shadow'
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
    OR NEW.activated_by IS NULL
    OR jsonb_typeof(NEW.activation_evidence) <> 'object'
    OR NEW.activation_evidence = '{}'::jsonb
    OR NOT EXISTS (
      SELECT 1
        FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.activated_by
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_ingestion_activation_invalid';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_document_ingestion_control_guard
  ON public.document_ingestion_controls;
CREATE TRIGGER trg_document_ingestion_control_guard
  BEFORE INSERT OR UPDATE ON public.document_ingestion_controls
  FOR EACH ROW EXECUTE FUNCTION public.document_ingestion_control_guard();

CREATE OR REPLACE FUNCTION public.document_safe_filename(p_filename text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    NULLIF(
      left(
        trim(BOTH '-' FROM regexp_replace(
          regexp_replace(COALESCE(p_filename, 'document'), '^.*[/\\]', ''),
          '[^A-Za-z0-9._-]+',
          '-',
          'g'
        )),
        160
      ),
      ''
    ),
    'document'
  )
$$;

ALTER TABLE public.document_ingestion_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_ingestion_receipts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'document_ingestion_controls'
       AND policyname = 'tenant_iso_document_ingestion_controls'
  ) THEN
    CREATE POLICY tenant_iso_document_ingestion_controls
      ON public.document_ingestion_controls FOR SELECT TO authenticated
      USING (
        tenant_id = NULLIF(
          auth.jwt()->'app_metadata'->>'tenant_id',
          ''
        )::uuid
        AND auth.jwt()->'app_metadata'->>'role' IN (
          'owner', 'platform_owner', 'founder', 'admin',
          'client_owner', 'tenant_owner'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'document_ingestion_receipts'
       AND policyname = 'tenant_iso_document_ingestion_receipts'
  ) THEN
    CREATE POLICY tenant_iso_document_ingestion_receipts
      ON public.document_ingestion_receipts FOR SELECT TO authenticated
      USING (public.can_read_document(tenant_id, document_id));
  END IF;
END $$;

GRANT SELECT ON
  public.document_ingestion_controls,
  public.document_ingestion_receipts
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.document_ingestion_controls,
  public.document_ingestion_receipts
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.document_ingestion_register_rpc(
  p_tenant_id uuid,
  p_document_id uuid,
  p_original_filename text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256 text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_id text,
  p_evidence jsonb,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.document_ingestion_controls%ROWTYPE;
  v_document public.documents%ROWTYPE;
  v_existing_receipt public.document_ingestion_receipts%ROWTYPE;
  v_duplicate public.document_versions%ROWTYPE;
  v_version public.document_versions%ROWTYPE;
  v_receipt public.document_ingestion_receipts%ROWTYPE;
  v_disposition text := 'accepted';
  v_version_number integer;
  v_safe_filename text;
  v_storage_path text;
  v_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic_fingerprint text;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_ingestion_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_ingestion_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_document_id IS NULL THEN
    RAISE EXCEPTION 'document_ingestion_identity_required';
  END IF;
  IF char_length(btrim(COALESCE(p_original_filename, ''))) NOT BETWEEN 1 AND 240
     OR p_mime_type IS NULL
     OR p_mime_type NOT IN (
       'application/pdf',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
       'application/vnd.openxmlformats-officedocument.presentationml.presentation',
       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
       'text/plain', 'text/csv', 'image/png', 'image/jpeg', 'image/webp'
     )
     OR p_byte_size IS NULL
     OR p_byte_size NOT BETWEEN 0 AND 26214400
     OR p_sha256 IS NULL
     OR p_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'document_ingestion_metadata_invalid';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint IS NULL
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$'
     OR char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160 THEN
    RAISE EXCEPTION 'document_ingestion_request_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR p_evidence->>'source_type' <> 'ingestion_manifest'
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
          NOT BETWEEN 3 AND 240
     OR char_length(btrim(COALESCE(p_evidence->>'observed_at', ''))) = 0 THEN
    RAISE EXCEPTION 'document_ingestion_evidence_invalid';
  END IF;
  BEGIN
    v_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'document_ingestion_evidence_time_invalid';
  END;
  IF v_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'document_ingestion_evidence_from_future';
  END IF;

  SELECT control.*
    INTO v_control
    FROM public.document_ingestion_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND
     OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode <> 'shadow' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_ingestion_tenant_not_enabled';
  END IF;
  IF v_control.kill_switch_engaged IS DISTINCT FROM false
     OR v_control.provider_dispatch_enabled IS DISTINCT FROM false
     OR v_control.source_provider <> 'supabase_storage' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_ingestion_control_not_safe';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_tenant_id::text || ':document-ingestion:' || p_document_id::text,
      0
    )
  );

  SELECT document.*
    INTO v_document
    FROM public.documents document
   WHERE document.id = p_document_id
     AND document.tenant_id = p_tenant_id
     AND document.deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'document_ingestion_document_not_found_for_tenant';
  END IF;
  IF v_observed_at < v_document.created_at THEN
    RAISE EXCEPTION 'document_ingestion_evidence_predates_document';
  END IF;

  v_safe_filename := public.document_safe_filename(p_original_filename);
  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic_fingerprint := encode(digest(
    concat_ws(
      '|',
      p_tenant_id::text,
      p_document_id::text,
      v_safe_filename,
      p_mime_type,
      p_byte_size::text,
      p_sha256,
      btrim(p_actor_id),
      p_evidence::text
    ),
    'sha256'
  ), 'hex');

  SELECT receipt.*
    INTO v_existing_receipt
    FROM public.document_ingestion_receipts receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_existing_receipt.request_fingerprint
         IS DISTINCT FROM p_request_fingerprint
       OR v_existing_receipt.semantic_fingerprint
         IS DISTINCT FROM v_semantic_fingerprint
       OR v_existing_receipt.document_id IS DISTINCT FROM p_document_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'document_ingestion_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'receipt_id', v_existing_receipt.id,
      'disposition', v_existing_receipt.disposition,
      'created_version_id', v_existing_receipt.created_version_id
    );
  END IF;

  SELECT candidate.*
    INTO v_duplicate
    FROM public.document_versions candidate
   WHERE candidate.tenant_id = p_tenant_id
     AND candidate.sha256 = p_sha256
   ORDER BY
     CASE WHEN candidate.document_id = p_document_id THEN 0 ELSE 1 END,
     candidate.version_number DESC,
     candidate.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    v_disposition := CASE
      WHEN v_duplicate.document_id = p_document_id
        THEN 'duplicate_same_document'
      ELSE 'duplicate_same_tenant'
    END;
  ELSE
    SELECT COALESCE(max(version.version_number), 0) + 1
      INTO v_version_number
      FROM public.document_versions version
     WHERE version.tenant_id = p_tenant_id
       AND version.document_id = p_document_id;
    v_storage_path :=
      p_tenant_id::text || '/' ||
      p_document_id::text || '/' ||
      v_version_number::text || '/' ||
      v_safe_filename;

    INSERT INTO public.document_versions (
      tenant_id, document_id, version_number, storage_bucket, storage_path,
      original_filename, mime_type, byte_size, sha256, ingestion_status,
      malware_scan_status, extracted_text_status
    ) VALUES (
      p_tenant_id, p_document_id, v_version_number, 'fga-documents',
      v_storage_path, v_safe_filename, p_mime_type, p_byte_size, p_sha256,
      'pending', 'pending', 'pending'
    )
    RETURNING * INTO v_version;
  END IF;

  INSERT INTO public.document_ingestion_receipts (
    tenant_id, document_id, created_version_id, matched_version_id,
    disposition, source_provider, storage_bucket, storage_path,
    original_filename, mime_type, byte_size, sha256, evidence,
    evidence_digest, evidence_observed_at, idempotency_key,
    request_fingerprint, semantic_fingerprint, actor_type, actor_id
  ) VALUES (
    p_tenant_id, p_document_id, v_version.id, v_duplicate.id,
    v_disposition, 'supabase_storage', 'fga-documents', v_storage_path,
    v_safe_filename, p_mime_type, p_byte_size, p_sha256, p_evidence,
    v_evidence_digest, v_observed_at, btrim(p_idempotency_key),
    p_request_fingerprint, v_semantic_fingerprint, 'service',
    btrim(p_actor_id)
  )
  RETURNING * INTO v_receipt;

  INSERT INTO public.document_events (
    tenant_id, document_id, version_id, event_type, actor_type, actor_id,
    previous_state, next_state, reason, correlation_id
  ) VALUES (
    p_tenant_id,
    p_document_id,
    CASE
      WHEN v_disposition = 'accepted' THEN v_version.id
      WHEN v_disposition = 'duplicate_same_document' THEN v_duplicate.id
      ELSE NULL
    END,
    CASE WHEN v_disposition = 'accepted'
      THEN 'ingestion_registered'
      ELSE 'ingestion_duplicate_detected'
    END,
    'service',
    NULL,
    '{}'::jsonb,
    jsonb_build_object(
      'disposition', v_disposition,
      'evidence_digest', v_evidence_digest
    ),
    'safe_ingestion_registration',
    btrim(p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'outcome', 'registered',
    'receipt_id', v_receipt.id,
    'disposition', v_disposition,
    'created_version_id', v_version.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.can_retrieve_document_for_actor(
  p_tenant_id uuid,
  p_document_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_actor_role text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_document public.documents%ROWTYPE;
  v_role text;
  v_user_id uuid;
BEGIN
  SELECT document.*
    INTO v_document
    FROM public.documents document
   WHERE document.id = p_document_id
     AND document.tenant_id = p_tenant_id
     AND document.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_actor_type = 'user' THEN
    BEGIN
      v_user_id := p_actor_id::uuid;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;
    SELECT tenant_user.role
      INTO v_role
      FROM public.tenant_users tenant_user
     WHERE tenant_user.tenant_id = p_tenant_id
       AND tenant_user.user_id = v_user_id;
    IF NOT FOUND OR v_role IS DISTINCT FROM p_actor_role THEN RETURN false; END IF;
    IF v_role IN (
      'owner', 'platform_owner', 'founder', 'admin',
      'client_owner', 'tenant_owner'
    ) THEN RETURN true; END IF;
    IF v_role = 'manager' AND v_document.classification <> 'restricted' THEN
      RETURN true;
    END IF;
    IF v_role IN ('member', 'viewer')
       AND v_document.classification IN ('public', 'client') THEN
      RETURN true;
    END IF;
    RETURN EXISTS (
      SELECT 1
        FROM public.document_access_grants grant_row
       WHERE grant_row.tenant_id = p_tenant_id
         AND grant_row.document_id = p_document_id
         AND grant_row.revoked_at IS NULL
         AND (grant_row.expires_at IS NULL OR grant_row.expires_at > now())
         AND (
           (
             grant_row.principal_type = 'user'
             AND grant_row.principal_id = p_actor_id
           )
           OR (
             grant_row.principal_type = 'role'
             AND grant_row.principal_id = v_role
           )
         )
         AND (
           'read' = ANY(grant_row.permissions)
           OR 'manage' = ANY(grant_row.permissions)
         )
    );
  END IF;

  IF p_actor_type = 'agent'
     AND char_length(btrim(COALESCE(p_actor_id, ''))) BETWEEN 2 AND 200 THEN
    RETURN EXISTS (
      SELECT 1
        FROM public.document_access_grants grant_row
       WHERE grant_row.tenant_id = p_tenant_id
         AND grant_row.document_id = p_document_id
         AND grant_row.principal_type = 'agent'
         AND grant_row.principal_id = p_actor_id
         AND grant_row.revoked_at IS NULL
         AND (grant_row.expires_at IS NULL OR grant_row.expires_at > now())
         AND (
           'read' = ANY(grant_row.permissions)
           OR 'manage' = ANY(grant_row.permissions)
         )
    );
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.document_retrieval_search_rpc(
  p_tenant_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_actor_role text,
  p_query text,
  p_limit integer DEFAULT 20,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_results jsonb;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_retrieval_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'document_retrieval_disabled';
  END IF;
  IF p_tenant_id IS NULL
     OR p_actor_type NOT IN ('user', 'agent')
     OR char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 200
     OR char_length(btrim(COALESCE(p_query, ''))) NOT BETWEEN 2 AND 200
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'document_retrieval_request_invalid';
  END IF;

  SELECT COALESCE(jsonb_agg(result.payload ORDER BY result.rank DESC), '[]'::jsonb)
    INTO v_results
    FROM (
      SELECT
        ts_rank(chunk.search_vector, websearch_to_tsquery('english', p_query)) AS rank,
        jsonb_build_object(
          'document_id', document.id,
          'title', document.title,
          'excerpt', left(chunk.content, 600),
          'citation', jsonb_build_object(
            'anchor', chunk.citation_anchor,
            'version_number', version.version_number,
            'chunk_index', chunk.chunk_index,
            'page_number', chunk.page_number,
            'section_label', chunk.section_label
          )
        ) AS payload
      FROM public.document_chunks chunk
      JOIN public.documents document
        ON document.id = chunk.document_id
       AND document.tenant_id = chunk.tenant_id
      JOIN public.document_versions version
        ON version.id = chunk.version_id
       AND version.document_id = chunk.document_id
       AND version.tenant_id = chunk.tenant_id
     WHERE chunk.tenant_id = p_tenant_id
       AND document.current_version_number = version.version_number
       AND version.ingestion_status = 'ready'
       AND version.malware_scan_status = 'clean'
       AND version.extracted_text_status = 'ready'
       AND chunk.search_vector @@ websearch_to_tsquery('english', p_query)
       AND public.can_retrieve_document_for_actor(
         p_tenant_id,
         document.id,
         p_actor_type,
         p_actor_id,
         p_actor_role
       )
     ORDER BY rank DESC, document.id, chunk.chunk_index
     LIMIT p_limit
    ) result;

  RETURN jsonb_build_object(
    'query', btrim(p_query),
    'results', v_results
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.document_ingestion_register_rpc(
  uuid, uuid, text, text, bigint, text, text, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_ingestion_register_rpc(
  uuid, uuid, text, text, bigint, text, text, text, text, jsonb, boolean
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.document_retrieval_search_rpc(
  uuid, text, text, text, text, integer, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_retrieval_search_rpc(
  uuid, text, text, text, text, integer, boolean
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.can_retrieve_document_for_actor(
  uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_safe_filename(text)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_ingestion_immutable_row()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_citation_immutable_row()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_chunk_citation_guard()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_version_content_guard()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.document_ingestion_control_guard()
FROM PUBLIC, anon, authenticated, service_role;
