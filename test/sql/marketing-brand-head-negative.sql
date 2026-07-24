\set ON_ERROR_STOP on

-- Migration 091 runtime proof. Run after content-delivery-quality-negative.sql.
-- All tenants, content, identities, metrics, and evidence are synthetic.

INSERT INTO public.marketing_brand_head_controls (
  tenant_id, registered_head_id, mission, kpi_contract,
  max_observation_cohort_size, enabled, execution_mode,
  kill_switch_engaged, activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'marketing-head-a',
    'Protect evidence-backed content quality, brand compliance, and accountable marketing follow-through without production authority.',
    '{
      "content_quality_acceptance_rate":{"target_bps":9000},
      "delivery_receipt_completeness_rate":{"target_bps":10000},
      "audience_evidence_completeness_rate":{"target_bps":10000},
      "reply_observation_rate":{"target_bps":500},
      "conversion_observation_rate":{"target_bps":100},
      "brand_compliance_exception_sla_hours":{"target":24},
      "cohort_size_limit":{"maximum":100}
    }'::jsonb,
    100, true, 'supervised_read_only', false,
    'aaaaaaaa-1111-4111-8111-111111111111',
    '{"source":"synthetic_owner_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'marketing-head-b',
    'Protect evidence-backed content quality, brand compliance, and accountable marketing follow-through without production authority.',
    '{
      "content_quality_acceptance_rate":{"target_bps":9000},
      "delivery_receipt_completeness_rate":{"target_bps":10000},
      "audience_evidence_completeness_rate":{"target_bps":10000},
      "reply_observation_rate":{"target_bps":500},
      "conversion_observation_rate":{"target_bps":100},
      "brand_compliance_exception_sla_hours":{"target":24},
      "cohort_size_limit":{"maximum":100}
    }'::jsonb,
    100, true, 'supervised_read_only', false,
    'bbbbbbbb-2222-4222-8222-222222222222',
    '{"source":"synthetic_owner_approval"}'::jsonb
  );

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"owner"}}',
  true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.marketing_brand_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_report', '{}'::jsonb, 0,
      'marketing-head:authenticated-denied', repeat('a', 64),
      'marketing-head-a', 'department_head',
      '{"source_type":"manifest","source_id":"auth-denied","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected authenticated Marketing Head RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  artifact_a uuid;
  artifact_b uuid;
  quality_a uuid;
  delivery_a uuid;
  payload_a jsonb;
BEGIN
  SELECT id INTO STRICT artifact_a
    FROM public.content_artifact_versions
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
   ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT artifact_b
    FROM public.content_artifact_versions
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
   ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT quality_a
    FROM public.content_quality_evaluations
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
   ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT delivery_a
    FROM public.content_delivery_receipts
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
   ORDER BY created_at LIMIT 1;

  payload_a := jsonb_build_object(
    'report_id', '91111111-1111-4111-8111-111111111111',
    'reporting_period_start', '2026-07-01',
    'content_version_ids', to_jsonb(ARRAY[artifact_a]),
    'quality_evaluation_ids', to_jsonb(ARRAY[quality_a]),
    'delivery_receipt_ids', to_jsonb(ARRAY[delivery_a]),
    'execution_health', 'succeeded',
    'content_completion_state', 'completed',
    'brand_compliance_state', 'verified',
    'brand_compliance_evidence_digest', repeat('a', 64),
    'audience_observed_count', 40,
    'reply_observed_count', 4,
    'conversion_observed_count', 1,
    'cohort_size', 50,
    'metrics_evidence_digest', repeat('b', 64),
    'structured_report', '{
      "content_quality":{"accepted":1},
      "delivery_receipts":{"delivered":1},
      "audience":{"observed":40},
      "replies":{"observed":4},
      "conversions":{"observed":1},
      "brand_compliance_exceptions":{"open":0},
      "cohort":{"size":50}
    }'::jsonb
  );

  BEGIN
    INSERT INTO public.marketing_brand_head_reports (
      id, tenant_id, reporting_period_start, execution_health,
      content_completion_state, quality_state, delivery_state,
      brand_compliance_state, observation_state, business_effect_state,
      artifact_version_count, quality_evaluation_count,
      accepted_quality_count, delivery_receipt_count,
      delivered_artifact_count, audience_observed_count,
      reply_observed_count, conversion_observed_count, cohort_size,
      cohort_limit, metrics_evidence_digest,
      brand_compliance_evidence_digest, structured_report, evidence,
      evidence_digest, accepted_by_head_id, idempotency_key,
      request_fingerprint, semantic_fingerprint
    ) VALUES (
      '91999999-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '2026-07-01', 'succeeded', 'completed', 'accepted', 'delivered',
      'verified', 'observed', 'observed_association',
      1, 1, 1, 1, 1, 40, 4, 1, 50, 100, repeat('a',64),
      repeat('b',64), '{
        "content_quality":{},
        "delivery_receipts":{},
        "audience":{},
        "replies":{},
        "conversions":{},
        "brand_compliance_exceptions":{},
        "cohort":{}
      }'::jsonb, '{"synthetic":true}'::jsonb,
      repeat('c',64), 'marketing-head-a', 'direct-write-denied',
      repeat('d',64), repeat('e',64)
    );
    RAISE EXCEPTION 'expected direct Marketing Head service write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.marketing_brand_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_report', payload_a, 0, 'marketing-head:wrong-agent',
      repeat('1', 64), 'marketing-head-b', 'department_head',
      '{"source_type":"manifest","source_id":"wrong-agent","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected unregistered Marketing Head denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'marketing_brand_registered_head_required' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.marketing_brand_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_report',
      payload_a || jsonb_build_object(
        'content_version_ids', to_jsonb(ARRAY[artifact_b])
      ),
      0, 'marketing-head:cross-tenant', repeat('2', 64),
      'marketing-head-a', 'department_head',
      '{"source_type":"manifest","source_id":"cross-tenant","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected cross-tenant artifact evidence denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'marketing_brand_artifact_evidence_mismatch' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.marketing_brand_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'create_case',
      jsonb_build_object(
        'report_id', '91111111-1111-4111-8111-111111111111',
        'case_id', '91999999-1111-4111-8111-111111111111',
        'case_type', 'decision',
        'title', 'Attempt forbidden publication',
        'owner_id', 'aaaaaaaa-1111-4111-8111-111111111111',
        'sla_due_at', now() + interval '1 day',
        'contract', '{"decision_scope":"Provider-Dispatch"}'::jsonb
      ),
      0, 'marketing-head:forbidden-publication', repeat('3', 64),
      'marketing-head-a', 'department_head',
      '{"source_type":"decision","source_id":"forbidden","observed_at":"2026-07-24T12:00:00Z","Customer-Email":"forbidden"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected publication-bound Marketing Head payload denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'marketing_brand_command_or_evidence_invalid' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  artifact_a uuid;
  artifact_b uuid;
  quality_a uuid;
  delivery_a uuid;
  report_a jsonb;
  report_a_replay jsonb;
  report_b jsonb;
  payload_a jsonb;
  payload_b jsonb;
BEGIN
  SELECT id INTO STRICT artifact_a
    FROM public.content_artifact_versions
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
   ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT artifact_b
    FROM public.content_artifact_versions
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
   ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT quality_a
    FROM public.content_quality_evaluations
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
   ORDER BY created_at LIMIT 1;
  SELECT id INTO STRICT delivery_a
    FROM public.content_delivery_receipts
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
   ORDER BY created_at LIMIT 1;

  payload_a := jsonb_build_object(
    'report_id', '91111111-1111-4111-8111-111111111111',
    'reporting_period_start', '2026-07-01',
    'content_version_ids', to_jsonb(ARRAY[artifact_a]),
    'quality_evaluation_ids', to_jsonb(ARRAY[quality_a]),
    'delivery_receipt_ids', to_jsonb(ARRAY[delivery_a]),
    'execution_health', 'succeeded',
    'content_completion_state', 'completed',
    'brand_compliance_state', 'verified',
    'brand_compliance_evidence_digest', repeat('a', 64),
    'audience_observed_count', 40,
    'reply_observed_count', 4,
    'conversion_observed_count', 1,
    'cohort_size', 50,
    'metrics_evidence_digest', repeat('b', 64),
    'structured_report', '{
      "content_quality":{"accepted":1},
      "delivery_receipts":{"delivered":1},
      "audience":{"observed":40},
      "replies":{"observed":4},
      "conversions":{"observed":1},
      "brand_compliance_exceptions":{"open":0},
      "cohort":{"size":50}
    }'::jsonb
  );
  report_a := public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'accept_report', payload_a, 0, 'marketing-head:report:a',
    repeat('4', 64), 'marketing-head-a', 'department_head',
    '{"source_type":"content_manifest","source_id":"report-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  IF report_a->>'content_completion_state' <> 'completed'
     OR report_a->>'quality_state' <> 'accepted'
     OR report_a->>'delivery_state' <> 'delivered'
     OR report_a->>'business_effect_state' <> 'observed_association' THEN
    RAISE EXCEPTION 'tenant A Marketing Head report returned false state';
  END IF;
  report_a_replay := public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'accept_report', payload_a, 0, 'marketing-head:report:a',
    repeat('4', 64), 'marketing-head-a', 'department_head',
    '{"source_type":"content_manifest","source_id":"report-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  IF report_a_replay->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact Marketing Head replay';
  END IF;

  payload_b := jsonb_build_object(
    'report_id', '91222222-2222-4222-8222-222222222222',
    'reporting_period_start', '2026-07-01',
    'content_version_ids', to_jsonb(ARRAY[artifact_b]),
    'quality_evaluation_ids', '[]'::jsonb,
    'delivery_receipt_ids', '[]'::jsonb,
    'execution_health', 'succeeded',
    'content_completion_state', 'completed',
    'brand_compliance_state', 'unverified',
    'brand_compliance_evidence_digest', repeat('c', 64),
    'audience_observed_count', 0,
    'reply_observed_count', 0,
    'conversion_observed_count', 0,
    'cohort_size', 0,
    'structured_report', '{
      "content_quality":{"accepted":0},
      "delivery_receipts":{"delivered":0},
      "audience":{"observed":0},
      "replies":{"observed":0},
      "conversions":{"observed":0},
      "brand_compliance_exceptions":{"open":0},
      "cohort":{"size":0}
    }'::jsonb
  );
  report_b := public.marketing_brand_head_command_rpc(
    '22222222-2222-4222-8222-222222222222',
    'accept_report', payload_b, 0, 'marketing-head:report:b',
    repeat('5', 64), 'marketing-head-b', 'department_head',
    '{"source_type":"content_manifest","source_id":"report-b","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  IF report_b->>'execution_health' <> 'succeeded'
     OR report_b->>'content_completion_state' <> 'completed'
     OR report_b->>'quality_state' <> 'unverified'
     OR report_b->>'delivery_state' <> 'unverified'
     OR report_b->>'business_effect_state' <> 'unverified' THEN
    RAISE EXCEPTION 'completed content incorrectly implied downstream truth';
  END IF;

  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case',
    jsonb_build_object(
      'report_id', '91111111-1111-4111-8111-111111111111',
      'case_id', '91333333-1111-4111-8111-111111111111',
      'case_type', 'work', 'title', 'Resolve synthetic brand exception',
      'owner_id', 'aaaaaaaa-1111-4111-8111-111111111111',
      'sla_due_at', now() - interval '1 minute',
      'contract', '{"acceptance":["evidence-backed-review"]}'::jsonb
    ),
    0, 'marketing-head:work:create', repeat('6', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"assignment","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'accept_work',
    '{"case_id":"91333333-1111-4111-8111-111111111111"}'::jsonb,
    1, 'marketing-head:work:accept', repeat('7', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"acceptance","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'escalate_work',
    '{"case_id":"91333333-1111-4111-8111-111111111111","escalation_code":"sla_breached"}'::jsonb,
    2, 'marketing-head:work:escalate', repeat('8', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"sla_monitor","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'complete_work',
    '{"case_id":"91333333-1111-4111-8111-111111111111"}'::jsonb,
    3, 'marketing-head:work:complete', repeat('9', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"completion_receipt","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'record_outcome',
    '{"case_id":"91333333-1111-4111-8111-111111111111","outcome_state":"verified_achieved"}'::jsonb,
    4, 'marketing-head:work:outcome', repeat('a', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"outcome_evidence","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );

  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case',
    jsonb_build_object(
      'report_id', '91111111-1111-4111-8111-111111111111',
      'case_id', '91444444-1111-4111-8111-111111111111',
      'case_type', 'goal', 'title', 'Improve evidence completeness',
      'owner_id', 'aaaaaaaa-1111-4111-8111-111111111111',
      'sla_due_at', now() + interval '1 day',
      'contract', '{"measure":"evidence-completeness-bps"}'::jsonb
    ),
    0, 'marketing-head:goal:create', repeat('b', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"goal_contract","source_id":"goal-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'complete_goal',
    '{"case_id":"91444444-1111-4111-8111-111111111111","outcome_state":"verified_achieved"}'::jsonb,
    1, 'marketing-head:goal:complete', repeat('c', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"goal_outcome","source_id":"goal-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );

  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case',
    jsonb_build_object(
      'report_id', '91111111-1111-4111-8111-111111111111',
      'case_id', '91555555-1111-4111-8111-111111111111',
      'case_type', 'decision', 'title', 'Choose supervised content direction',
      'owner_id', 'aaaaaaaa-1111-4111-8111-111111111111',
      'sla_due_at', now() + interval '1 day',
      'contract', '{"decision_scope":"supervised-content-direction"}'::jsonb
    ),
    0, 'marketing-head:decision:create', repeat('d', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"decision_contract","source_id":"decision-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'decide_decision',
    '{"case_id":"91555555-1111-4111-8111-111111111111","decision_result":"approved"}'::jsonb,
    1, 'marketing-head:decision:decide', repeat('e', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"decision_evidence","source_id":"decision-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );

  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case',
    jsonb_build_object(
      'report_id', '91111111-1111-4111-8111-111111111111',
      'case_id', '91666666-1111-4111-8111-111111111111',
      'case_type', 'exception', 'title', 'Resolve supervised brand exception',
      'owner_id', 'aaaaaaaa-1111-4111-8111-111111111111',
      'sla_due_at', now() + interval '1 day',
      'contract', '{"resolution":"owner-reviewed-resolution"}'::jsonb
    ),
    0, 'marketing-head:exception:create', repeat('f', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"exception_contract","source_id":"exception-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.marketing_brand_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'resolve_exception',
    '{"case_id":"91666666-1111-4111-8111-111111111111","outcome_state":"verified_achieved"}'::jsonb,
    1, 'marketing-head:exception:resolve', repeat('0', 64),
    'marketing-head-a', 'department_head',
    '{"source_type":"resolution_evidence","source_id":"exception-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.marketing_brand_head_cases
     WHERE id = '91444444-1111-4111-8111-111111111111'
       AND lifecycle_state = 'completed'
       AND outcome_state = 'verified_achieved'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.marketing_brand_head_cases
     WHERE id = '91555555-1111-4111-8111-111111111111'
       AND lifecycle_state = 'completed'
       AND decision_result = 'approved'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.marketing_brand_head_cases
     WHERE id = '91666666-1111-4111-8111-111111111111'
       AND lifecycle_state = 'resolved'
       AND outcome_state = 'verified_achieved'
  ) THEN
    RAISE EXCEPTION 'Marketing Head ordinary case lifecycle did not terminate';
  END IF;
END $$;
COMMIT;

BEGIN;
DO $$
BEGIN
  BEGIN
    UPDATE public.marketing_brand_head_reports
       SET delivery_state = 'unverified'
     WHERE id = '91111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable Marketing Head evidence denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"owner"}}',
  true
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.marketing_brand_head_reports
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A saw tenant B Marketing Head evidence';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.marketing_brand_head_reports
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'tenant A could not see own Marketing Head evidence';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  PERFORM public.marketing_brand_head_kill_switch_rpc(
    '11111111-1111-4111-8111-111111111111',
    'synthetic_marketing_containment'
  );
  BEGIN
    PERFORM public.marketing_brand_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_work',
      '{"case_id":"91333333-1111-4111-8111-111111111111"}'::jsonb,
      5, 'marketing-head:after-kill', repeat('b', 64),
      'marketing-head-a', 'department_head',
      '{"source_type":"acceptance","source_id":"after-kill","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected engaged Marketing Head kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'marketing_brand_kill_switch_engaged' THEN RAISE; END IF;
  END;
END $$;
COMMIT;

BEGIN;
DO $$
BEGIN
  BEGIN
    UPDATE public.marketing_brand_head_controls
       SET kill_switch_engaged = false
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected one-way Marketing Head kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;
