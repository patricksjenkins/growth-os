\set ON_ERROR_STOP on

-- Run after autonomous-os-tenant-negative.sql. Uses only synthetic fixture IDs.
INSERT INTO public.appointment_workflows (
  id, tenant_id, lead_id, appointment_type, idempotency_key
) VALUES (
  '40000000-0000-4000-8000-000000000002',
  '22222222-2222-4222-8222-222222222222',
  'bbbbbbbb-2222-4222-8222-222222222222',
  'sales-demo',
  'fixture:appointment:b'
);

INSERT INTO public.scheduling_automation_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged,
  activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true,
    'shadow',
    false,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_test_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    false,
    'disabled',
    true,
    NULL,
    '{}'::jsonb
  );

BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.appointment_lifecycle_controls (
      tenant_id, appointment_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '40000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'expected direct lifecycle service write to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

DO $$
DECLARE
  applied jsonb;
  replayed jsonb;
  tenant_b_events integer;
  tenant_b_revision bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  BEGIN
    PERFORM public.appointment_lifecycle_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_appointment_id => '40000000-0000-4000-8000-000000000001',
      p_action => 'mark_invitation_ready',
      p_expected_revision => 0,
      p_idempotency_key => 'fixture:lifecycle:flag-off',
      p_request_fingerprint => repeat('a', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_evidence => jsonb_build_object(
        'source_type', 'policy_evaluation',
        'source_id', 'fixture-policy-a',
        'observed_at', now()
      ),
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled lifecycle flag to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.appointment_lifecycle_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_appointment_id => '40000000-0000-4000-8000-000000000002',
      p_action => 'mark_invitation_ready',
      p_expected_revision => 0,
      p_idempotency_key => 'fixture:lifecycle:cross-tenant',
      p_request_fingerprint => repeat('b', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_evidence => jsonb_build_object(
        'source_type', 'policy_evaluation',
        'source_id', 'fixture-policy-a',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant lifecycle command to fail';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  applied := public.appointment_lifecycle_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_appointment_id => '40000000-0000-4000-8000-000000000001',
    p_action => 'mark_invitation_ready',
    p_expected_revision => 0,
    p_idempotency_key => 'fixture:lifecycle:invitation-ready',
    p_request_fingerprint => repeat('c', 64),
    p_actor_type => 'system',
    p_actor_id => NULL,
    p_actor_authority_tier => 'system',
    p_evidence => jsonb_build_object(
      'source_type', 'policy_evaluation',
      'source_id', 'fixture-policy-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true
  );
  IF applied->>'outcome' <> 'applied'
     OR applied->'control'->>'lifecycle_state' <> 'invitation_ready'
     OR (applied->'control'->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'lifecycle command returned false success';
  END IF;

  replayed := public.appointment_lifecycle_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_appointment_id => '40000000-0000-4000-8000-000000000001',
    p_action => 'mark_invitation_ready',
    p_expected_revision => 0,
    p_idempotency_key => 'fixture:lifecycle:invitation-ready',
    p_request_fingerprint => repeat('c', 64),
    p_actor_type => 'system',
    p_actor_id => NULL,
    p_actor_authority_tier => 'system',
    p_evidence => applied->'event'->'evidence',
    p_feature_gate_enabled => true
  );
  IF replayed->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected lifecycle command replay';
  END IF;

  BEGIN
    PERFORM public.appointment_lifecycle_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_appointment_id => '40000000-0000-4000-8000-000000000001',
      p_action => 'record_invitation_delivery',
      p_expected_revision => 0,
      p_idempotency_key => 'fixture:lifecycle:stale-revision',
      p_request_fingerprint => repeat('d', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_evidence => jsonb_build_object(
        'source_type', 'provider_receipt',
        'source_id', 'fixture-provider-receipt',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected stale lifecycle revision to fail';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  SELECT count(*) INTO tenant_b_events
    FROM public.appointment_lifecycle_events event
   WHERE event.tenant_id = '22222222-2222-4222-8222-222222222222';
  SELECT revision INTO tenant_b_revision
    FROM public.scheduling_automation_controls control
   WHERE control.tenant_id = '22222222-2222-4222-8222-222222222222';
  IF tenant_b_events <> 0 OR tenant_b_revision <> 0 THEN
    RAISE EXCEPTION 'tenant B lifecycle state changed during tenant A commands';
  END IF;

  PERFORM public.scheduling_lifecycle_kill_switch_rpc(
    '11111111-1111-4111-8111-111111111111',
    'synthetic_test_stop'
  );

  BEGIN
    PERFORM public.appointment_lifecycle_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_appointment_id => '40000000-0000-4000-8000-000000000001',
      p_action => 'record_invitation_delivery',
      p_expected_revision => 1,
      p_idempotency_key => 'fixture:lifecycle:killed',
      p_request_fingerprint => repeat('e', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_actor_authority_tier => 'system',
      p_evidence => jsonb_build_object(
        'source_type', 'provider_receipt',
        'source_id', 'fixture-provider-receipt',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected engaged lifecycle kill switch to fail';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
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
DECLARE
  tenant_a_count integer;
  tenant_b_count integer;
BEGIN
  SELECT count(*) INTO tenant_a_count
    FROM public.appointment_lifecycle_controls;
  IF tenant_a_count <> 1 THEN
    RAISE EXCEPTION 'tenant A owner did not see exactly its lifecycle control';
  END IF;
  SELECT count(*) INTO tenant_b_count
    FROM public.appointment_lifecycle_controls
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  IF tenant_b_count <> 0 THEN
    RAISE EXCEPTION 'tenant A owner saw tenant B lifecycle control';
  END IF;
END $$;
ROLLBACK;
