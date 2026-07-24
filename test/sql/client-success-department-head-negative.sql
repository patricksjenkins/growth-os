\set ON_ERROR_STOP on

-- Migration 089 runtime proof. Synthetic identifiers and aggregate evidence
-- only. Run after autonomous-os-bootstrap, migration 083, and migration 089.
INSERT INTO public.tenants (id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.customers (id, tenant_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
   '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
   '22222222-2222-4222-8222-222222222222')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-1111-4111-8111-111111111111', 'owner'),
  ('22222222-2222-4222-8222-222222222222',
   'bbbbbbbb-2222-4222-8222-222222222222', 'owner')
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role;

INSERT INTO public.client_health_signal_snapshots (
  id, tenant_id, customer_id, signal_state, provenance_type, dimensions,
  outcome_evidence_eligible, evidence, evidence_digest, evidence_observed_at,
  actor_type, actor_id, authority_tier, idempotency_key,
  request_fingerprint, semantic_fingerprint
) VALUES
  (
    '31000000-0000-4310-8310-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'stable', 'observed', '{"retention_bps":9600}'::jsonb, true,
    '{"source":"synthetic_health_ledger"}'::jsonb, repeat('1', 64),
    now() - interval '1 hour', 'service', 'health-ledger', 'client_success',
    'client-success:health:stable', repeat('1', 64), repeat('2', 64)
  ),
  (
    '32000000-0000-4320-8320-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'at_risk', 'observed', '{"retention_bps":7000}'::jsonb, true,
    '{"source":"synthetic_health_ledger"}'::jsonb, repeat('2', 64),
    now() - interval '2 hour', 'service', 'health-ledger', 'client_success',
    'client-success:health:completed', repeat('2', 64), repeat('3', 64)
  ),
  (
    '33000000-0000-4330-8330-000000000003',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'stable', 'observed', '{"retention_bps":9700}'::jsonb, true,
    '{"source":"synthetic_health_ledger"}'::jsonb, repeat('3', 64),
    now() - interval '30 minutes', 'service', 'health-ledger', 'client_success',
    'client-success:health:improved', repeat('3', 64), repeat('4', 64)
  ),
  (
    '34000000-0000-4340-8340-000000000004',
    '22222222-2222-4222-8222-222222222222',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    'stable', 'observed', '{"retention_bps":9500}'::jsonb, true,
    '{"source":"synthetic_health_ledger"}'::jsonb, repeat('4', 64),
    now() - interval '1 hour', 'service', 'health-ledger', 'client_success',
    'client-success:health:tenant-b', repeat('4', 64), repeat('5', 64)
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.client_health_interventions (
  id, tenant_id, customer_id, source_signal_snapshot_id, lifecycle_state,
  revision, owner_id, assignee_id, action_plan, assigned_at, accepted_at,
  sla_due_at, action_completed_at, completion_evidence_digest,
  outcome_state, outcome_evidence_digest, outcome_observed_at,
  last_action_at
) VALUES
  (
    '41000000-0000-4410-8410-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '32000000-0000-4320-8320-000000000002',
    'action_completed', 3,
    'aaaaaaaa-1111-4111-8111-111111111111',
    'aaaaaaaa-1111-4111-8111-111111111111',
    '{"objective":"restore service","action_type":"internal_review","success_metric":"observed retention"}'::jsonb,
    now() - interval '4 days', now() - interval '4 days',
    now() - interval '2 days', now() - interval '3 days', repeat('5', 64),
    'unproven', NULL, NULL, now() - interval '3 days'
  ),
  (
    '42000000-0000-4420-8420-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '33000000-0000-4330-8330-000000000003',
    'outcome_recorded', 4,
    'aaaaaaaa-1111-4111-8111-111111111111',
    'aaaaaaaa-1111-4111-8111-111111111111',
    '{"objective":"restore service","action_type":"internal_review","success_metric":"observed retention"}'::jsonb,
    now() - interval '7 days', now() - interval '7 days',
    now() - interval '5 days', now() - interval '6 days', repeat('6', 64),
    'improved', repeat('7', 64), now() - interval '30 minutes',
    now() - interval '30 minutes'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.client_success_head_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged,
  registered_agent_id, registered_support_adapter_id, activated_by,
  activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true, 'supervised_read_only', false, 'client-success-head-a',
    'client-success-support-adapter-a',
    'aaaaaaaa-1111-4111-8111-111111111111',
    '{"source":"synthetic_owner_activation"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    true, 'supervised_read_only', false, 'client-success-head-b',
    'client-success-support-adapter-b',
    'bbbbbbbb-2222-4222-8222-222222222222',
    '{"source":"synthetic_owner_activation"}'::jsonb
  )
ON CONFLICT (tenant_id) DO NOTHING;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.client_success_support_snapshots (
      id, tenant_id, customer_id, source_snapshot_id, evidence_digest,
      observed_at, verification_state, opened_tickets, resolved_tickets,
      sla_breached_tickets, open_critical_tickets, first_response_minutes,
      resolution_minutes, csat_bps, recorded_by_adapter_id, idempotency_key,
      request_fingerprint
    ) VALUES (
      '76000000-0000-4760-8760-000000000006',
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      'cross_tenant_direct_snapshot', repeat('6', 64),
      now() - interval '1 hour', 'verified', 1, 1, 0, 0, 10, 60, 9800,
      'client-success-support-adapter-a',
      'client-success:support:cross-direct', repeat('6', 64)
    );
    RAISE EXCEPTION 'expected direct cross-tenant support snapshot denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    UPDATE public.client_success_head_controls
       SET updated_at = now()
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected direct authenticated client success write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.client_success_head_charter_register_rpc(
      '11111111-1111-4111-8111-111111111111', 1,
      'Own observed client outcomes and escalate material service exceptions with accountable follow-through.',
      60, 1440, 500, 9000, 1,
      'aaaaaaaa-1111-4111-8111-111111111111',
      '{"schema_version":1,"sources":[{"source_type":"owner_charter","source_id":"authenticated","evidence_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:authenticated', repeat('1', 64), true
    );
    RAISE EXCEPTION 'expected authenticated client success RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  v_charter_a uuid;
  v_charter_b uuid;
  v_result jsonb;
  v_before text;
BEGIN
  BEGIN
    UPDATE public.client_success_head_controls
       SET updated_at = now()
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected direct service-role client success write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.client_success_head_charter_register_rpc(
      '11111111-1111-4111-8111-111111111111', 1,
      'Own observed client outcomes and escalate material service exceptions with accountable follow-through.',
      60, 1440, 500, 9000, 1,
      'aaaaaaaa-1111-4111-8111-111111111111',
      '{"schema_version":1,"sources":[{"source_type":"owner_charter","source_id":"disabled","evidence_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:disabled', repeat('1', 64), false
    );
    RAISE EXCEPTION 'expected disabled client success write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  SELECT (public.client_success_head_charter_register_rpc(
    '11111111-1111-4111-8111-111111111111', 1,
    'Own observed client outcomes and escalate material service exceptions with accountable follow-through.',
    60, 1440, 500, 9000, 1,
    'aaaaaaaa-1111-4111-8111-111111111111',
    '{"schema_version":1,"sources":[{"source_type":"owner_charter","source_id":"charter_a","evidence_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:charter:a', repeat('a', 64), true
  )->'charter'->>'id')::uuid INTO v_charter_a;
  SELECT (public.client_success_head_charter_register_rpc(
    '22222222-2222-4222-8222-222222222222', 1,
    'Own observed client outcomes and escalate material service exceptions with accountable follow-through.',
    60, 1440, 500, 9000, 1,
    'bbbbbbbb-2222-4222-8222-222222222222',
    '{"schema_version":1,"sources":[{"source_type":"owner_charter","source_id":"charter_b","evidence_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:charter:b', repeat('b', 64), true
  )->'charter'->>'id')::uuid INTO v_charter_b;

  BEGIN
    PERFORM public.client_success_support_snapshot_record_rpc(
      '11111111-1111-4111-8111-111111111111',
      '70000000-0000-4700-8700-000000000000',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'wrong_adapter', repeat('0', 64), now() - interval '1 hour',
      'verified', 1, 1, 0, 0, 10, 60, 9800,
      'client-success-head-a', 'support_evidence_adapter',
      'client-success:support:wrong-adapter', repeat('0', 64), true
    );
    RAISE EXCEPTION 'expected unregistered support adapter denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM public.client_success_support_snapshot_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    '71000000-0000-4710-8710-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'stable_support', repeat('1', 64), now() - interval '1 hour',
    'unverified', 10, 10, 0, 0, 30, 600, 9500,
    'client-success-support-adapter-a', 'support_evidence_adapter',
    'client-success:support:stable-unverified', repeat('1', 64), true
  );
  PERFORM public.client_success_support_snapshot_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    '72000000-0000-4720-8720-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'stable_support_verified', repeat('2', 64), now() - interval '1 hour',
    'verified', 10, 10, 0, 0, 30, 600, 9500,
    'client-success-support-adapter-a', 'support_evidence_adapter',
    'client-success:support:stable-verified', repeat('2', 64), true
  );
  PERFORM public.client_success_support_snapshot_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    '73000000-0000-4730-8730-000000000003',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'completed_support', repeat('3', 64), now() - interval '1 hour',
    'verified', 10, 10, 0, 0, 30, 600, 9500,
    'client-success-support-adapter-a', 'support_evidence_adapter',
    'client-success:support:completed', repeat('3', 64), true
  );
  PERFORM public.client_success_support_snapshot_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    '74000000-0000-4740-8740-000000000004',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'improved_support', repeat('4', 64), now() - interval '1 hour',
    'verified', 10, 10, 0, 0, 30, 600, 9500,
    'client-success-support-adapter-a', 'support_evidence_adapter',
    'client-success:support:improved', repeat('4', 64), true
  );
  PERFORM public.client_success_support_snapshot_record_rpc(
    '22222222-2222-4222-8222-222222222222',
    '75000000-0000-4750-8750-000000000005',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    'tenant_b_support', repeat('5', 64), now() - interval '1 hour',
    'verified', 1, 1, 0, 0, 10, 60, 9800,
    'client-success-support-adapter-b', 'support_evidence_adapter',
    'client-success:support:tenant-b', repeat('5', 64), true
  );

  BEGIN
    PERFORM public.client_success_head_report_accept_rpc(
      '11111111-1111-4111-8111-111111111111',
      '51000000-0000-4510-8510-000000000001', v_charter_a,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      '34000000-0000-4340-8340-000000000004', NULL,
      '75000000-0000-4750-8750-000000000005',
      '2026-07-01', '2026-07-31',
      'client-success-head-a', 'department_head',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"cross_tenant_health","evidence_digest":"1111111111111111111111111111111111111111111111111111111111111111","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:report:cross', repeat('1',64), true
    );
    RAISE EXCEPTION 'expected cross-tenant health evidence denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.client_success_head_report_accept_rpc(
      '11111111-1111-4111-8111-111111111111',
      '51000000-0000-4510-8510-000000000001', v_charter_a,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      '31000000-0000-4310-8310-000000000001', NULL,
      '75000000-0000-4750-8750-000000000005',
      '2026-07-01', '2026-07-31',
      'client-success-head-a', 'department_head',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"cross_tenant_support","evidence_digest":"1111111111111111111111111111111111111111111111111111111111111111","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:report:cross-support', repeat('1',64), true
    );
    RAISE EXCEPTION 'expected cross-tenant support evidence denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.client_success_head_report_accept_rpc(
      '11111111-1111-4111-8111-111111111111',
      '51000000-0000-4510-8510-000000000001', v_charter_a,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      '31000000-0000-4310-8310-000000000001', NULL,
      '71000000-0000-4710-8710-000000000001',
      '2026-07-01', '2026-07-31',
      'unregistered-head', 'department_head',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"unregistered_report_head","evidence_digest":"1111111111111111111111111111111111111111111111111111111111111111","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:report:unregistered-head', repeat('1',64), true
    );
    RAISE EXCEPTION 'expected unregistered client success report head denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.client_success_head_report_accept_rpc(
      '11111111-1111-4111-8111-111111111111',
      '51000000-0000-4510-8510-000000000001', v_charter_a,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      '31000000-0000-4310-8310-000000000001', NULL,
      '71000000-0000-4710-8710-000000000001',
      '2026-07-01', '2026-07-31',
      'client-success-head-a', 'service_role',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"wrong_report_authority","evidence_digest":"1111111111111111111111111111111111111111111111111111111111111111","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:report:wrong-authority', repeat('1',64), true
    );
    RAISE EXCEPTION 'expected client success report authority denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  v_result := public.client_success_head_report_accept_rpc(
    '11111111-1111-4111-8111-111111111111',
    '51000000-0000-4510-8510-000000000001', v_charter_a,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '31000000-0000-4310-8310-000000000001', NULL,
    '71000000-0000-4710-8710-000000000001',
    '2026-07-01', '2026-07-31',
    'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"stable_support","evidence_digest":"2222222222222222222222222222222222222222222222222222222222222222","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:report:stable-unverified', repeat('2',64), true
  );
  IF v_result->'report'->>'client_outcome_state' <> 'observed_stable'
     OR v_result->'report'->>'service_health' <> 'unverified'
     OR (v_result->'report'->>'outcome_healthy')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'stable_support remained falsely healthy';
  END IF;
  v_result := public.client_success_head_report_accept_rpc(
    '11111111-1111-4111-8111-111111111111',
    '51000000-0000-4510-8510-000000000001', v_charter_a,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '31000000-0000-4310-8310-000000000001', NULL,
    '71000000-0000-4710-8710-000000000001',
    '2026-07-01', '2026-07-31',
    'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"stable_support","evidence_digest":"2222222222222222222222222222222222222222222222222222222222222222","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:report:stable-unverified', repeat('2',64), true
  );
  IF v_result->>'outcome' <> 'replay'
     OR v_result->'report'->>'service_health' <> 'unverified' THEN
    RAISE EXCEPTION 'expected exact client success report replay';
  END IF;

  v_result := public.client_success_head_report_accept_rpc(
    '11111111-1111-4111-8111-111111111111',
    '52000000-0000-4520-8520-000000000002', v_charter_a,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '31000000-0000-4310-8310-000000000001', NULL,
    '72000000-0000-4720-8720-000000000002',
    '2026-07-01', '2026-07-31',
    'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"stable_support_verified","evidence_digest":"2222222222222222222222222222222222222222222222222222222222222222","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:report:stable-verified', repeat('2',64), true
  );
  IF v_result->'report'->>'client_outcome_state' <> 'observed_stable'
     OR (v_result->'report'->>'outcome_healthy')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'observed stable client report did not become healthy';
  END IF;

  v_result := public.client_success_head_report_accept_rpc(
    '11111111-1111-4111-8111-111111111111',
    '53000000-0000-4530-8530-000000000003', v_charter_a,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '32000000-0000-4320-8320-000000000002',
    '41000000-0000-4410-8410-000000000001',
    '73000000-0000-4730-8730-000000000003',
    '2026-07-01', '2026-07-31',
    'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"completed_support","evidence_digest":"3333333333333333333333333333333333333333333333333333333333333333","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:report:completed', repeat('3',64), true
  );
  IF v_result->'report'->>'client_outcome_state' <> 'unproven'
     OR (v_result->'report'->>'outcome_healthy')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'completed intervention appeared proven';
  END IF;

  v_result := public.client_success_head_report_accept_rpc(
    '11111111-1111-4111-8111-111111111111',
    '54000000-0000-4540-8540-000000000004', v_charter_a,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '33000000-0000-4330-8330-000000000003',
    '42000000-0000-4420-8420-000000000002',
    '74000000-0000-4740-8740-000000000004',
    '2026-07-01', '2026-07-31',
    'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"improved_support","evidence_digest":"4444444444444444444444444444444444444444444444444444444444444444","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:report:improved', repeat('4',64), true
  );
  IF v_result->'report'->>'client_outcome_state' <> 'improved'
     OR (v_result->'report'->>'outcome_healthy')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'observed improved intervention did not become healthy';
  END IF;

  PERFORM public.client_success_head_report_accept_rpc(
    '22222222-2222-4222-8222-222222222222',
    '55000000-0000-4550-8550-000000000005', v_charter_b,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    '34000000-0000-4340-8340-000000000004', NULL,
    '75000000-0000-4750-8750-000000000005',
    '2026-07-01', '2026-07-31',
    'client-success-head-b', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"tenant_b_support","evidence_digest":"5555555555555555555555555555555555555555555555555555555555555555","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:report:tenant-b', repeat('5',64), true
  );

  BEGIN
    PERFORM public.client_success_head_work_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '61000000-0000-4610-8610-000000000001',
      '52000000-0000-4520-8520-000000000002',
      'create', 0, 'agent', 'unregistered-head', 'department_head',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"unregistered","evidence_digest":"6666666666666666666666666666666666666666666666666666666666666666","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:work:unregistered', repeat('6',64), true,
      'work', 'analyze_client_health', 'Analyze evidence', 'agent',
      'unregistered-head', now() + interval '1 day'
    );
    RAISE EXCEPTION 'expected unregistered client success head denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.client_success_head_work_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '62000000-0000-4620-8620-000000000002',
      '52000000-0000-4520-8520-000000000002',
      'create', 0, 'agent', 'client-success-head-a', 'department_head',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"forbidden_scope","evidence_digest":"7777777777777777777777777777777777777777777777777777777777777777","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:work:forbidden', repeat('7',64), true,
      'work', 'send_customer_message', 'Send customer communication', 'agent',
      'client-success-head-a', now() + interval '1 day'
    );
    RAISE EXCEPTION 'expected prohibited customer communication scope denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  v_result := public.client_success_head_work_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '63000000-0000-4630-8630-000000000003',
    '53000000-0000-4530-8530-000000000003',
    'create', 0, 'agent', 'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"work_create","evidence_digest":"8888888888888888888888888888888888888888888888888888888888888888","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:work:create', repeat('8',64), true,
    'work', 'verify_support_evidence', 'Verify aggregate support evidence',
    'agent', 'client-success-head-a', now() + interval '1 day'
  );
  v_result := public.client_success_head_work_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '63000000-0000-4630-8630-000000000003',
    '53000000-0000-4530-8530-000000000003',
    'create', 0, 'agent', 'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"work_create","evidence_digest":"8888888888888888888888888888888888888888888888888888888888888888","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:work:create', repeat('8',64), true,
    'work', 'verify_support_evidence', 'Verify aggregate support evidence',
    'agent', 'client-success-head-a', now() + interval '1 day'
  );
  IF v_result->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact client success work replay';
  END IF;
  BEGIN
    PERFORM public.client_success_head_work_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '63000000-0000-4630-8630-000000000003',
      '53000000-0000-4530-8530-000000000003',
      'create', 0, 'agent', 'client-success-head-a', 'department_head',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"work_create","evidence_digest":"8888888888888888888888888888888888888888888888888888888888888888","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:work:create', repeat('f',64), true,
      'work', 'verify_support_evidence', 'Verify aggregate support evidence',
      'agent', 'client-success-head-a', now() + interval '1 day'
    );
    RAISE EXCEPTION 'expected client success work idempotency conflict';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  v_result := public.client_success_head_work_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '63000000-0000-4630-8630-000000000003',
    '53000000-0000-4530-8530-000000000003',
    'accept', 1, 'agent', 'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"work_accept","evidence_digest":"9999999999999999999999999999999999999999999999999999999999999999","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:work:accept', repeat('9',64), true
  );
  BEGIN
    PERFORM public.client_success_head_work_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '63000000-0000-4630-8630-000000000003',
      '53000000-0000-4530-8530-000000000003',
      'start', 1, 'agent', 'client-success-head-a', 'department_head',
      '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"stale","evidence_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
      'client-success:work:stale', repeat('a',64), true
    );
    RAISE EXCEPTION 'expected stale client success revision denial';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  v_before := (
    SELECT client_outcome_state FROM public.client_success_head_reports
     WHERE id = '53000000-0000-4530-8530-000000000003'
  );
  PERFORM public.client_success_head_work_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '63000000-0000-4630-8630-000000000003',
    '53000000-0000-4530-8530-000000000003',
    'complete', 2, 'agent', 'client-success-head-a', 'department_head',
    '{"schema_version":1,"sources":[{"source_type":"support_ledger","source_id":"work_complete","evidence_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","observed_at":"2026-07-24T12:00:00Z"}]}'::jsonb,
    'client-success:work:complete', repeat('b',64), true,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, repeat('c',64), NULL
  );
  IF (SELECT client_outcome_state FROM public.client_success_head_reports
       WHERE id = '53000000-0000-4530-8530-000000000003') IS DISTINCT FROM
     v_before THEN
    RAISE EXCEPTION 'completed client success work changed report outcome';
  END IF;
END $$;
COMMIT;

DO $$
BEGIN
  BEGIN
    UPDATE public.client_success_support_snapshots
       SET csat_bps = 10000
     WHERE id = '71000000-0000-4710-8710-000000000001';
    RAISE EXCEPTION 'expected immutable canonical support snapshot denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_success"}}',
  true
);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.client_success_head_reports
       WHERE tenant_id = '22222222-2222-4222-8222-222222222222') <> 0
     OR (SELECT count(*) FROM public.client_success_head_reports
         WHERE tenant_id = '11111111-1111-4111-8111-111111111111') = 0
     OR (SELECT count(*) FROM public.client_success_support_snapshots
         WHERE tenant_id = '22222222-2222-4222-8222-222222222222') <> 0
     OR (SELECT count(*) FROM public.client_success_support_snapshots
         WHERE tenant_id = '11111111-1111-4111-8111-111111111111') = 0 THEN
    RAISE EXCEPTION 'authenticated client success RLS tenant isolation failed';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.client_success_head_kill_switch_rpc(
  '22222222-2222-4222-8222-222222222222', 'proof_complete'
);
COMMIT;

DO $$
BEGIN
  BEGIN
    UPDATE public.client_success_head_controls
       SET kill_switch_engaged = false,
           enabled = true,
           execution_mode = 'supervised_read_only'
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
    RAISE EXCEPTION 'expected one-way client success kill-switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
