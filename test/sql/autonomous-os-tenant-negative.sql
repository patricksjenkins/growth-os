\set ON_ERROR_STOP on

INSERT INTO public.tenants (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

INSERT INTO public.attention_queue (id, tenant_id) VALUES
  ('99999999-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.leads (id, tenant_id, status) VALUES
  (
    'aaaaaaaa-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'won'
  ),
  (
    'bbbbbbbb-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'won'
  );
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

INSERT INTO public.onboarding_workflows (id, tenant_id, status) VALUES
  (
    '66666666-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'active'
  ),
  (
    '66666666-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'active'
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

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.closed_won_onboarding_handoff_rpc(
      p_action => 'initiate',
      p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_idempotency_key => 'fixture:onboarding:auth-denied',
      p_request_fingerprint => repeat('1', 64),
      p_actor_type => 'human',
      p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_source_event_key => 'fixture:closed-won:auth-denied',
      p_closed_won_at => '2026-07-24T12:00:00Z',
      p_accept_by => '2030-01-01T12:00:00Z',
      p_acknowledge_by => '2030-01-01T13:00:00Z',
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected authenticated onboarding RPC to fail';
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
    INSERT INTO public.closed_won_onboarding_handoffs (
      source_tenant_id,
      client_tenant_id,
      closed_won_event_id,
      lead_id,
      customer_id,
      accept_by,
      acknowledge_by
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      gen_random_uuid(),
      'aaaaaaaa-1111-4111-8111-111111111111',
      'cccccccc-1111-4111-8111-111111111111',
      '2030-01-01T12:00:00Z',
      '2030-01-01T13:00:00Z'
    );
    RAISE EXCEPTION 'expected direct service-role onboarding write to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  initiated jsonb;
  replayed jsonb;
  accepted jsonb;
  acknowledged jsonb;
  completed jsonb;
  v_handoff_id uuid;
  event_count integer;
  tenant_b_workflow_count integer;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  BEGIN
    PERFORM public.closed_won_onboarding_handoff_rpc(
      p_action => 'initiate',
      p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_idempotency_key => 'fixture:onboarding:gate-off',
      p_request_fingerprint => repeat('2', 64),
      p_actor_type => 'human',
      p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_source_event_key => 'fixture:closed-won:gate-off',
      p_closed_won_at => '2026-07-24T12:00:00Z',
      p_accept_by => '2030-01-01T12:00:00Z',
      p_acknowledge_by => '2030-01-01T13:00:00Z',
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled onboarding RPC to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.closed_won_onboarding_handoff_rpc(
      p_action => 'initiate',
      p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_idempotency_key => 'fixture:onboarding:cross-customer',
      p_request_fingerprint => repeat('3', 64),
      p_actor_type => 'human',
      p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_customer_id => 'dddddddd-2222-4222-8222-222222222222',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_source_event_key => 'fixture:closed-won:cross-customer',
      p_closed_won_at => '2026-07-24T12:00:00Z',
      p_accept_by => '2030-01-01T12:00:00Z',
      p_acknowledge_by => '2030-01-01T13:00:00Z',
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant onboarding customer to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'closed_won_customer_tenant_mismatch' THEN RAISE; END IF;
  END;

  initiated := public.closed_won_onboarding_handoff_rpc(
    p_action => 'initiate',
    p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_idempotency_key => 'fixture:onboarding:initiate',
    p_request_fingerprint => repeat('4', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_source_event_key => 'fixture:closed-won:tenant-a',
    p_closed_won_at => '2026-07-24T12:00:00Z',
    p_accept_by => '2030-01-01T12:00:00Z',
    p_acknowledge_by => '2030-01-01T13:00:00Z',
    p_feature_gate_enabled => true
  );
  IF initiated->>'outcome' <> 'created'
     OR initiated->'handoff'->>'source_tenant_id'
        <> '11111111-1111-4111-8111-111111111111'
     OR initiated->'handoff'->>'client_tenant_id'
        <> '22222222-2222-4222-8222-222222222222' THEN
    RAISE EXCEPTION 'closed-won initiation returned false success';
  END IF;
  v_handoff_id := (initiated->'handoff'->>'id')::uuid;

  replayed := public.closed_won_onboarding_handoff_rpc(
    p_action => 'initiate',
    p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_idempotency_key => 'fixture:onboarding:initiate',
    p_request_fingerprint => repeat('4', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_source_event_key => 'fixture:closed-won:tenant-a',
    p_closed_won_at => '2026-07-24T12:00:00Z',
    p_accept_by => '2030-01-01T12:00:00Z',
    p_acknowledge_by => '2030-01-01T13:00:00Z',
    p_feature_gate_enabled => true
  );
  IF replayed->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected closed-won initiation replay';
  END IF;

  -- The immutable closed-won snapshot remains valid even when the live lead
  -- advances; later handoff transitions must not become permanently frozen.
  UPDATE public.leads
     SET status = 'onboarding'
   WHERE id = 'aaaaaaaa-1111-4111-8111-111111111111';

  BEGIN
    PERFORM public.closed_won_onboarding_handoff_rpc(
      p_action => 'accept',
      p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_idempotency_key => 'fixture:onboarding:system-spoof',
      p_request_fingerprint => repeat('9', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_handoff_id => v_handoff_id,
      p_expected_revision => 1,
      p_reason_code => 'system_acceptance_spoof',
      p_evidence_type => 'owner_acceptance',
      p_evidence_id => 'system:untrusted',
      p_evidence_digest => repeat('9', 64),
      p_evidence_observed_at => now(),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected system onboarding acceptance to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'closed_won_handoff_not_accept_ready' THEN RAISE; END IF;
  END;

  accepted := public.closed_won_onboarding_handoff_rpc(
    p_action => 'accept',
    p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_idempotency_key => 'fixture:onboarding:accept',
    p_request_fingerprint => repeat('5', 64),
    p_actor_type => 'service',
    p_actor_id => 'onboarding-handoff-supervisor',
    p_handoff_id => v_handoff_id,
    p_expected_revision => 1,
    p_reason_code => 'supervisor_accepted',
    p_evidence_type => 'service_acceptance',
    p_evidence_id => 'service:onboarding-handoff-supervisor',
    p_evidence_digest => repeat('a', 64),
    p_evidence_observed_at => now(),
    p_feature_gate_enabled => true
  );
  IF accepted->'handoff'->>'state' <> 'accepted'
     OR (accepted->'handoff'->>'revision')::integer <> 2 THEN
    RAISE EXCEPTION 'closed-won acceptance did not commit';
  END IF;

  acknowledged := public.closed_won_onboarding_handoff_rpc(
    p_action => 'acknowledge',
    p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_idempotency_key => 'fixture:onboarding:acknowledge',
    p_request_fingerprint => repeat('6', 64),
    p_actor_type => 'service',
    p_actor_id => 'onboarding-supervisor',
    p_handoff_id => v_handoff_id,
    p_expected_revision => 2,
    p_onboarding_workflow_id => '66666666-2222-4222-8222-222222222222',
    p_reason_code => 'workflow_acknowledged',
    p_evidence_type => 'onboarding_workflow',
    p_evidence_id =>
      'onboarding_workflow:66666666-2222-4222-8222-222222222222',
    p_evidence_digest => repeat('b', 64),
    p_evidence_observed_at => now(),
    p_feature_gate_enabled => true
  );
  IF acknowledged->'handoff'->>'state' <> 'acknowledged'
     OR acknowledged->'handoff'->>'acknowledgment_state' <> 'acknowledged'
     OR acknowledged->'handoff'->>'onboarding_workflow_id'
        <> '66666666-2222-4222-8222-222222222222' THEN
    RAISE EXCEPTION 'closed-won acknowledgment lacked workflow evidence';
  END IF;

  BEGIN
    PERFORM public.closed_won_onboarding_handoff_rpc(
      p_action => 'complete',
      p_source_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_idempotency_key => 'fixture:onboarding:cross-transition',
      p_request_fingerprint => repeat('7', 64),
      p_actor_type => 'human',
      p_actor_id => 'ffffffff-2222-4222-8222-222222222222',
      p_handoff_id => v_handoff_id,
      p_expected_revision => 3,
      p_reason_code => 'cross_tenant_attempt',
      p_evidence_type => 'completion',
      p_evidence_id => 'completion:cross-tenant',
      p_evidence_digest => repeat('c', 64),
      p_evidence_observed_at => now(),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant onboarding transition to fail';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  completed := public.closed_won_onboarding_handoff_rpc(
    p_action => 'complete',
    p_source_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_idempotency_key => 'fixture:onboarding:complete',
    p_request_fingerprint => repeat('8', 64),
    p_actor_type => 'service',
    p_actor_id => 'onboarding-supervisor',
    p_handoff_id => v_handoff_id,
    p_expected_revision => 3,
    p_reason_code => 'handoff_completed',
    p_evidence_type => 'completion',
    p_evidence_id => 'completion:workflow-accepted',
    p_evidence_digest => repeat('d', 64),
    p_evidence_observed_at => now(),
    p_feature_gate_enabled => true
  );
  IF completed->'handoff'->>'state' <> 'completed'
     OR completed->'handoff'->>'evidence_state' <> 'completion_proven' THEN
    RAISE EXCEPTION 'closed-won completion returned false success';
  END IF;

  SELECT count(*) INTO event_count
    FROM public.closed_won_onboarding_events
   WHERE handoff_id = v_handoff_id;
  IF event_count <> 4 THEN
    RAISE EXCEPTION 'expected four immutable handoff events, got %', event_count;
  END IF;

  SELECT count(*) INTO tenant_b_workflow_count
    FROM public.onboarding_workflows
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  IF tenant_b_workflow_count <> 1 THEN
    RAISE EXCEPTION 'closed-won handoff mutated client workflow inventory';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.appointment_provider_event_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_provider => 'calendly',
      p_provider_event_id =>
        'https://api.calendly.com/scheduled_events/fixture-a',
      p_event_type => 'booked',
      p_appointment_type => 'discovery',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_scheduled_start => '2030-01-01T15:00:00Z',
      p_scheduled_end => '2030-01-01T15:30:00Z',
      p_idempotency_key => 'fixture:calendly:auth-denied',
      p_request_fingerprint => repeat('1', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected authenticated appointment projection to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  booked jsonb;
  replayed jsonb;
  cancelled jsonb;
  cancel_replay jsonb;
  v_appointment_id uuid;
  event_count integer;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  BEGIN
    PERFORM public.appointment_provider_event_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_provider => 'calendly',
      p_provider_event_id =>
        'https://api.calendly.com/scheduled_events/fixture-a',
      p_event_type => 'booked',
      p_appointment_type => 'discovery',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_scheduled_start => '2030-01-01T15:00:00Z',
      p_scheduled_end => '2030-01-01T15:30:00Z',
      p_idempotency_key => 'fixture:calendly:gate-off',
      p_request_fingerprint => repeat('2', 64),
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled appointment projection to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.appointment_provider_event_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_provider => 'calendly',
      p_provider_event_id =>
        'https://api.calendly.com/scheduled_events/fixture-cross',
      p_event_type => 'booked',
      p_appointment_type => 'discovery',
      p_lead_id => 'bbbbbbbb-2222-4222-8222-222222222222',
      p_scheduled_start => '2030-01-01T16:00:00Z',
      p_scheduled_end => '2030-01-01T16:30:00Z',
      p_idempotency_key => 'fixture:calendly:cross-tenant',
      p_request_fingerprint => repeat('3', 64),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant appointment lead to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  booked := public.appointment_provider_event_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_provider => 'calendly',
    p_provider_event_id =>
      'https://api.calendly.com/scheduled_events/fixture-a',
    p_event_type => 'booked',
    p_appointment_type => 'discovery',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_scheduled_start => '2030-01-01T15:00:00Z',
    p_scheduled_end => '2030-01-01T15:30:00Z',
    p_idempotency_key => 'fixture:calendly:booked',
    p_request_fingerprint => repeat('4', 64),
    p_feature_gate_enabled => true
  );
  IF booked->>'outcome' <> 'scheduled'
     OR booked->'appointment'->>'status' <> 'scheduled'
     OR booked->'appointment'->>'tenant_id'
        <> '11111111-1111-4111-8111-111111111111' THEN
    RAISE EXCEPTION 'appointment booking projection returned false success';
  END IF;
  v_appointment_id := (booked->'appointment'->>'id')::uuid;

  replayed := public.appointment_provider_event_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_provider => 'calendly',
    p_provider_event_id =>
      'https://api.calendly.com/scheduled_events/fixture-a',
    p_event_type => 'booked',
    p_appointment_type => 'discovery',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_scheduled_start => '2030-01-01T15:00:00Z',
    p_scheduled_end => '2030-01-01T15:30:00Z',
    p_idempotency_key => 'fixture:calendly:booked',
    p_request_fingerprint => repeat('4', 64),
    p_feature_gate_enabled => true
  );
  IF replayed->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected appointment booking replay';
  END IF;

  cancelled := public.appointment_provider_event_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_provider => 'calendly',
    p_provider_event_id =>
      'https://api.calendly.com/scheduled_events/fixture-a',
    p_event_type => 'cancelled',
    p_appointment_type => 'discovery',
    p_lead_id => NULL,
    p_scheduled_start => NULL,
    p_scheduled_end => NULL,
    p_idempotency_key => 'fixture:calendly:cancelled',
    p_request_fingerprint => repeat('5', 64),
    p_feature_gate_enabled => true
  );
  IF cancelled->>'outcome' <> 'cancelled'
     OR cancelled->'appointment'->>'status' <> 'cancelled' THEN
    RAISE EXCEPTION 'appointment cancellation projection returned false success';
  END IF;

  cancel_replay := public.appointment_provider_event_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_provider => 'calendly',
    p_provider_event_id =>
      'https://api.calendly.com/scheduled_events/fixture-a',
    p_event_type => 'cancelled',
    p_appointment_type => 'discovery',
    p_lead_id => NULL,
    p_scheduled_start => NULL,
    p_scheduled_end => NULL,
    p_idempotency_key => 'fixture:calendly:cancelled',
    p_request_fingerprint => repeat('5', 64),
    p_feature_gate_enabled => true
  );
  IF cancel_replay->>'outcome' <> 'replay'
     OR cancel_replay->'appointment'->>'status' <> 'cancelled' THEN
    RAISE EXCEPTION 'expected cancellation replay with current cancelled state';
  END IF;

  SELECT count(*) INTO event_count
    FROM public.appointment_events event
   WHERE event.appointment_id = v_appointment_id;
  IF event_count <> 2 THEN
    RAISE EXCEPTION 'expected one booking and one cancellation event, got %',
      event_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.appointment_workflows
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant B appointment state changed during tenant A test';
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
