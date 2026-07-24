\set ON_ERROR_STOP on

-- Migration 084 runtime proof. Run after autonomous-os-tenant-negative.sql.
-- All identifiers, evidence, and cohort values are synthetic.

INSERT INTO public.lead_action_automation_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged,
  activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true, 'shadow', false,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_test_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    true, 'shadow', false,
    'ffffffff-2222-4222-8222-222222222222',
    '{"source":"synthetic_test_approval"}'::jsonb
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
    PERFORM public.lead_action_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_lead_action_id => '84111111-1111-4111-8111-111111111111',
      p_action_type => 'proposal_follow_up',
      p_command => 'assign',
      p_expected_revision => 0,
      p_idempotency_key => 'lead-action:authenticated-denied',
      p_request_fingerprint => repeat('a', 64),
      p_actor_type => 'service',
      p_actor_id => 'revenue-shadow-worker',
      p_authority_tier => 'sales_operator',
      p_evidence => jsonb_build_object(
        'source_type', 'assignment_decision',
        'source_id', 'synthetic-auth-denied',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true,
      p_assignee_type => 'human',
      p_assignee_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_due_at => now() + interval '1 day',
      p_outcome_due_at => now() + interval '2 days',
      p_cohort_key => 'proposal_v1',
      p_assignment_source_type => 'sales_pipeline_rule',
      p_assignment_source_id => 'synthetic-rule-v1'
    );
    RAISE EXCEPTION 'expected authenticated lead-action RPC denial';
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
    INSERT INTO public.lead_actions (
      id, tenant_id, lead_id, action_type, assignee_type, assignee_id,
      cohort_key, assignment_source_type, assignment_source_id,
      due_at, outcome_due_at
    ) VALUES (
      '84111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-1111-4111-8111-111111111111',
      'proposal_follow_up', 'service', 'revenue-shadow-worker',
      'proposal_v1', 'sales_pipeline_rule', 'synthetic-rule-v1',
      now() + interval '1 day', now() + interval '2 days'
    );
    RAISE EXCEPTION 'expected direct service-role lead-action write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.lead_action_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_lead_action_id => '84999999-1111-4111-8111-111111111111',
      p_action_type => 'qualification',
      p_command => 'assign',
      p_expected_revision => 0,
      p_idempotency_key => 'lead-action:causal-evidence-denied',
      p_request_fingerprint => repeat('d', 64),
      p_actor_type => 'service',
      p_actor_id => 'revenue-shadow-worker',
      p_authority_tier => 'sales_operator',
      p_evidence => jsonb_build_object(
        'source_type', 'assignment_decision',
        'source_id', 'synthetic-causal-denied',
        'observed_at', now(),
        'nested', jsonb_build_object('causalEffect', 0.5)
      ),
      p_feature_gate_enabled => true,
      p_assignee_type => 'service',
      p_assignee_id => 'revenue-shadow-worker',
      p_due_at => now() + interval '1 day',
      p_outcome_due_at => now() + interval '2 days',
      p_cohort_key => 'qualification_v1',
      p_assignment_source_type => 'sales_pipeline_rule',
      p_assignment_source_id => 'synthetic-rule-v1'
    );
    RAISE EXCEPTION 'expected causal lead-action evidence denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'lead_action_evidence_invalid' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.lead_action_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_lead_action_id => '84111111-1111-4111-8111-111111111111',
      p_action_type => 'proposal_follow_up',
      p_command => 'assign',
      p_expected_revision => 0,
      p_idempotency_key => 'lead-action:disabled',
      p_request_fingerprint => repeat('b', 64),
      p_actor_type => 'service',
      p_actor_id => 'revenue-shadow-worker',
      p_authority_tier => 'sales_operator',
      p_evidence => jsonb_build_object(
        'source_type', 'assignment_decision',
        'source_id', 'synthetic-disabled',
        'observed_at', now()
      ),
      p_feature_gate_enabled => false,
      p_assignee_type => 'human',
      p_assignee_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_due_at => now() + interval '1 day',
      p_outcome_due_at => now() + interval '2 days',
      p_cohort_key => 'proposal_v1',
      p_assignment_source_type => 'sales_pipeline_rule',
      p_assignment_source_id => 'synthetic-rule-v1'
    );
    RAISE EXCEPTION 'expected disabled lead-action write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  assign_a jsonb;
  replay_a jsonb;
BEGIN
  assign_a := public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84111111-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'assign',
    p_expected_revision => 0,
    p_idempotency_key => 'lead-action:assign:a',
    p_request_fingerprint => repeat('1', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'assignment_decision',
      'source_id', 'synthetic-assignment-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true,
    p_assignee_type => 'human',
    p_assignee_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_due_at => now() + interval '1 day',
    p_outcome_due_at => now() + interval '2 days',
    p_cohort_key => 'proposal_v1',
    p_assignment_source_type => 'sales_pipeline_rule',
    p_assignment_source_id => 'synthetic-rule-v1'
  );
  IF assign_a->>'outcome' <> 'applied'
     OR assign_a->'action'->>'status' <> 'assigned'
     OR (assign_a->'action'->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'lead-action assignment returned false success';
  END IF;

  replay_a := public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84111111-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'assign',
    p_expected_revision => 0,
    p_idempotency_key => 'lead-action:assign:a',
    p_request_fingerprint => repeat('1', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => assign_a->'receipt'->'evidence',
    p_feature_gate_enabled => true,
    p_assignee_type => 'human',
    p_assignee_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_due_at => (assign_a->'action'->>'due_at')::timestamptz,
    p_outcome_due_at => (assign_a->'action'->>'outcome_due_at')::timestamptz,
    p_cohort_key => 'proposal_v1',
    p_assignment_source_type => 'sales_pipeline_rule',
    p_assignment_source_id => 'synthetic-rule-v1'
  );
  IF replay_a->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact lead-action replay';
  END IF;

  BEGIN
    PERFORM public.lead_action_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_lead_id => 'bbbbbbbb-2222-4222-8222-222222222222',
      p_lead_action_id => '84222222-1111-4111-8111-111111111111',
      p_action_type => 'proposal_follow_up',
      p_command => 'assign',
      p_expected_revision => 0,
      p_idempotency_key => 'lead-action:cross-tenant-lead',
      p_request_fingerprint => repeat('2', 64),
      p_actor_type => 'service',
      p_actor_id => 'revenue-shadow-worker',
      p_authority_tier => 'sales_operator',
      p_evidence => jsonb_build_object(
        'source_type', 'assignment_decision',
        'source_id', 'synthetic-cross-tenant-lead',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true,
      p_assignee_type => 'service',
      p_assignee_id => 'revenue-shadow-worker',
      p_due_at => now() + interval '1 day',
      p_outcome_due_at => now() + interval '2 days',
      p_cohort_key => 'proposal_v1',
      p_assignment_source_type => 'sales_pipeline_rule',
      p_assignment_source_id => 'synthetic-rule-v1'
    );
    RAISE EXCEPTION 'expected cross-tenant lead assignment denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'lead_action_lead_tenant_mismatch' THEN RAISE; END IF;
  END;

  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_lead_id => 'bbbbbbbb-2222-4222-8222-222222222222',
    p_lead_action_id => '84222222-2222-4222-8222-222222222222',
    p_action_type => 'proposal_follow_up',
    p_command => 'assign',
    p_expected_revision => 0,
    p_idempotency_key => 'lead-action:assign:b',
    p_request_fingerprint => repeat('3', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'assignment_decision',
      'source_id', 'synthetic-assignment-b',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true,
    p_assignee_type => 'service',
    p_assignee_id => 'revenue-shadow-worker',
    p_due_at => now() + interval '1 day',
    p_outcome_due_at => now() + interval '2 days',
    p_cohort_key => 'proposal_v1',
    p_assignment_source_type => 'sales_pipeline_rule',
    p_assignment_source_id => 'synthetic-rule-v1'
  );

  BEGIN
    PERFORM public.lead_action_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_lead_action_id => '84222222-2222-4222-8222-222222222222',
      p_action_type => 'proposal_follow_up',
      p_command => 'accept',
      p_expected_revision => 1,
      p_idempotency_key => 'lead-action:cross-tenant-action',
      p_request_fingerprint => repeat('4', 64),
      p_actor_type => 'service',
      p_actor_id => 'revenue-shadow-worker',
      p_authority_tier => 'sales_operator',
      p_evidence => jsonb_build_object(
        'source_type', 'acceptance_attestation',
        'source_id', 'synthetic-cross-tenant-action',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant action identity denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'lead_action_exact_identity_not_found' THEN RAISE; END IF;
  END;

  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84111111-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'accept',
    p_expected_revision => 1,
    p_idempotency_key => 'lead-action:accept:a',
    p_request_fingerprint => repeat('5', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'acceptance_attestation',
      'source_id', 'synthetic-acceptance-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true
  );

  BEGIN
    PERFORM public.lead_action_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_lead_action_id => '84111111-1111-4111-8111-111111111111',
      p_action_type => 'proposal_follow_up',
      p_command => 'accept',
      p_expected_revision => 1,
      p_idempotency_key => 'lead-action:stale-revision',
      p_request_fingerprint => repeat('6', 64),
      p_actor_type => 'human',
      p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_authority_tier => 'sales_operator',
      p_evidence => jsonb_build_object(
        'source_type', 'acceptance_attestation',
        'source_id', 'synthetic-stale-revision',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected stale lead-action revision denial';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84111111-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'complete',
    p_expected_revision => 2,
    p_idempotency_key => 'lead-action:complete:a',
    p_request_fingerprint => repeat('7', 64),
    p_actor_type => 'human',
    p_actor_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'completion_attestation',
      'source_id', 'synthetic-completion-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true,
    p_completion_disposition => 'performed'
  );

  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84111111-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'record_outcome',
    p_expected_revision => 3,
    p_idempotency_key => 'lead-action:outcome:a',
    p_request_fingerprint => repeat('8', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'lead_outcome_observation',
      'source_id', 'synthetic-outcome-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true,
    p_outcome_state => 'converted',
    p_attribution_state => 'observed',
    p_outcome_source_type => 'closed_won_transition',
    p_outcome_source_id => 'synthetic-closed-won-a'
  );

  -- A second tenant-A action reaches its evidence horizon without an observed
  -- conversion source. It must receive an explicit unknown receipt.
  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84333333-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'assign',
    p_expected_revision => 0,
    p_idempotency_key => 'lead-action:assign:unknown-a',
    p_request_fingerprint => repeat('9', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'assignment_decision',
      'source_id', 'synthetic-assignment-unknown-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true,
    p_assignee_type => 'service',
    p_assignee_id => 'revenue-shadow-worker',
    p_due_at => now(),
    p_outcome_due_at => now(),
    p_cohort_key => 'proposal_v1',
    p_assignment_source_type => 'sales_pipeline_rule',
    p_assignment_source_id => 'synthetic-rule-v1'
  );

  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84333333-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'accept',
    p_expected_revision => 1,
    p_idempotency_key => 'lead-action:accept:unknown-a',
    p_request_fingerprint => repeat('a', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'acceptance_attestation',
      'source_id', 'synthetic-acceptance-unknown-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true
  );

  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84333333-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'complete',
    p_expected_revision => 2,
    p_idempotency_key => 'lead-action:complete:unknown-a',
    p_request_fingerprint => repeat('b', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'completion_attestation',
      'source_id', 'synthetic-completion-unknown-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true,
    p_completion_disposition => 'performed'
  );

  PERFORM public.lead_action_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
    p_lead_action_id => '84333333-1111-4111-8111-111111111111',
    p_action_type => 'proposal_follow_up',
    p_command => 'record_outcome',
    p_expected_revision => 3,
    p_idempotency_key => 'lead-action:outcome:unknown-a',
    p_request_fingerprint => repeat('c', 64),
    p_actor_type => 'service',
    p_actor_id => 'revenue-shadow-worker',
    p_authority_tier => 'sales_operator',
    p_evidence => jsonb_build_object(
      'source_type', 'outcome_window_expired',
      'source_id', 'synthetic-window-unknown-a',
      'observed_at', now()
    ),
    p_feature_gate_enabled => true,
    p_outcome_state => 'unknown',
    p_attribution_state => 'unknown'
  );
END $$;
COMMIT;

DO $$
BEGIN
  BEGIN
    UPDATE public.lead_action_receipts
       SET receipt_payload = '{"tampered":true}'::jsonb
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
       AND idempotency_key = 'lead-action:assign:a';
    RAISE EXCEPTION 'expected immutable lead-action receipt denial';
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
DECLARE
  cohort_row record;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.lead_action_conversion_cohorts
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A cohort leaked tenant B evidence';
  END IF;

  SELECT cohort.*
    INTO STRICT cohort_row
    FROM public.lead_action_conversion_cohorts cohort
   WHERE cohort.tenant_id = '11111111-1111-4111-8111-111111111111'
     AND cohort.cohort_key = 'proposal_v1'
     AND cohort.action_type = 'proposal_follow_up';

  IF cohort_row.assigned_count <> 2
     OR cohort_row.observed_outcome_count <> 1
     OR cohort_row.unknown_outcome_count <> 1
     OR cohort_row.pending_outcome_count <> 0
     OR cohort_row.converted_count <> 1
     OR cohort_row.not_converted_count <> 0
     OR cohort_row.observed_conversion_rate <> 1.000000
     OR cohort_row.causal_claim IS DISTINCT FROM false
     OR cohort_row.attribution_model <> 'descriptive_association_only' THEN
    RAISE EXCEPTION
      'observed and unknown cohort counts were not separated';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  containment_result jsonb;
  supplied_reason text := 'synthetic containment verification plaintext marker';
  control_row record;
BEGIN
  containment_result := public.lead_action_kill_switch_rpc(
    '11111111-1111-4111-8111-111111111111',
    supplied_reason
  );
  SELECT control.*
    INTO STRICT control_row
    FROM public.lead_action_automation_controls control
   WHERE control.tenant_id =
     '11111111-1111-4111-8111-111111111111';
  IF control_row.activation_evidence::text
       LIKE '%' || supplied_reason || '%'
     OR control_row.activation_evidence ? 'kill_switch_reason' THEN
    RAISE EXCEPTION 'kill switch reason plaintext was retained';
  END IF;
  IF containment_result::text LIKE '%' || supplied_reason || '%' THEN
    RAISE EXCEPTION 'kill switch response exposed reason plaintext';
  END IF;
  IF containment_result->>'outcome' <> 'contained'
     OR containment_result->>'tenant_id'
        <> '11111111-1111-4111-8111-111111111111'
     OR (
       SELECT count(*) FROM jsonb_object_keys(containment_result)
     ) <> 4
     OR containment_result->>'reason_digest'
        <> encode(
          digest(convert_to(supplied_reason, 'UTF8'), 'sha256'),
          'hex'
        )
     OR control_row.activation_evidence->>'kill_switch_reason_digest'
        <> containment_result->>'reason_digest'
     OR (containment_result->>'revision')::bigint <> 1
     OR control_row.revision <> 1
     OR control_row.enabled IS DISTINCT FROM false
     OR control_row.execution_mode <> 'disabled'
     OR control_row.kill_switch_engaged IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'kill switch digest envelope was not exact';
  END IF;

  BEGIN
    PERFORM public.lead_action_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_lead_id => 'aaaaaaaa-1111-4111-8111-111111111111',
      p_lead_action_id => '84444444-1111-4111-8111-111111111111',
      p_action_type => 'qualification',
      p_command => 'assign',
      p_expected_revision => 0,
      p_idempotency_key => 'lead-action:killed',
      p_request_fingerprint => repeat('f', 64),
      p_actor_type => 'service',
      p_actor_id => 'revenue-shadow-worker',
      p_authority_tier => 'sales_operator',
      p_evidence => jsonb_build_object(
        'source_type', 'assignment_decision',
        'source_id', 'synthetic-killed',
        'observed_at', now()
      ),
      p_feature_gate_enabled => true,
      p_assignee_type => 'service',
      p_assignee_id => 'revenue-shadow-worker',
      p_due_at => now() + interval '1 day',
      p_outcome_due_at => now() + interval '2 days',
      p_cohort_key => 'qualification_v1',
      p_assignment_source_type => 'sales_pipeline_rule',
      p_assignment_source_id => 'synthetic-rule-v1'
    );
    RAISE EXCEPTION 'expected engaged lead-action kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;
