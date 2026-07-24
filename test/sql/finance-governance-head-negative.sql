\set ON_ERROR_STOP on

-- Migration 090 runtime proof. Run after billing-attribution-negative.sql and
-- monthly-finance-close-negative.sql. All evidence is synthetic.

INSERT INTO public.finance_attribution_records (
  tenant_id, customer_id, tenant_mapping_id, customer_mapping_id,
  provider, provider_account_ref, source_event_type, source_event_id,
  occurred_on, currency, revenue_minor, cost_minor,
  reconciliation_status, reconciled_revenue_minor, reconciled_cost_minor,
  evidence_digest, evidence_observed_at, actor_type, actor_id,
  idempotency_key, request_fingerprint
)
SELECT
  '22222222-2222-4222-8222-222222222222',
  'dddddddd-2222-4222-8222-222222222222',
  tenant_mapping.id,
  customer_mapping.id,
  tenant_mapping.provider,
  tenant_mapping.provider_account_ref,
  'invoice_paid',
  'evt_finance_head_b',
  '2026-07-24',
  'USD',
  20000,
  4000,
  'matched',
  20000,
  4000,
  repeat('b', 64),
  now(),
  'system',
  NULL,
  'finance-head:source:b',
  repeat('b', 64)
FROM public.billing_identity_mappings tenant_mapping
JOIN public.billing_identity_mappings customer_mapping
  ON customer_mapping.tenant_id = tenant_mapping.tenant_id
 AND customer_mapping.provider = tenant_mapping.provider
 AND customer_mapping.provider_account_ref =
   tenant_mapping.provider_account_ref
WHERE tenant_mapping.tenant_id =
  '22222222-2222-4222-8222-222222222222'
  AND tenant_mapping.scope_type = 'tenant'
  AND customer_mapping.scope_type = 'customer'
  AND customer_mapping.customer_id =
    'dddddddd-2222-4222-8222-222222222222';

-- Synthetic tenant B has a complete recorded one-item manifest but remains in
-- reconciling state so execution success still cannot imply financial truth.
UPDATE public.finance_close_cycles
   SET reconciliation_manifest_digest = repeat('b', 64),
       reconciliation_record_count = 1
 WHERE id = '82222222-2222-4222-8222-222222222222'
   AND tenant_id = '22222222-2222-4222-8222-222222222222';

INSERT INTO public.finance_governance_head_controls (
  tenant_id, registered_head_id, mission, kpi_contract,
  enabled, execution_mode, kill_switch_engaged,
  activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'finance-head-a',
    'Protect reconciled integer financial truth and governed evidence without production authority.',
    '{
      "reconciliation_match_rate":{"target_bps":10000},
      "monthly_close_sla_days":{"target":5},
      "exception_resolution_sla_hours":{"target":24},
      "data_quality_pass_rate":{"target_bps":10000},
      "evidence_completeness_rate":{"target_bps":10000},
      "tenant_isolation_gate_pass_rate":{"target_bps":10000}
    }'::jsonb,
    true, 'supervised_read_only', false,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_owner_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'finance-head-b',
    'Protect reconciled integer financial truth and governed evidence without production authority.',
    '{
      "reconciliation_match_rate":{"target_bps":10000},
      "monthly_close_sla_days":{"target":5},
      "exception_resolution_sla_hours":{"target":24},
      "data_quality_pass_rate":{"target_bps":10000},
      "evidence_completeness_rate":{"target_bps":10000},
      "tenant_isolation_gate_pass_rate":{"target_bps":10000}
    }'::jsonb,
    true, 'supervised_read_only', false,
    'ffffffff-2222-4222-8222-222222222222',
    '{"source":"synthetic_owner_approval"}'::jsonb
  );

-- Exact regression for the omitted-record exploit: the authoritative close
-- declares two records and the canonical period contains one matched plus one
-- exception, while the caller supplies only the matched ID.
BEGIN;
INSERT INTO public.finance_attribution_records (
  tenant_id, customer_id, tenant_mapping_id, customer_mapping_id,
  provider, provider_account_ref, source_event_type, source_event_id,
  occurred_on, currency, revenue_minor, cost_minor,
  reconciliation_status, reconciled_revenue_minor, reconciled_cost_minor,
  evidence_digest, evidence_observed_at, actor_type, actor_id,
  idempotency_key, request_fingerprint
)
SELECT
  attribution.tenant_id, attribution.customer_id,
  attribution.tenant_mapping_id, attribution.customer_mapping_id,
  attribution.provider, attribution.provider_account_ref,
  attribution.source_event_type, 'evt_finance_head_partial_exploit',
  attribution.occurred_on, attribution.currency,
  attribution.revenue_minor, attribution.cost_minor,
  'exception', attribution.revenue_minor - 1, attribution.cost_minor,
  repeat('e', 64), now(), 'system', NULL,
  'finance-head:partial-exploit', repeat('e', 64)
FROM public.finance_attribution_records attribution
WHERE attribution.tenant_id = '11111111-1111-4111-8111-111111111111'
  AND attribution.reconciliation_status = 'matched'
ORDER BY attribution.id
LIMIT 1;
UPDATE public.finance_close_cycles
   SET reconciliation_record_count = 2
 WHERE id = '81111111-1111-4111-8111-111111111111'
   AND tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE matched_id uuid;
BEGIN
  SELECT id INTO STRICT matched_id
    FROM public.finance_attribution_records
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
     AND reconciliation_status = 'matched'
   ORDER BY id LIMIT 1;
  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_report', '90999999-1111-4111-8111-111111111111', NULL,
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD', ARRAY[matched_id],
      'succeeded', 'verified',
      repeat('e', 64), '{"controls_tested":12,"exceptions":0}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      0, 'finance-head:partial-manifest-exploit', repeat('e', 64),
      'finance-head-a', 'department_head',
      '{"source_type":"canonical_manifest","source_id":"partial-exploit","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected partial close manifest exploit denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_attribution_manifest_incomplete' THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;

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
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_report', '90111111-1111-4111-8111-111111111111', NULL,
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD',
      ARRAY['91111111-1111-4111-8111-111111111111'::uuid],
      'succeeded', 'verified',
      repeat('a', 64), '{"controls_tested":12,"exceptions":0}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      0, 'finance-head:authenticated-denied', repeat('a', 64),
      'finance-head-a', 'department_head',
      '{"source_type":"canonical_manifest","source_id":"auth-denied","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected authenticated Finance Head RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE tenant_a_ids uuid[];
        tenant_b_ids uuid[];
BEGIN
  BEGIN
    INSERT INTO public.finance_governance_head_reports (
      id, tenant_id, finance_close_cycle_id, period_start, currency,
      execution_health, reconciliation_state, monthly_close_state,
      data_governance_state, financial_truth_state,
      attribution_record_count, revenue_minor, cost_minor, margin_minor,
      structured_report, governance_evidence_digest, evidence,
      evidence_digest, accepted_by_head_id, idempotency_key,
      request_fingerprint, semantic_fingerprint
    ) VALUES (
      '90111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD', 'succeeded', 'matched', 'shadow_locked',
      'verified', 'verified', 1, 100, 20, 80,
      '{"synthetic":true}'::jsonb, repeat('a',64), '{}'::jsonb,
      repeat('b',64), 'finance-head-a', 'direct-denied',
      repeat('c',64), repeat('d',64)
    );
    RAISE EXCEPTION 'expected direct Finance Head service write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  SELECT array_agg(id ORDER BY id) INTO tenant_a_ids
    FROM public.finance_attribution_records
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
  SELECT array_agg(id ORDER BY id) INTO tenant_b_ids
    FROM public.finance_attribution_records
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';

  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_report', '90111111-1111-4111-8111-111111111111', NULL,
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD', tenant_a_ids, 'succeeded', 'verified',
      repeat('a', 64), '{"controls_tested":12,"exceptions":0}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      0, 'finance-head:wrong-agent', repeat('1', 64),
      'finance-head-b', 'department_head',
      '{"source_type":"canonical_manifest","source_id":"wrong-agent","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected unregistered Finance Head denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'finance_governance_registered_head_required' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_report', '90111111-1111-4111-8111-111111111111', NULL,
      '82222222-2222-4222-8222-222222222222',
      '2026-07-01', 'USD', tenant_b_ids, 'succeeded', 'verified',
      repeat('b', 64), '{"controls_tested":12,"exceptions":0}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      0, 'finance-head:cross-tenant', repeat('2', 64),
      'finance-head-a', 'department_head',
      '{"source_type":"canonical_manifest","source_id":"cross-tenant","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected cross-tenant canonical evidence denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_close_cycle_not_found' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE tenant_a_ids uuid[];
        tenant_b_ids uuid[];
        report_a jsonb;
        report_b jsonb;
BEGIN
  SELECT array_agg(id ORDER BY id) INTO tenant_a_ids
    FROM public.finance_attribution_records
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
  SELECT array_agg(id ORDER BY id) INTO tenant_b_ids
    FROM public.finance_attribution_records
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';

  report_a := public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'accept_report', '90111111-1111-4111-8111-111111111111', NULL,
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', tenant_a_ids, 'succeeded', 'verified',
    repeat('a', 64), '{"controls_tested":12,"exceptions":0}'::jsonb,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    0, 'finance-head:report:a', repeat('3', 64),
    'finance-head-a', 'department_head',
    '{"source_type":"canonical_manifest","source_id":"report-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
    true
  );
  IF report_a->>'financial_truth_state' <> 'verified'
     OR report_a->>'execution_health' <> 'succeeded' THEN
    RAISE EXCEPTION 'tenant A verified report returned false state';
  END IF;

  report_b := public.finance_governance_head_command_rpc(
    '22222222-2222-4222-8222-222222222222',
    'accept_report', '90222222-2222-4222-8222-222222222222', NULL,
    '82222222-2222-4222-8222-222222222222',
    '2026-07-01', 'USD', tenant_b_ids, 'succeeded', 'verified',
    repeat('b', 64), '{"controls_tested":12,"exceptions":0}'::jsonb,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    0, 'finance-head:report:b', repeat('4', 64),
    'finance-head-b', 'department_head',
    '{"source_type":"canonical_manifest","source_id":"report-b","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
    true
  );
  IF report_b->>'execution_health' <> 'succeeded'
     OR report_b->>'financial_truth_state' <> 'unverified' THEN
    RAISE EXCEPTION 'green execution incorrectly implied financial truth';
  END IF;

  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'create_case', '90111111-1111-4111-8111-111111111111',
      '90999999-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      'decision', 'Attempt forbidden refund',
      'eeeeeeee-1111-4111-8111-111111111111', NULL,
      now() + interval '1 day', '{"refund":true}'::jsonb,
      NULL, NULL, 0, 'finance-head:forbidden-payload', repeat('5',64),
      'finance-head-a', 'department_head',
      '{"source_type":"decision","source_id":"forbidden","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected production-bound Finance Head payload denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_command_or_evidence_invalid' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'create_case', '90111111-1111-4111-8111-111111111111',
      '90330002-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      'exception', 'Reject mixed-case unsupported metadata',
      'eeeeeeee-1111-4111-8111-111111111111', NULL,
      now() + interval '1 day', '{"Resolution":"evidence_required"}'::jsonb,
      NULL, NULL, 0, 'finance-head:mixed-unsupported', repeat('5',64),
      'finance-head-a', 'department_head',
      '{"source_type":"exception","source_id":"mixed-unsupported","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected mixed-case unsupported Finance metadata denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_command_or_evidence_invalid' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'create_case', '90111111-1111-4111-8111-111111111111',
      '90330000-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      'work', 'Attempt arbitrary assignee',
      'eeeeeeee-1111-4111-8111-111111111111',
      'eeeeeeee-1111-4111-8111-111111111111',
      now() + interval '1 day', '{"acceptance":["evidence_attached"]}'::jsonb,
      NULL, NULL, 0, 'finance-head:work:arbitrary-assignee', repeat('5',64),
      'finance-head-a', 'department_head',
      '{"source_type":"assignment","source_id":"arbitrary-assignee","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected arbitrary assignee Finance Head denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_case_contract_invalid' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'create_case', '90111111-1111-4111-8111-111111111111',
      '90330001-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      'decision', 'Reject sensitive metadata',
      'eeeeeeee-1111-4111-8111-111111111111', NULL,
      now() + interval '1 day', '{"review":"required"}'::jsonb,
      NULL, NULL, 0, 'finance-head:mixed-sensitive', repeat('5',64),
      'finance-head-a', 'department_head',
      '{"source_type":"decision","source_id":"sensitive","observed_at":"2026-07-24T12:00:00Z","CustomerEmail":"synthetic@example.invalid"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected mixed-case sensitive metadata denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_command_or_evidence_invalid' THEN RAISE; END IF;
  END;

  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case', '90111111-1111-4111-8111-111111111111',
    '90333333-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    'work', 'Resolve canonical evidence exception',
    'eeeeeeee-1111-4111-8111-111111111111',
    NULL,
    now() - interval '1 hour', '{"acceptance":["evidence_attached"]}'::jsonb,
    NULL, NULL, 0, 'finance-head:work:create', repeat('6',64),
    'finance-head-a', 'department_head',
    '{"source_type":"work_assignment","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'accept_work', NULL, '90333333-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    NULL, NULL, NULL,
    NULL, NULL, '{}'::jsonb,
    NULL, NULL, 1, 'finance-head:work:accept', repeat('7',64),
    'finance-head-a', 'department_head',
    '{"source_type":"acceptance_receipt","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'escalate_work', NULL, '90333333-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    NULL, NULL, NULL,
    NULL, NULL, '{}'::jsonb,
    'sla_breached', NULL, 2, 'finance-head:work:escalate', repeat('8',64),
    'finance-head-a', 'department_head',
    '{"source_type":"escalation_receipt","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'complete_work', NULL, '90333333-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    NULL, NULL, NULL,
    NULL, NULL, '{}'::jsonb,
    NULL, NULL, 3, 'finance-head:work:complete', repeat('8',64),
    'finance-head-a', 'department_head',
    '{"source_type":"completion_receipt","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'record_outcome', NULL, '90333333-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
    NULL, 'verified_achieved', 4, 'finance-head:work:outcome', repeat('9',64),
    'finance-head-a', 'department_head',
    '{"source_type":"outcome_evidence","source_id":"work-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );

  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case', '90111111-1111-4111-8111-111111111111',
    '90555555-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    'goal', 'Close synthetic reconciliation goal',
    'eeeeeeee-1111-4111-8111-111111111111', NULL,
    now() + interval '1 day', '{"measure":"matched_set"}'::jsonb,
    NULL, NULL, 0, 'finance-head:goal:create', repeat('a',64),
    'finance-head-a', 'department_head',
    '{"source_type":"goal","source_id":"goal-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  IF (
    public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'complete_goal', NULL, '90555555-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
      NULL, 'verified_achieved', 1, 'finance-head:goal:complete',
      repeat('b',64), 'finance-head-a', 'department_head',
      '{"source_type":"goal_outcome","source_id":"goal-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    )->>'state'
  ) <> 'verified_achieved' THEN
    RAISE EXCEPTION 'expected completed Finance Head goal';
  END IF;

  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case', '90111111-1111-4111-8111-111111111111',
    '90666666-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    'decision', 'Approve synthetic governance decision',
    'eeeeeeee-1111-4111-8111-111111111111', NULL,
    now() + interval '1 day', '{"decision_scope":"synthetic"}'::jsonb,
    NULL, NULL, 0, 'finance-head:decision:create', repeat('c',64),
    'finance-head-a', 'department_head',
    '{"source_type":"decision","source_id":"decision-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  IF (
    public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'decide_decision', NULL, '90666666-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
      NULL, 'approved', 1, 'finance-head:decision:approve',
      repeat('d',64), 'finance-head-a', 'department_head',
      '{"source_type":"decision_result","source_id":"decision-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    )->>'state'
  ) <> 'approved' THEN
    RAISE EXCEPTION 'expected decided Finance Head decision';
  END IF;

  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case', '90111111-1111-4111-8111-111111111111',
    '90777777-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    'exception', 'Resolve synthetic governance exception',
    'eeeeeeee-1111-4111-8111-111111111111', NULL,
    now() + interval '1 day', '{"resolution":"evidence_required"}'::jsonb,
    NULL, NULL, 0, 'finance-head:exception:create', repeat('e',64),
    'finance-head-a', 'department_head',
    '{"source_type":"exception","source_id":"exception-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
  );
  IF (
    public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'resolve_exception', NULL, '90777777-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
      NULL, 'verified_achieved', 1, 'finance-head:exception:resolve',
      repeat('f',64), 'finance-head-a', 'department_head',
      '{"source_type":"exception_resolution","source_id":"exception-a","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    )->>'state'
  ) <> 'verified_achieved' THEN
    RAISE EXCEPTION 'expected resolved Finance Head exception';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.finance_governance_head_cases
     WHERE id = '90333333-1111-4111-8111-111111111111'
       AND lifecycle_state = 'completed'
       AND outcome_state = 'verified_achieved'
       AND revision = 5
  ) OR (
    SELECT count(*) FROM public.finance_governance_head_events
     WHERE entity_id = '90333333-1111-4111-8111-111111111111'
       AND command IN (
         'create_case', 'accept_work', 'escalate_work',
         'complete_work', 'record_outcome'
       )
  ) <> 5 THEN
    RAISE EXCEPTION 'expected every Finance Head work lifecycle transition';
  END IF;
  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case', '90111111-1111-4111-8111-111111111111',
    '90330003-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    'work', 'Preserve original acceptance assignee',
    'eeeeeeee-1111-4111-8111-111111111111', NULL,
    now() + interval '1 day', '{"acceptance":["registered_head_only"]}'::jsonb,
    NULL, NULL, 0, 'finance-head:assignee:assigned', repeat('1',64),
    'finance-head-a', 'department_head',
    '{"source_type":"assignment","source_id":"assignee-accept","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
    true
  );
  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'create_case', '90111111-1111-4111-8111-111111111111',
    '90330004-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    'work', 'Preserve original completion assignee',
    'eeeeeeee-1111-4111-8111-111111111111', NULL,
    now() + interval '1 day', '{"acceptance":["registered_head_only"]}'::jsonb,
    NULL, NULL, 0, 'finance-head:assignee:accepted', repeat('2',64),
    'finance-head-a', 'department_head',
    '{"source_type":"assignment","source_id":"assignee-complete","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
    true
  );
  PERFORM public.finance_governance_head_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    'accept_work', NULL, '90330004-1111-4111-8111-111111111111',
    NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
    NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
    NULL, NULL, 1, 'finance-head:assignee:accept-before-rotation',
    repeat('3',64), 'finance-head-a', 'department_head',
    '{"source_type":"acceptance_receipt","source_id":"assignee-complete","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
    true
  );
END $$;
COMMIT;

UPDATE public.finance_governance_head_controls
   SET registered_head_id = 'finance-head-a-rotated'
 WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'accept_work', NULL, '90330003-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
      NULL, NULL, 1, 'finance-head:assignee:wrong-accept', repeat('4',64),
      'finance-head-a-rotated', 'department_head',
      '{"source_type":"acceptance_receipt","source_id":"wrong-assignee-accept","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected stored Finance Head acceptance assignee denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_work_acceptance_invalid' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'complete_work', NULL, '90330004-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      NULL, NULL, NULL, NULL, NULL, '{}'::jsonb,
      NULL, NULL, 2, 'finance-head:assignee:wrong-complete', repeat('5',64),
      'finance-head-a-rotated', 'department_head',
      '{"source_type":"completion_receipt","source_id":"wrong-assignee-complete","observed_at":"2026-07-24T12:00:00Z"}'::jsonb,
      true
    );
    RAISE EXCEPTION 'expected stored Finance Head completion assignee denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_governance_work_completion_invalid' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
UPDATE public.finance_governance_head_controls
   SET registered_head_id = 'finance-head-a'
 WHERE tenant_id = '11111111-1111-4111-8111-111111111111';

DO $$
BEGIN
  BEGIN
    UPDATE public.finance_governance_head_reports
       SET execution_health = 'failed'
     WHERE id = '90111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable Finance Head evidence denial';
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
    SELECT 1 FROM public.finance_governance_head_reports
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A saw tenant B Finance Head evidence';
  END IF;
  IF (SELECT count(*) FROM public.finance_governance_head_reports) <> 1 THEN
    RAISE EXCEPTION 'tenant A expected one Finance Head report';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.finance_governance_head_kill_switch_rpc(
  '11111111-1111-4111-8111-111111111111',
  'synthetic Finance Head containment'
);
DO $$
BEGIN
  BEGIN
    PERFORM public.finance_governance_head_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      'create_case', '90111111-1111-4111-8111-111111111111',
      '90444444-1111-4111-8111-111111111111',
      NULL, NULL, NULL, '{}'::uuid[], NULL, NULL, NULL, '{}'::jsonb,
      'exception', 'Blocked after kill',
      'eeeeeeee-1111-4111-8111-111111111111', NULL,
      now() + interval '1 day', '{"resolution":"containment_required"}'::jsonb,
      NULL, NULL, 0, 'finance-head:killed', repeat('f',64),
      'finance-head-a', 'department_head',
      '{"source_type":"exception","source_id":"killed","observed_at":"2026-07-24T12:00:00Z"}'::jsonb, true
    );
    RAISE EXCEPTION 'expected engaged Finance Head kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;
