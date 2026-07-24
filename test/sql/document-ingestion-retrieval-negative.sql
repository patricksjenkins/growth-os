\set ON_ERROR_STOP on

-- Run after autonomous-os-tenant-negative.sql and migration 080. All IDs and
-- content below are synthetic isolation fixtures.
INSERT INTO public.document_ingestion_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged,
  source_provider, activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true,
    'shadow',
    false,
    'supabase_storage',
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_test_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    true,
    'shadow',
    false,
    'supabase_storage',
    'ffffffff-2222-4222-8222-222222222222',
    '{"source":"synthetic_test_approval"}'::jsonb
  );

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.document_ingestion_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      '20000000-0000-4000-8000-000000000001',
      'procedure.pdf',
      'application/pdf',
      100,
      repeat('a', 64),
      'fixture:document:unauthorized',
      repeat('1', 64),
      'fixture-ingestion-service',
      jsonb_build_object(
        'source_type', 'ingestion_manifest',
        'source_id', 'fixture-manifest-unauthorized',
        'observed_at', now()
      ),
      true
    );
    RAISE EXCEPTION 'expected authenticated document ingestion to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.document_ingestion_receipts (
      tenant_id, document_id, disposition, source_provider, storage_bucket,
      original_filename, mime_type, byte_size, sha256, evidence,
      evidence_digest, evidence_observed_at, idempotency_key,
      request_fingerprint, semantic_fingerprint, actor_type, actor_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '20000000-0000-4000-8000-000000000001',
      'duplicate_same_document', 'supabase_storage', 'fga-documents',
      'procedure.pdf', 'application/pdf', 100, repeat('a', 64),
      '{"source_type":"ingestion_manifest"}'::jsonb,
      repeat('a', 64), now(), 'fixture:direct:receipt',
      repeat('b', 64), repeat('c', 64), 'service', 'fixture-service'
    );
    RAISE EXCEPTION 'expected direct service ingestion receipt write to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  tenant_b_result jsonb;
  tenant_a_result jsonb;
  replay_result jsonb;
  duplicate_result jsonb;
  tenant_a_version_id uuid;
  tenant_b_version_id uuid;
  evidence_b jsonb;
  evidence_a jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  evidence_b := jsonb_build_object(
    'source_type', 'ingestion_manifest',
    'source_id', 'fixture-manifest-b',
    'observed_at', now()
  );
  evidence_a := jsonb_build_object(
    'source_type', 'ingestion_manifest',
    'source_id', 'fixture-manifest-a',
    'observed_at', now()
  );

  BEGIN
    PERFORM public.document_ingestion_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      '20000000-0000-4000-8000-000000000001',
      'procedure.pdf',
      'application/pdf',
      100,
      repeat('b', 64),
      'fixture:document:flag-off',
      repeat('2', 64),
      'fixture-ingestion-service',
      evidence_a,
      false
    );
    RAISE EXCEPTION 'expected disabled document ingestion flag to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.document_ingestion_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      '20000000-0000-4000-8000-000000000004',
      'cross-tenant.pdf',
      'application/pdf',
      100,
      repeat('b', 64),
      'fixture:document:cross-tenant',
      repeat('3', 64),
      'fixture-ingestion-service',
      evidence_a,
      true
    );
    RAISE EXCEPTION 'expected cross-tenant document ingestion to fail';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  tenant_b_result := public.document_ingestion_register_rpc(
    '22222222-2222-4222-8222-222222222222',
    '20000000-0000-4000-8000-000000000004',
    'tenant-b-brochure.pdf',
    'application/pdf',
    100,
    repeat('b', 64),
    'fixture:document:tenant-b',
    repeat('4', 64),
    'fixture-ingestion-service',
    evidence_b,
    true
  );
  tenant_b_version_id :=
    NULLIF(tenant_b_result->>'created_version_id', '')::uuid;
  IF tenant_b_result->>'disposition' <> 'accepted'
     OR tenant_b_version_id IS NULL THEN
    RAISE EXCEPTION 'tenant B synthetic document was not accepted';
  END IF;

  tenant_a_result := public.document_ingestion_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    '20000000-0000-4000-8000-000000000001',
    '../tenant-a-procedure.pdf',
    'application/pdf',
    100,
    repeat('b', 64),
    'fixture:document:tenant-a',
    repeat('5', 64),
    'fixture-ingestion-service',
    evidence_a,
    true
  );
  tenant_a_version_id :=
    NULLIF(tenant_a_result->>'created_version_id', '')::uuid;
  IF tenant_a_result->>'disposition' <> 'accepted'
     OR tenant_a_version_id IS NULL THEN
    RAISE EXCEPTION
      'tenant A digest was incorrectly deduplicated against tenant B';
  END IF;

  replay_result := public.document_ingestion_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    '20000000-0000-4000-8000-000000000001',
    '../tenant-a-procedure.pdf',
    'application/pdf',
    100,
    repeat('b', 64),
    'fixture:document:tenant-a',
    repeat('5', 64),
    'fixture-ingestion-service',
    evidence_a,
    true
  );
  IF replay_result->>'outcome' <> 'replay'
     OR NULLIF(replay_result->>'created_version_id', '')::uuid
          <> tenant_a_version_id THEN
    RAISE EXCEPTION 'expected exact document ingestion replay';
  END IF;

  duplicate_result := public.document_ingestion_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    '20000000-0000-4000-8000-000000000001',
    'duplicate-procedure.pdf',
    'application/pdf',
    100,
    repeat('b', 64),
    'fixture:document:tenant-a-duplicate',
    repeat('6', 64),
    'fixture-ingestion-service',
    jsonb_build_object(
      'source_type', 'ingestion_manifest',
      'source_id', 'fixture-manifest-a-duplicate',
      'observed_at', now()
    ),
    true
  );
  IF duplicate_result->>'disposition' <> 'duplicate_same_document'
     OR duplicate_result->>'created_version_id' IS NOT NULL THEN
    RAISE EXCEPTION 'expected same-document digest duplicate';
  END IF;

  UPDATE public.document_versions
     SET ingestion_status = 'ready',
         malware_scan_status = 'clean',
         extracted_text_status = 'ready'
   WHERE id = tenant_a_version_id
     AND tenant_id = '11111111-1111-4111-8111-111111111111';
  UPDATE public.documents
     SET current_version_number = 1
   WHERE id = '20000000-0000-4000-8000-000000000001'
     AND tenant_id = '11111111-1111-4111-8111-111111111111';
  INSERT INTO public.document_chunks (
    tenant_id, document_id, version_id, chunk_index, content,
    page_number, section_label, citation_anchor
  ) VALUES (
    '11111111-1111-4111-8111-111111111111',
    '20000000-0000-4000-8000-000000000001',
    tenant_a_version_id,
    0,
    'Synthetic escalation evidence requires an immutable receipt.',
    1,
    'Synthetic escalation',
    'document:20000000-0000-4000-8000-000000000001:v1:chunk:0'
  );
  INSERT INTO public.document_access_grants (
    tenant_id, document_id, principal_type, principal_id, permissions
  ) VALUES (
    '11111111-1111-4111-8111-111111111111',
    '20000000-0000-4000-8000-000000000001',
    'agent',
    'reliability-head',
    ARRAY['read']::text[]
  );

  BEGIN
    INSERT INTO public.document_chunks (
      tenant_id, document_id, version_id, chunk_index, content,
      citation_anchor
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '20000000-0000-4000-8000-000000000001',
      tenant_a_version_id,
      1,
      'Synthetic content with a false citation.',
      'document:20000000-0000-4000-8000-000000000004:v1:chunk:1'
    );
    RAISE EXCEPTION 'expected false citation anchor to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END $$;

DO $$
DECLARE
  allowed_result jsonb;
  denied_result jsonb;
  cross_tenant_result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  allowed_result := public.document_retrieval_search_rpc(
    '11111111-1111-4111-8111-111111111111',
    'agent',
    'reliability-head',
    NULL,
    'escalation',
    20,
    true
  );
  IF jsonb_array_length(allowed_result->'results') <> 1
     OR allowed_result->'results'->0->'citation'->>'anchor'
          <> 'document:20000000-0000-4000-8000-000000000001:v1:chunk:0' THEN
    RAISE EXCEPTION 'granted agent did not receive citation-bound retrieval';
  END IF;

  denied_result := public.document_retrieval_search_rpc(
    '11111111-1111-4111-8111-111111111111',
    'agent',
    'ungranted-agent',
    NULL,
    'escalation',
    20,
    true
  );
  IF jsonb_array_length(denied_result->'results') <> 0 THEN
    RAISE EXCEPTION 'ungranted agent retrieved document content';
  END IF;

  cross_tenant_result := public.document_retrieval_search_rpc(
    '22222222-2222-4222-8222-222222222222',
    'agent',
    'reliability-head',
    NULL,
    'escalation',
    20,
    true
  );
  IF jsonb_array_length(cross_tenant_result->'results') <> 0 THEN
    RAISE EXCEPTION 'agent grant leaked through another tenant context';
  END IF;

  BEGIN
    PERFORM public.document_retrieval_search_rpc(
      '11111111-1111-4111-8111-111111111111',
      'agent',
      'reliability-head',
      NULL,
      'escalation',
      20,
      false
    );
    RAISE EXCEPTION 'expected disabled retrieval flag to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE public.document_versions
       SET sha256 = repeat('f', 64)
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
       AND document_id = '20000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'expected immutable document version content';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    UPDATE public.document_chunks
       SET content = 'changed'
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable citation chunk';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    DELETE FROM public.document_ingestion_receipts
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable ingestion receipt';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;
