\set ON_ERROR_STOP on

INSERT INTO public.tenants (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

INSERT INTO public.attention_queue (id, tenant_id) VALUES
  ('99999999-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.leads (id, tenant_id) VALUES
  ('aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.customers (id, tenant_id) VALUES
  ('cccccccc-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('dddddddd-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'eeeeeeee-1111-4111-8111-111111111111',
    'client_owner'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'ffffffff-2222-4222-8222-222222222222',
    'tenant_owner'
  ),
  (
    '11111111-1111-4111-8111-111111111111',
    '77777777-1111-4111-8111-111111111111',
    'member'
  );

INSERT INTO public.work_items (
  id, tenant_id, kind, department, title, source_type, source_id, idempotency_key
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'decision', 'executive', 'Tenant A decision', 'fixture', 'decision-a', 'fixture:decision:a'
);

BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.work_items (
      tenant_id, kind, department, title, source_type, source_id, idempotency_key
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'task', 'executive', 'Direct service write denied',
      'fixture', 'service-direct', 'fixture:service-direct'
    );
    RAISE EXCEPTION 'expected direct service-role ledger write to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.work_item_create_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_kind => 'decision',
      p_department => 'executive',
      p_title => 'Unauthorized RPC command',
      p_source_type => 'fixture',
      p_source_id => 'rpc-denied',
      p_idempotency_key => 'fixture:rpc:denied',
      p_request_fingerprint => repeat('d', 64),
      p_actor_type => 'human',
      p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_actor_authority_tier => 'owner'
    );
    RAISE EXCEPTION 'expected authenticated RPC execution to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  created_result jsonb;
  replay_result jsonb;
  transitioned_result jsonb;
  transition_replay_result jsonb;
  released_result jsonb;
  created_item_id uuid;
  event_count integer;
  audit_count integer;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  created_result := public.work_item_create_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_kind => 'decision',
    p_department => 'executive',
    p_title => 'Atomic RPC decision',
    p_source_type => 'fixture',
    p_source_id => 'rpc-atomic',
    p_idempotency_key => 'fixture:rpc:atomic',
    p_request_fingerprint => repeat('a', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_actor_authority_tier => 'owner'
  );
  IF created_result->>'outcome' <> 'created' THEN
    RAISE EXCEPTION 'expected atomic RPC creation';
  END IF;
  created_item_id := (created_result->'work_item'->>'id')::uuid;

  replay_result := public.work_item_create_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_kind => 'decision',
    p_department => 'executive',
    p_title => 'Atomic RPC decision',
    p_source_type => 'fixture',
    p_source_id => 'rpc-atomic',
    p_idempotency_key => 'fixture:rpc:atomic',
    p_request_fingerprint => repeat('a', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_actor_authority_tier => 'owner'
  );
  IF replay_result->>'outcome' <> 'replay'
     OR (replay_result->'work_item'->>'id')::uuid <> created_item_id THEN
    RAISE EXCEPTION 'expected identical create command to replay';
  END IF;

  BEGIN
    PERFORM public.work_item_create_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_kind => 'decision',
      p_department => 'executive',
      p_title => 'Conflicting RPC decision',
      p_source_type => 'fixture',
      p_source_id => 'rpc-conflict',
      p_idempotency_key => 'fixture:rpc:atomic',
      p_request_fingerprint => repeat('b', 64),
      p_actor_type => 'human',
      p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_actor_authority_tier => 'owner'
    );
    RAISE EXCEPTION 'expected changed create fingerprint to fail';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  transitioned_result := public.work_item_transition_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_work_item_id => created_item_id,
    p_expected_revision => 1,
    p_to_status => 'claimed',
    p_idempotency_key => 'fixture:rpc:claim',
    p_request_fingerprint => repeat('c', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_actor_authority_tier => 'owner',
    p_assignee_type => 'human',
    p_assignee_id => 'eeeeeeee-1111-4111-8111-111111111111'
  );
  IF transitioned_result->>'outcome' <> 'transitioned'
     OR transitioned_result->'work_item'->>'status' <> 'claimed'
     OR (transitioned_result->'work_item'->>'revision')::integer <> 2 THEN
    RAISE EXCEPTION 'expected atomic claim transition';
  END IF;

  transition_replay_result := public.work_item_transition_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_work_item_id => created_item_id,
    p_expected_revision => 1,
    p_to_status => 'claimed',
    p_idempotency_key => 'fixture:rpc:claim',
    p_request_fingerprint => repeat('c', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_actor_authority_tier => 'owner',
    p_assignee_type => 'human',
    p_assignee_id => 'eeeeeeee-1111-4111-8111-111111111111'
  );
  IF transition_replay_result->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected identical transition command to replay';
  END IF;

  released_result := public.work_item_transition_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_work_item_id => created_item_id,
    p_expected_revision => 2,
    p_to_status => 'open',
    p_idempotency_key => 'fixture:rpc:release',
    p_request_fingerprint => repeat('9', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_actor_authority_tier => 'owner'
  );
  IF released_result->>'outcome' <> 'transitioned'
     OR released_result->'work_item'->>'status' <> 'open'
     OR released_result->'work_item'->>'assignee_type' <> 'unassigned'
     OR released_result->'work_item'->>'assignee_id' IS NOT NULL
     OR released_result->'work_item'->>'claimed_at' IS NOT NULL THEN
    RAISE EXCEPTION 'release retained stale assignment state';
  END IF;

  BEGIN
    PERFORM public.work_item_transition_rpc(
      p_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_work_item_id => created_item_id,
      p_expected_revision => 3,
      p_to_status => 'in_progress',
      p_idempotency_key => 'fixture:rpc:cross-tenant',
      p_request_fingerprint => repeat('e', 64),
      p_actor_type => 'human',
      p_actor_id => 'ffffffff-2222-4222-8222-222222222222',
      p_actor_authority_tier => 'owner'
    );
    RAISE EXCEPTION 'expected cross-tenant transition to fail';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  SELECT count(*) INTO event_count
    FROM public.work_item_events
   WHERE work_item_id = created_item_id;
  SELECT count(*) INTO audit_count
    FROM public.work_item_audit_log
   WHERE work_item_id = created_item_id;
  IF event_count <> 3 OR audit_count <> 3 THEN
    RAISE EXCEPTION
      'expected one event and audit row per committed mutation, got events=% audits=%',
      event_count, audit_count;
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.work_items (
      tenant_id, kind, department, title, source_type, source_id,
      idempotency_key, assignee_type, assignee_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'task', 'executive', 'Invalid cross-tenant assignee', 'fixture',
      'cross-assignee', 'fixture:cross-assignee',
      'human', 'ffffffff-2222-4222-8222-222222222222'
    );
    RAISE EXCEPTION 'expected cross-tenant human assignee to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.work_items (
      tenant_id, kind, department, title, source_type, source_id,
      idempotency_key, entity_type, entity_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'task', 'executive', 'Invalid cross-tenant entity', 'fixture',
      'cross-entity', 'fixture:cross-entity',
      'customer', 'dddddddd-2222-4222-8222-222222222222'
    );
    RAISE EXCEPTION 'expected cross-tenant entity link to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.work_item_events (
      tenant_id, work_item_id, event_type, actor_type, actor_id,
      authority_tier, idempotency_key, request_fingerprint
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '10000000-0000-4000-8000-000000000001',
      'claimed', 'human', '77777777-1111-4111-8111-111111111111',
      'owner', 'fixture:member-owner-spoof', repeat('f', 64)
    );
    RAISE EXCEPTION 'expected member owner-authority spoof to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.work_items (
      tenant_id, kind, department, title, source_type, source_id,
      idempotency_key, attention_queue_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'decision', 'executive', 'Invalid attention link', 'fixture',
      'invalid-attention', 'fixture:invalid:attention',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'expected cross-tenant attention link to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant attention link to fail' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.work_item_events (
      tenant_id, work_item_id, event_type, actor_type, authority_tier,
      idempotency_key, request_fingerprint
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',
      '10000000-0000-4000-8000-000000000001',
      'created', 'system', 'system', 'fixture:event:cross-tenant',
      repeat('a', 64)
    );
    RAISE EXCEPTION 'expected cross-tenant work event to fail';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;
END $$;

INSERT INTO public.ops_incidents (
  id, tenant_id, agent_name, issue_type, status, attention_queue_id, detected_at
) VALUES
  (
    '60000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'fixture-agent',
    'repeated_error',
    'open',
    '99999999-1111-4111-8111-111111111111',
    '2020-01-01T00:00:00Z'
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    'fixture-agent-b',
    'zero_output',
    'open',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2020-01-01T00:00:00Z'
  );

INSERT INTO public.work_items (
  id, tenant_id, kind, department, title, authority_tier,
  source_type, source_id, entity_type, entity_id, idempotency_key,
  attention_queue_id
) VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'incident',
    'reliability',
    'Tenant A agent recovery',
    'system',
    'ops_incident',
    '60000000-0000-4000-8000-000000000001',
    'ops_incident',
    '60000000-0000-4000-8000-000000000001',
    'fixture:incident-recovery',
    '99999999-1111-4111-8111-111111111111'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    'incident',
    'reliability',
    'Tenant B agent recovery',
    'system',
    'ops_incident',
    '60000000-0000-4000-8000-000000000002',
    'ops_incident',
    '60000000-0000-4000-8000-000000000002',
    'fixture:incident-recovery-b',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );

INSERT INTO public.agent_jobs (
  id, tenant_id, agent_name, status, created_at, completed_at
) VALUES (
  '70000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'fixture-agent',
  'completed',
  '2020-01-02T00:00:00Z',
  '2020-01-02T00:00:00Z'
);

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.incident_recovery_reconcile_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_incident_id => '60000000-0000-4000-8000-000000000001',
      p_work_item_id => '50000000-0000-4000-8000-000000000001',
      p_expected_work_item_revision => 1,
      p_idempotency_key => 'fixture:incident:denied',
      p_request_fingerprint => repeat('1', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_verification_method => 'successful_run',
      p_verification_reference => 'agent_job:70000000-0000-4000-8000-000000000001',
      p_observed_at => '2020-01-02T00:00:00Z',
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected authenticated incident reconciliation to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  reconciled_result jsonb;
  replay_result jsonb;
  event_count integer;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  BEGIN
    PERFORM public.incident_recovery_reconcile_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_incident_id => '60000000-0000-4000-8000-000000000001',
      p_work_item_id => '50000000-0000-4000-8000-000000000001',
      p_expected_work_item_revision => 1,
      p_idempotency_key => 'fixture:incident:gate-off',
      p_request_fingerprint => repeat('2', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_verification_method => 'successful_run',
      p_verification_reference => 'agent_job:70000000-0000-4000-8000-000000000001',
      p_observed_at => '2020-01-02T00:00:00Z',
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled incident reconciliation to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.incident_recovery_reconcile_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_incident_id => '60000000-0000-4000-8000-000000000001',
      p_work_item_id => '50000000-0000-4000-8000-000000000001',
      p_expected_work_item_revision => 1,
      p_idempotency_key => 'fixture:incident:predates',
      p_request_fingerprint => repeat('3', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_verification_method => 'successful_run',
      p_verification_reference => 'agent_job:70000000-0000-4000-8000-000000000001',
      p_observed_at => '2019-12-31T00:00:00Z',
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected pre-incident recovery evidence to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.incident_recovery_reconcile_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_incident_id => '60000000-0000-4000-8000-000000000001',
      p_work_item_id => '50000000-0000-4000-8000-000000000001',
      p_expected_work_item_revision => 1,
      p_idempotency_key => 'fixture:incident:missing-proof',
      p_request_fingerprint => repeat('5', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_verification_method => 'successful_run',
      p_verification_reference => 'agent_job:70000000-0000-4000-8000-000000000099',
      p_observed_at => '2020-01-02T00:00:00Z',
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected nonexistent recovery evidence to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.incident_recovery_reconcile_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_incident_id => '60000000-0000-4000-8000-000000000001',
      p_work_item_id => '50000000-0000-4000-8000-000000000002',
      p_expected_work_item_revision => 1,
      p_idempotency_key => 'fixture:incident:cross-tenant',
      p_request_fingerprint => repeat('6', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_verification_method => 'successful_run',
      p_verification_reference => 'agent_job:70000000-0000-4000-8000-000000000001',
      p_observed_at => '2020-01-02T00:00:00Z',
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant incident work link to fail';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  reconciled_result := public.incident_recovery_reconcile_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_incident_id => '60000000-0000-4000-8000-000000000001',
    p_work_item_id => '50000000-0000-4000-8000-000000000001',
    p_expected_work_item_revision => 1,
    p_idempotency_key => 'fixture:incident:recovered',
    p_request_fingerprint => repeat('4', 64),
    p_actor_type => 'system',
    p_actor_id => NULL,
    p_actor_authority_tier => 'system',
    p_verification_method => 'successful_run',
    p_verification_reference => 'agent_job:70000000-0000-4000-8000-000000000001',
    p_observed_at => '2020-01-02T00:00:00Z',
    p_feature_gate_enabled => true
  );
  IF reconciled_result->>'outcome' <> 'reconciled'
     OR reconciled_result->'work_item'->>'status' <> 'verified'
     OR reconciled_result->'incident'->>'status' <> 'recovered'
     OR reconciled_result->>'attention_outcome' <> 'superseded' THEN
    RAISE EXCEPTION 'incident reconciliation did not commit every target';
  END IF;

  replay_result := public.incident_recovery_reconcile_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_incident_id => '60000000-0000-4000-8000-000000000001',
    p_work_item_id => '50000000-0000-4000-8000-000000000001',
    p_expected_work_item_revision => 1,
    p_idempotency_key => 'fixture:incident:recovered',
    p_request_fingerprint => repeat('4', 64),
    p_actor_type => 'system',
    p_actor_id => NULL,
    p_actor_authority_tier => 'system',
    p_verification_method => 'successful_run',
    p_verification_reference => 'agent_job:70000000-0000-4000-8000-000000000001',
    p_observed_at => '2020-01-02T00:00:00Z',
    p_feature_gate_enabled => true
  );
  IF replay_result->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected incident reconciliation replay';
  END IF;

  SELECT count(*) INTO event_count
    FROM public.incident_reconciliation_events
   WHERE incident_id = '60000000-0000-4000-8000-000000000001';
  IF event_count <> 1 THEN
    RAISE EXCEPTION 'expected one immutable incident reconciliation event';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.attention_queue
     WHERE id = '99999999-1111-4111-8111-111111111111'
       AND resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'recovered incident attention remained falsely open';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ops_incidents
     WHERE id = '60000000-0000-4000-8000-000000000002'
       AND status <> 'open'
  ) OR EXISTS (
    SELECT 1 FROM public.attention_queue
     WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
       AND resolved_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'cross-tenant reconciliation mutated tenant B state';
  END IF;
END $$;

INSERT INTO public.documents (
  id, tenant_id, title, document_type
) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'Tenant A procedure', 'procedure'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'Tenant A client collateral', 'brochure'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    'Tenant A restricted evidence', 'evidence'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '22222222-2222-4222-8222-222222222222',
    'Tenant B client collateral', 'brochure'
  );

UPDATE public.documents
   SET classification = 'client'
 WHERE id IN (
   '20000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000004'
 );
UPDATE public.documents
   SET classification = 'restricted'
 WHERE id = '20000000-0000-4000-8000-000000000003';

INSERT INTO public.document_access_grants (
  tenant_id, document_id, principal_type, principal_id, permissions
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  '20000000-0000-4000-8000-000000000003',
  'user',
  'eeeeeeee-1111-4111-8111-111111111111',
  ARRAY['read']::text[]
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.document_versions (
      tenant_id, document_id, version_number, storage_path,
      original_filename, mime_type, byte_size, sha256
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',
      '20000000-0000-4000-8000-000000000001',
      1,
      '22222222-2222-4222-8222-222222222222/20000000-0000-4000-8000-000000000001/1/a.pdf',
      'a.pdf', 'application/pdf', 1, repeat('a', 64)
    );
    RAISE EXCEPTION 'expected cross-tenant document version to fail';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.document_versions (
      tenant_id, document_id, version_number, storage_path,
      original_filename, mime_type, byte_size, sha256
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '20000000-0000-4000-8000-000000000001',
      1,
      '22222222-2222-4222-8222-222222222222/20000000-0000-4000-8000-000000000001/1/a.pdf',
      'a.pdf', 'application/pdf', 1, repeat('a', 64)
    );
    RAISE EXCEPTION 'expected mismatched storage path to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO public.scheduling_policies (
  id, tenant_id, timezone, provider
) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'America/New_York', 'shadow'
);

INSERT INTO public.appointment_workflows (
  id, tenant_id, policy_id, lead_id, customer_id, owner_user_id,
  appointment_type, idempotency_key
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '30000000-0000-4000-8000-000000000001',
  'aaaaaaaa-1111-4111-8111-111111111111',
  'cccccccc-1111-4111-8111-111111111111',
  'eeeeeeee-1111-4111-8111-111111111111',
  'sales-demo', 'fixture:appointment:a'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.appointment_workflows (
      tenant_id, lead_id, appointment_type, idempotency_key
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-2222-4222-8222-222222222222',
      'sales-demo', 'fixture:appointment:cross-tenant'
    );
    RAISE EXCEPTION 'expected cross-tenant appointment lead to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant appointment lead to fail' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.appointment_events (
      tenant_id, appointment_id, event_type, idempotency_key
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',
      '40000000-0000-4000-8000-000000000001',
      'created', 'fixture:appointment:event:cross'
    );
    RAISE EXCEPTION 'expected cross-tenant appointment event to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant appointment event to fail' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.referral_credits (
      tenant_id, referrer_lead_id, referee_lead_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-2222-4222-8222-222222222222',
      'aaaaaaaa-1111-4111-8111-111111111111'
    );
    RAISE EXCEPTION 'expected cross-tenant referral to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant referral to fail' THEN RAISE; END IF;
  END;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"owner"}}',
  true
);
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.work_items;
  IF visible_count <> 3 THEN
    RAISE EXCEPTION 'tenant A owner expected 3 visible work items, got %', visible_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.work_items
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A owner can see tenant B work';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"eeeeeeee-1111-4111-8111-111111111111","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"member"}}',
  true
);
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.documents;
  IF visible_count <> 2 THEN
    RAISE EXCEPTION
      'member expected client material plus explicitly granted evidence, got %',
      visible_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.documents
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A member can see tenant B documents';
  END IF;
  IF EXISTS (SELECT 1 FROM public.document_access_grants) THEN
    RAISE EXCEPTION 'tenant member can enumerate document grants';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"eeeeeeee-1111-4111-8111-111111111111","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"manager"}}',
  true
);
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.documents;
  IF visible_count <> 3 THEN
    RAISE EXCEPTION
      'manager with an explicit restricted grant expected 3 documents, got %',
      visible_count;
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.work_items
     WHERE id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'client_owner cannot read its tenant work';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"tenant_owner"}}',
  true
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.work_items
     WHERE id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'tenant_owner cannot read its tenant work';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"member"}}',
  true
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.work_items) THEN
    RAISE EXCEPTION 'unauthorized tenant member can see executive work';
  END IF;
END $$;
ROLLBACK;
