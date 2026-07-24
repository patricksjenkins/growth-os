\set ON_ERROR_STOP on

-- Migration 087 runtime proof. Run after autonomous-os-tenant-negative.sql.
-- All identities, evidence, reports, and records are synthetic.

INSERT INTO public.reliability_head_reports (
  id, tenant_id, report_type, period_start, period_end,
  execution_health_state, outcome_health_state, outcome_verified,
  kpi_results, report_body, evidence, evidence_digest, evidence_observed_at,
  accepted_by_type, accepted_by_id, accepted_authority_tier,
  idempotency_key, request_fingerprint, semantic_fingerprint
) VALUES
  (
    '85aaaaaa-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'reliability', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z',
    'healthy', 'healthy', true,
    '[{"name":"tenant_isolation_gate_pass_rate","value":1}]'::jsonb,
    '{"summary":"synthetic reliability report"}'::jsonb,
    '{"source":"synthetic"}'::jsonb, repeat('3', 64), now(),
    'human', 'eeeeeeee-1111-4111-8111-111111111111', 'owner',
    'cos:source:reliability:a', repeat('a', 64), repeat('b', 64)
  ),
  (
    '85bbbbbb-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'reliability', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z',
    'healthy', 'healthy', true,
    '[{"name":"tenant_isolation_gate_pass_rate","value":1}]'::jsonb,
    '{"summary":"synthetic reliability report"}'::jsonb,
    '{"source":"synthetic"}'::jsonb, repeat('7', 64), now(),
    'human', 'ffffffff-2222-4222-8222-222222222222', 'owner',
    'cos:source:reliability:b', repeat('c', 64), repeat('d', 64)
  );

INSERT INTO public.revenue_head_charters (
  id, tenant_id, version, mission,
  qualification_rate_target_bps, appointment_rate_target_bps,
  held_rate_target_bps, proposal_rate_target_bps, win_rate_target_bps,
  max_sales_cycle_days, evidence, evidence_digest, actor_id,
  idempotency_key, request_fingerprint
) VALUES
  (
    '86aaaaaa-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111', 1,
    'Synthetic supervised revenue charter for Chief of Staff dependency proof.',
    5000, 5000, 5000, 5000, 5000, 90,
    '{"source":"synthetic"}'::jsonb, repeat('e', 64),
    'eeeeeeee-1111-4111-8111-111111111111',
    'cos:source:revenue-charter:a', repeat('e', 64)
  ),
  (
    '86bbbbbb-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222', 1,
    'Synthetic supervised revenue charter for Chief of Staff dependency proof.',
    5000, 5000, 5000, 5000, 5000, 90,
    '{"source":"synthetic"}'::jsonb, repeat('f', 64),
    'ffffffff-2222-4222-8222-222222222222',
    'cos:source:revenue-charter:b', repeat('f', 64)
  );

INSERT INTO public.revenue_head_reports (
  id, tenant_id, charter_id, period_start, period_end,
  source_system, source_report_id, leads_created, qualified_leads,
  appointments_booked, appointments_held, proposals_sent,
  closed_won, closed_lost, open_pipeline_minor, booked_revenue_minor,
  currency, average_sales_cycle_days, qualification_rate_bps,
  appointment_rate_bps, held_rate_bps, proposal_rate_bps, win_rate_bps,
  funnel_health, business_effect_state, evidence, evidence_count,
  evidence_digest, idempotency_key, request_fingerprint
) VALUES
  (
    '86cccccc-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '86aaaaaa-1111-4111-8111-111111111111',
    '2026-07-01', '2026-07-31', 'synthetic', 'cos-revenue-a',
    10, 8, 6, 5, 4, 2, 2, 100000, 50000, 'USD', 20,
    8000, 7500, 8333, 8000, 5000, 'at_risk', 'observed',
    '{"source":"synthetic"}'::jsonb, 1, repeat('4', 64),
    'cos:source:revenue-report:a', repeat('1', 64)
  ),
  (
    '86dddddd-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    '86bbbbbb-2222-4222-8222-222222222222',
    '2026-07-01', '2026-07-31', 'synthetic', 'cos-revenue-b',
    10, 8, 6, 5, 4, 2, 2, 100000, 50000, 'USD', 20,
    8000, 7500, 8333, 8000, 5000, 'healthy', 'observed',
    '{"source":"synthetic"}'::jsonb, 1, repeat('8', 64),
    'cos:source:revenue-report:b', repeat('2', 64)
  );

INSERT INTO public.cos_supervision_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged,
  activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true, 'shadow', false,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_supervised_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    true, 'shadow', false,
    'ffffffff-2222-4222-8222-222222222222',
    '{"source":"synthetic_supervised_approval"}'::jsonb
  );

INSERT INTO public.department_report_contracts (
  id, tenant_id, department, contract_version, schema_digest,
  acceptance_state, revision, accepted_by, accepted_at,
  acceptance_evidence_digest
) VALUES
  (
    '87111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'reliability_security_agent_ops', 1, repeat('1', 64),
    'accepted', 2, 'eeeeeeee-1111-4111-8111-111111111111',
    now(), repeat('a', 64)
  ),
  (
    '87222222-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'revenue_sales', 1, repeat('2', 64),
    'draft', 1, NULL, NULL, NULL
  ),
  (
    '87555555-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'reliability_security_agent_ops', 1, repeat('5', 64),
    'accepted', 2, 'ffffffff-2222-4222-8222-222222222222',
    now(), repeat('b', 64)
  ),
  (
    '87666666-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'revenue_sales', 1, repeat('6', 64),
    'accepted', 2, 'ffffffff-2222-4222-8222-222222222222',
    now(), repeat('c', 64)
  );

INSERT INTO public.department_reports (
  id, tenant_id, department_report_contract_id,
  source_reliability_report_id, source_revenue_report_id, department,
  reporting_period_start, reporting_period_end, report_digest,
  report_state, revision, outcome_health, structured_summary,
  accepted_by, accepted_at, acceptance_evidence_digest
) VALUES
  (
    '87333333-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '87111111-1111-4111-8111-111111111111',
    '85aaaaaa-1111-4111-8111-111111111111', NULL,
    'reliability_security_agent_ops',
    '2026-07-01', '2026-07-31', repeat('3', 64),
    'accepted', 2, 'healthy', '{"exceptions":0}'::jsonb,
    'eeeeeeee-1111-4111-8111-111111111111', now(), repeat('d', 64)
  ),
  (
    '87444444-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '87222222-1111-4111-8111-111111111111',
    NULL, '86cccccc-1111-4111-8111-111111111111',
    'revenue_sales',
    '2026-07-01', '2026-07-31', repeat('4', 64),
    'accepted', 2, 'at_risk', '{"exceptions":1}'::jsonb,
    'eeeeeeee-1111-4111-8111-111111111111', now(), repeat('e', 64)
  ),
  (
    '87777777-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    '87555555-2222-4222-8222-222222222222',
    '85bbbbbb-2222-4222-8222-222222222222', NULL,
    'reliability_security_agent_ops',
    '2026-07-01', '2026-07-31', repeat('7', 64),
    'accepted', 2, 'healthy', '{}'::jsonb,
    'ffffffff-2222-4222-8222-222222222222', now(), repeat('f', 64)
  ),
  (
    '87888888-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    '87666666-2222-4222-8222-222222222222',
    NULL, '86dddddd-2222-4222-8222-222222222222',
    'revenue_sales',
    '2026-07-01', '2026-07-31', repeat('8', 64),
    'accepted', 2, 'healthy', '{}'::jsonb,
    'ffffffff-2222-4222-8222-222222222222', now(), repeat('9', 64)
  );

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.chief_of_staff_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '87999999-1111-4111-8111-111111111111',
      'open_cycle', NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, '{}'::jsonb,
      '2026-07-01', '2026-07-31',
      '87333333-1111-4111-8111-111111111111',
      '87444444-1111-4111-8111-111111111111',
      0, 'cos:authenticated-denied', repeat('a', 64),
      'service', 'chief-of-staff-shadow', 'chief_of_staff',
      jsonb_build_object(
        'source_type', 'accepted_report_manifest',
        'source_id', 'synthetic-auth-denied',
        'observed_at', now()
      ), true
    );
    RAISE EXCEPTION 'expected authenticated Chief of Staff RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.cos_coordination_cycles (
      id, tenant_id, reporting_period_start, reporting_period_end,
      reliability_report_id, revenue_report_id
    ) VALUES (
      '87999999-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '2026-07-01', '2026-07-31',
      '87333333-1111-4111-8111-111111111111',
      '87444444-1111-4111-8111-111111111111'
    );
    RAISE EXCEPTION 'expected direct service-role Chief of Staff write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.chief_of_staff_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '87999999-1111-4111-8111-111111111111',
      'open_cycle', NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, '{}'::jsonb,
      '2026-07-01', '2026-07-31',
      '87333333-1111-4111-8111-111111111111',
      '87444444-1111-4111-8111-111111111111',
      0, 'cos:unaccepted-revenue-contract', repeat('b', 64),
      'service', 'chief-of-staff-shadow', 'chief_of_staff',
      jsonb_build_object(
        'source_type', 'accepted_report_manifest',
        'source_id', 'synthetic-unaccepted-contract',
        'observed_at', now()
      ), true
    );
    RAISE EXCEPTION 'expected unaccepted Revenue contract dependency denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'cos_reliability_revenue_report_gate_unmet' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.chief_of_staff_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '87999999-1111-4111-8111-111111111111',
      'open_cycle', NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, '{}'::jsonb,
      '2026-07-01', '2026-07-31',
      '87777777-2222-4222-8222-222222222222',
      '87888888-2222-4222-8222-222222222222',
      0, 'cos:cross-tenant-reports', repeat('c', 64),
      'service', 'chief-of-staff-shadow', 'chief_of_staff',
      jsonb_build_object(
        'source_type', 'accepted_report_manifest',
        'source_id', 'synthetic-cross-tenant',
        'observed_at', now()
      ), true
    );
    RAISE EXCEPTION 'expected cross-tenant accepted report dependency denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'cos_reliability_revenue_report_gate_unmet' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

UPDATE public.department_report_contracts
   SET acceptance_state = 'accepted',
       revision = 2,
       accepted_by = 'eeeeeeee-1111-4111-8111-111111111111',
       accepted_at = now(),
       acceptance_evidence_digest = repeat('0', 64),
       updated_at = now()
 WHERE id = '87222222-1111-4111-8111-111111111111'
   AND tenant_id = '11111111-1111-4111-8111-111111111111';

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  opened jsonb;
  replayed jsonb;
  cycle_evidence jsonb := jsonb_build_object(
    'source_type', 'accepted_report_manifest',
    'source_id', 'synthetic-open-a',
    'observed_at', now()
  );
BEGIN
  opened := public.chief_of_staff_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '87999999-1111-4111-8111-111111111111',
    'open_cycle', NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::jsonb,
    '2026-07-01', '2026-07-31',
    '87333333-1111-4111-8111-111111111111',
    '87444444-1111-4111-8111-111111111111',
    0, 'cos:open:a', repeat('1', 64),
    'service', 'chief-of-staff-shadow', 'chief_of_staff',
    cycle_evidence, true
  );
  IF opened->>'outcome' <> 'applied'
     OR opened->>'state' <> 'supervised_open'
     OR (opened->>'cycle_revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Chief of Staff cycle returned false success';
  END IF;

  replayed := public.chief_of_staff_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '87999999-1111-4111-8111-111111111111',
    'open_cycle', NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::jsonb,
    '2026-07-01', '2026-07-31',
    '87333333-1111-4111-8111-111111111111',
    '87444444-1111-4111-8111-111111111111',
    0, 'cos:open:a', repeat('1', 64),
    'service', 'chief-of-staff-shadow', 'chief_of_staff',
    cycle_evidence, true
  );
  IF replayed->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact Chief of Staff command replay';
  END IF;
END $$;
ROLLBACK;

-- Open durable synthetic cycles cleanly after the replay proof rollback.
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  PERFORM public.chief_of_staff_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '87999999-1111-4111-8111-111111111111',
    'open_cycle', NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::jsonb,
    '2026-07-01', '2026-07-31',
    '87333333-1111-4111-8111-111111111111',
    '87444444-1111-4111-8111-111111111111',
    0, 'cos:open:a:durable', repeat('2', 64),
    'service', 'chief-of-staff-shadow', 'chief_of_staff',
    jsonb_build_object(
      'source_type', 'accepted_report_manifest',
      'source_id', 'synthetic-open-a-durable',
      'observed_at', now()
    ), true
  );

  BEGIN
    PERFORM public.chief_of_staff_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '87999999-1111-4111-8111-111111111111',
      'create_record',
      '87aaaaaa-1111-4111-8111-111111111111',
      'decision_required', 'Attempt forbidden charge',
      'revenue_sales', 'service', 'chief-of-staff-shadow',
      NULL, NULL, NULL, '{"charge":{"amount":100}}'::jsonb,
      '2026-07-01', '2026-07-31',
      '87333333-1111-4111-8111-111111111111',
      '87444444-1111-4111-8111-111111111111',
      1, 'cos:production-payload-denied', repeat('3', 64),
      'service', 'chief-of-staff-shadow', 'chief_of_staff',
      jsonb_build_object(
        'source_type', 'supervised_record',
        'source_id', 'synthetic-forbidden',
        'observed_at', now()
      ), true
    );
    RAISE EXCEPTION 'expected production-bound Chief of Staff payload denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'cos_production_bound_payload_forbidden' THEN RAISE; END IF;
  END;

  PERFORM public.chief_of_staff_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '87999999-1111-4111-8111-111111111111',
    'create_record',
    '87bbbbbb-1111-4111-8111-111111111111',
    'company_goal', 'Keep supervised outcomes evidence-backed',
    'reliability_security_agent_ops', 'service', 'chief-of-staff-shadow',
    NULL, NULL, NULL,
    '{"kpis":[{"name":"accepted_reports","target":2}]}'::jsonb,
    '2026-07-01', '2026-07-31',
    '87333333-1111-4111-8111-111111111111',
    '87444444-1111-4111-8111-111111111111',
    1, 'cos:goal:a', repeat('4', 64),
    'service', 'chief-of-staff-shadow', 'chief_of_staff',
    jsonb_build_object(
      'source_type', 'supervised_goal',
      'source_id', 'synthetic-goal-a',
      'observed_at', now()
    ), true
  );

  PERFORM public.chief_of_staff_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '87999999-1111-4111-8111-111111111111',
    'create_record',
    '87cccccc-1111-4111-8111-111111111111',
    'follow_through', 'Review material Revenue exception',
    'revenue_sales', 'human',
    'eeeeeeee-1111-4111-8111-111111111111',
    NULL, NULL, now() + interval '1 day',
    '{"commitment":"owner_review"}'::jsonb,
    '2026-07-01', '2026-07-31',
    '87333333-1111-4111-8111-111111111111',
    '87444444-1111-4111-8111-111111111111',
    2, 'cos:follow:a', repeat('5', 64),
    'service', 'chief-of-staff-shadow', 'chief_of_staff',
    jsonb_build_object(
      'source_type', 'accepted_exception',
      'source_id', 'synthetic-follow-a',
      'observed_at', now()
    ), true
  );

  PERFORM public.chief_of_staff_command_rpc(
    '22222222-2222-4222-8222-222222222222',
    '87999999-2222-4222-8222-222222222222',
    'open_cycle', NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, '{}'::jsonb,
    '2026-07-01', '2026-07-31',
    '87777777-2222-4222-8222-222222222222',
    '87888888-2222-4222-8222-222222222222',
    0, 'cos:open:b', repeat('6', 64),
    'service', 'chief-of-staff-shadow', 'chief_of_staff',
    jsonb_build_object(
      'source_type', 'accepted_report_manifest',
      'source_id', 'synthetic-open-b',
      'observed_at', now()
    ), true
  );

  PERFORM public.chief_of_staff_command_rpc(
    '22222222-2222-4222-8222-222222222222',
    '87999999-2222-4222-8222-222222222222',
    'create_record',
    '87dddddd-2222-4222-8222-222222222222',
    'exception', 'Tenant B synthetic exception',
    'revenue_sales', 'service', 'chief-of-staff-shadow',
    NULL, NULL, NULL, '{"severity":"low"}'::jsonb,
    '2026-07-01', '2026-07-31',
    '87777777-2222-4222-8222-222222222222',
    '87888888-2222-4222-8222-222222222222',
    1, 'cos:exception:b', repeat('7', 64),
    'service', 'chief-of-staff-shadow', 'chief_of_staff',
    jsonb_build_object(
      'source_type', 'accepted_exception',
      'source_id', 'synthetic-exception-b',
      'observed_at', now()
    ), true
  );
END $$;
COMMIT;

DO $$
BEGIN
  BEGIN
    UPDATE public.cos_supervised_events
       SET resulting_state = 'tampered'
     WHERE id = (
       SELECT id FROM public.cos_supervised_events
        WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
        ORDER BY created_at, id
        LIMIT 1
     );
    RAISE EXCEPTION 'expected immutable Chief of Staff audit denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.cos_coordination_records
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A saw tenant B Chief of Staff record';
  END IF;
  IF (SELECT count(*) FROM public.cos_coordination_records) <> 2 THEN
    RAISE EXCEPTION 'tenant A expected two supervised records';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.cos_kill_switch_rpc(
  '11111111-1111-4111-8111-111111111111',
  'synthetic Chief of Staff containment'
);
DO $$
BEGIN
  BEGIN
    PERFORM public.chief_of_staff_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '87999999-1111-4111-8111-111111111111',
      'create_record',
      '87eeeeee-1111-4111-8111-111111111111',
      'exception', 'Blocked after kill',
      'reliability_security_agent_ops', 'service', 'chief-of-staff-shadow',
      NULL, NULL, NULL, '{}'::jsonb,
      '2026-07-01', '2026-07-31',
      '87333333-1111-4111-8111-111111111111',
      '87444444-1111-4111-8111-111111111111',
      3, 'cos:killed', repeat('8', 64),
      'service', 'chief-of-staff-shadow', 'chief_of_staff',
      jsonb_build_object(
        'source_type', 'supervised_record',
        'source_id', 'synthetic-killed',
        'observed_at', now()
      ), true
    );
    RAISE EXCEPTION 'expected engaged Chief of Staff kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;
