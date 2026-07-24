\set ON_ERROR_STOP on

-- Migration 085 runtime proof. Run after autonomous-os-tenant-negative.sql.
-- All identities and evidence are synthetic. No provider, production, customer,
-- or money-moving action occurs.

DO $$
BEGIN
  BEGIN
    INSERT INTO public.reliability_head_controls (
      tenant_id, department_head_id, mission, kpi_contract,
      authority_contract, enabled, execution_mode, kill_switch_engaged,
      activated_by, activation_evidence
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'reliability-head-v1',
      'Protect tenant isolation and prove reliable business outcomes.',
      '{
        "incident_detection_to_ack_minutes":{"target":"lte_15"},
        "tenant_isolation_gate_pass_rate":{"target":"eq_1"},
        "verified_recovery_rate":{"target":"gte_0_95"},
        "agent_business_outcome_rate":{"target":"gte_0_9"},
        "audit_evidence_completeness":{"target":"eq_1"},
        "sla_compliance_rate":{"target":"gte_0_95"}
      }'::jsonb,
      '{"allowed":["analyze","recommend","record_shadow_work","escalate"]}'::jsonb,
      true, 'shadow', false,
      'ffffffff-2222-4222-8222-222222222222',
      '{"source":"synthetic_cross_tenant_approval"}'::jsonb
    );
    RAISE EXCEPTION 'expected cross-tenant Reliability Head activation denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'reliability_head_activation_actor_not_tenant_admin' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO public.reliability_head_controls (
      tenant_id, department_head_id, mission, kpi_contract,
      authority_contract, enabled, execution_mode, kill_switch_engaged,
      operational_write_authority, activated_by, activation_evidence
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'reliability-head-v1',
      'Protect tenant isolation and prove reliable business outcomes.',
      '{
        "incident_detection_to_ack_minutes":{},
        "tenant_isolation_gate_pass_rate":{},
        "verified_recovery_rate":{},
        "agent_business_outcome_rate":{},
        "audit_evidence_completeness":{},
        "sla_compliance_rate":{}
      }'::jsonb,
      '{"allowed":["analyze"]}'::jsonb,
      true, 'shadow', false, true,
      'eeeeeeee-1111-4111-8111-111111111111',
      '{"source":"synthetic_prohibited_authority"}'::jsonb
    );
    RAISE EXCEPTION 'expected Reliability Head prohibited authority denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'reliability_head_prohibited_authority' THEN
      RAISE;
    END IF;
  END;
END $$;

INSERT INTO public.reliability_head_controls (
  tenant_id, department_head_id, mission, kpi_contract,
  authority_contract, enabled, execution_mode, kill_switch_engaged,
  revision, activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'reliability-head-v1',
    'Protect tenant isolation and prove reliable business outcomes.',
    '{
      "incident_detection_to_ack_minutes":{"target":"lte_15"},
      "tenant_isolation_gate_pass_rate":{"target":"eq_1"},
      "verified_recovery_rate":{"target":"gte_0_95"},
      "agent_business_outcome_rate":{"target":"gte_0_9"},
      "audit_evidence_completeness":{"target":"eq_1"},
      "sla_compliance_rate":{"target":"gte_0_95"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_shadow_work","escalate"]}'::jsonb,
    true, 'shadow', false, 0,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_test_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'reliability-head-v1',
    'Protect tenant isolation and prove reliable business outcomes.',
    '{
      "incident_detection_to_ack_minutes":{"target":"lte_15"},
      "tenant_isolation_gate_pass_rate":{"target":"eq_1"},
      "verified_recovery_rate":{"target":"gte_0_95"},
      "agent_business_outcome_rate":{"target":"gte_0_9"},
      "audit_evidence_completeness":{"target":"eq_1"},
      "sla_compliance_rate":{"target":"gte_0_95"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_shadow_work","escalate"]}'::jsonb,
    true, 'shadow', false, 0,
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
    PERFORM public.reliability_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '85111111-1111-4111-8111-111111111111',
      p_report_type => 'reliability',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_outcome_health_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"verified_recovery_rate",
        "verification_state":"unverified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'accepted_department_report',
        'source_id', 'synthetic-auth-denied',
        'observed_at', now()
      ),
      p_idempotency_key => 'reliability-head:auth-denied',
      p_request_fingerprint => repeat('a', 64),
      p_actor_type => 'agent',
      p_actor_id => 'reliability-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected authenticated Reliability Head RPC denial';
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
    INSERT INTO public.reliability_head_cases (
      id, tenant_id, case_type, title, contract, lifecycle_state,
      owner_id, sla_due_at, last_action_at
    ) VALUES (
      '85211111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      'goal', 'Direct write', '{"objective":"denied"}'::jsonb, 'active',
      'eeeeeeee-1111-4111-8111-111111111111',
      now() + interval '1 day', now()
    );
    RAISE EXCEPTION 'expected direct Reliability Head service write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.reliability_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '85111111-1111-4111-8111-111111111111',
      p_report_type => 'reliability',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_outcome_health_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"verified_recovery_rate",
        "verification_state":"unverified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'accepted_department_report',
        'source_id', 'synthetic-disabled',
        'observed_at', now()
      ),
      p_idempotency_key => 'reliability-head:disabled',
      p_request_fingerprint => repeat('b', 64),
      p_actor_type => 'agent',
      p_actor_id => 'reliability-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled Reliability Head write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.reliability_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '85111111-1111-4111-8111-111111111111',
      p_report_type => 'reliability',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_outcome_health_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"verified_recovery_rate",
        "verification_state":"unverified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'accepted_department_report',
        'source_id', 'synthetic-agent-mismatch',
        'observed_at', now()
      ),
      p_idempotency_key => 'reliability-head:agent-mismatch',
      p_request_fingerprint => repeat('c', 64),
      p_actor_type => 'agent',
      p_actor_id => 'imposter-reliability-head',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected Reliability Head agent identity denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'reliability_head_agent_identity_mismatch' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.reliability_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '85111111-1111-4111-8111-111111111111',
      p_report_type => 'security',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_outcome_health_state => 'healthy',
      p_outcome_verified => true,
      p_kpi_results => '[{
        "kpi_key":"tenant_isolation_gate_pass_rate",
        "measured_value":1,
        "verification_state":"unverified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic false green"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'accepted_department_report',
        'source_id', 'synthetic-false-green',
        'observed_at', now()
      ),
      p_idempotency_key => 'reliability-head:false-green',
      p_request_fingerprint => repeat('d', 64),
      p_actor_type => 'agent',
      p_actor_id => 'reliability-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected Reliability Head false-green denial';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'reliability_head_false_green_forbidden' THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  report_a jsonb;
  work_a jsonb;
  final_work jsonb;
BEGIN
  report_a := public.reliability_head_report_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_report_id => '85111111-1111-4111-8111-111111111111',
    p_report_type => 'reliability',
    p_period_start => now() - interval '1 day',
    p_period_end => now(),
    p_execution_health_state => 'healthy',
    p_outcome_health_state => 'unproven',
    p_outcome_verified => false,
    p_kpi_results => '[{
      "kpi_key":"verified_recovery_rate",
      "measured_value":0.9,
      "verification_state":"unverified"
    }]'::jsonb,
    p_report_body => '{"summary":"synthetic supervised report"}'::jsonb,
    p_evidence => jsonb_build_object(
      'source_type', 'accepted_department_report',
      'source_id', 'synthetic-report-a',
      'observed_at', now()
    ),
    p_idempotency_key => 'reliability-head:report:a',
    p_request_fingerprint => repeat('1', 64),
    p_actor_type => 'agent',
    p_actor_id => 'reliability-head-v1',
    p_authority_tier => 'department_head',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF report_a->>'outcome' <> 'accepted'
     OR report_a->'report'->>'execution_health_state' <> 'healthy'
     OR report_a->'report'->>'outcome_health_state' <> 'unproven' THEN
    RAISE EXCEPTION 'Reliability Head report returned false success';
  END IF;

  PERFORM public.reliability_head_report_rpc(
    p_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_report_id => '85111111-2222-4222-8222-222222222222',
    p_report_type => 'security',
    p_period_start => now() - interval '1 day',
    p_period_end => now(),
    p_execution_health_state => 'healthy',
    p_outcome_health_state => 'healthy',
    p_outcome_verified => true,
    p_kpi_results => '[
      {
        "kpi_key":"tenant_isolation_gate_pass_rate",
        "measured_value":1,
        "verification_state":"verified",
        "evidence_ref":"test_run:synthetic-b"
      },
      {
        "kpi_key":"audit_evidence_completeness",
        "measured_value":1,
        "verification_state":"verified",
        "evidence_ref":"audit_manifest:synthetic-b"
      }
    ]'::jsonb,
    p_report_body => '{"summary":"synthetic verified report"}'::jsonb,
    p_evidence => jsonb_build_object(
      'source_type', 'accepted_department_report',
      'source_id', 'synthetic-report-b',
      'observed_at', now()
    ),
    p_idempotency_key => 'reliability-head:report:b',
    p_request_fingerprint => repeat('2', 64),
    p_actor_type => 'agent',
    p_actor_id => 'reliability-head-v1',
    p_authority_tier => 'department_head',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );

  BEGIN
    PERFORM public.reliability_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '85211111-1111-4111-8111-111111111111',
      p_action => 'create_work',
      p_expected_revision => 0,
      p_idempotency_key => 'reliability-head:cross-report',
      p_request_fingerprint => repeat('3', 64),
      p_actor_type => 'agent',
      p_actor_id => 'reliability-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'supervised_work_assignment',
        'source_id', 'synthetic-cross-report',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_source_report_id => '85111111-2222-4222-8222-222222222222',
      p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
      p_assignee_id => '77777777-1111-4111-8111-111111111111',
      p_sla_due_at => now() + interval '1 day',
      p_title => 'Synthetic cross-tenant work',
      p_contract => '{"objective":"must fail"}'::jsonb
    );
    RAISE EXCEPTION 'expected cross-tenant Reliability Head report denial';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'reliability_head_source_report_not_found_for_tenant' THEN
      RAISE;
    END IF;
  END;

  work_a := public.reliability_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '85211111-1111-4111-8111-111111111111',
    p_action => 'create_work',
    p_expected_revision => 0,
    p_idempotency_key => 'reliability-head:work:a',
    p_request_fingerprint => repeat('4', 64),
    p_actor_type => 'agent',
    p_actor_id => 'reliability-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'supervised_work_assignment',
      'source_id', 'synthetic-work-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_source_report_id => '85111111-1111-4111-8111-111111111111',
    p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_assignee_id => '77777777-1111-4111-8111-111111111111',
    p_sla_due_at => now() + interval '1 day',
    p_title => 'Verify recovery evidence',
    p_contract => '{
      "objective":"verify recovery",
      "acceptance_criteria":["receipt exists"],
      "completion_contract":"verified receipt"
    }'::jsonb
  );
  IF work_a->'case'->>'lifecycle_state' <> 'assigned'
     OR work_a->'case'->>'outcome_state' <> 'unknown'
     OR (work_a->'case'->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Reliability Head work returned false success';
  END IF;

  BEGIN
    PERFORM public.reliability_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '85211111-1111-4111-8111-111111111111',
      p_action => 'accept_work',
      p_expected_revision => 0,
      p_idempotency_key => 'reliability-head:stale',
      p_request_fingerprint => repeat('5', 64),
      p_actor_type => 'human',
      p_actor_id => '77777777-1111-4111-8111-111111111111',
      p_authority_tier => 'operator',
      p_evidence => jsonb_build_object(
        'source_type', 'assignment_acceptance',
        'source_id', 'synthetic-stale',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected stale Reliability Head revision denial';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'reliability_head_revision_conflict' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.reliability_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '85211111-1111-4111-8111-111111111111',
      p_action => 'record_work_outcome',
      p_expected_revision => 1,
      p_idempotency_key => 'reliability-head:premature-outcome',
      p_request_fingerprint => repeat('6', 64),
      p_actor_type => 'agent',
      p_actor_id => 'reliability-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'business_outcome_receipt',
        'source_id', 'synthetic-premature',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_outcome_state => 'achieved'
    );
    RAISE EXCEPTION 'expected Reliability Head outcome-before-completion denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'reliability_head_work_outcome_invalid' THEN
      RAISE;
    END IF;
  END;

  PERFORM public.reliability_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '85211111-1111-4111-8111-111111111111',
    p_action => 'accept_work',
    p_expected_revision => 1,
    p_idempotency_key => 'reliability-head:accept:a',
    p_request_fingerprint => repeat('7', 64),
    p_actor_type => 'human',
    p_actor_id => '77777777-1111-4111-8111-111111111111',
    p_authority_tier => 'operator',
    p_evidence => jsonb_build_object(
      'source_type', 'assignment_acceptance',
      'source_id', 'synthetic-accept-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );

  PERFORM public.reliability_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '85211111-1111-4111-8111-111111111111',
    p_action => 'complete_work',
    p_expected_revision => 2,
    p_idempotency_key => 'reliability-head:complete:a',
    p_request_fingerprint => repeat('8', 64),
    p_actor_type => 'human',
    p_actor_id => '77777777-1111-4111-8111-111111111111',
    p_authority_tier => 'operator',
    p_evidence => jsonb_build_object(
      'source_type', 'work_completion_receipt',
      'source_id', 'synthetic-complete-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.reliability_head_cases head_case
     WHERE head_case.id = '85211111-1111-4111-8111-111111111111'
       AND head_case.lifecycle_state = 'completed'
       AND head_case.outcome_state = 'unproven'
       AND head_case.outcome_verified = false
  ) THEN
    RAISE EXCEPTION 'completed Reliability Head work appeared outcome-healthy';
  END IF;

  final_work := public.reliability_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '85211111-1111-4111-8111-111111111111',
    p_action => 'record_work_outcome',
    p_expected_revision => 3,
    p_idempotency_key => 'reliability-head:outcome:a',
    p_request_fingerprint => repeat('9', 64),
    p_actor_type => 'agent',
    p_actor_id => 'reliability-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'business_outcome_receipt',
      'source_id', 'synthetic-recovery-achieved',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_outcome_state => 'achieved'
  );
  IF final_work->'case'->>'outcome_state' <> 'achieved'
     OR final_work->'case'->>'outcome_verified' <> 'true' THEN
    RAISE EXCEPTION 'Reliability Head outcome did not verify';
  END IF;

  PERFORM public.reliability_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '85311111-1111-4111-8111-111111111111',
    p_action => 'recommend_decision',
    p_expected_revision => 0,
    p_idempotency_key => 'reliability-head:decision:a',
    p_request_fingerprint => repeat('0', 64),
    p_actor_type => 'agent',
    p_actor_id => 'reliability-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'supervised_recommendation',
      'source_id', 'synthetic-decision-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_sla_due_at => now() + interval '1 day',
    p_title => 'Approve supervised reliability change',
    p_contract => '{"recommendation":"keep write authority disabled"}'::jsonb
  );

  BEGIN
    PERFORM public.reliability_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '85311111-1111-4111-8111-111111111111',
      p_action => 'decide_recommendation',
      p_expected_revision => 1,
      p_idempotency_key => 'reliability-head:agent-approval',
      p_request_fingerprint => repeat('e', 64),
      p_actor_type => 'agent',
      p_actor_id => 'reliability-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'human_decision_record',
        'source_id', 'synthetic-agent-approval',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_decision => 'approved'
    );
    RAISE EXCEPTION 'expected agent decision approval denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'reliability_head_human_decision_required' THEN
      RAISE;
    END IF;
  END;
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
DECLARE
  own_count integer;
  other_count integer;
BEGIN
  SELECT count(*) INTO own_count
    FROM public.reliability_head_reports
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
  SELECT count(*) INTO other_count
    FROM public.reliability_head_reports
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  IF own_count <> 1 OR other_count <> 0 THEN
    RAISE EXCEPTION 'expected exact-tenant Reliability Head RLS visibility';
  END IF;
END $$;
ROLLBACK;

DO $$
BEGIN
  BEGIN
    UPDATE public.reliability_head_events
       SET evidence = '{"tampered":true}'::jsonb
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable Reliability Head evidence denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'reliability_head_evidence_is_immutable' THEN
      RAISE;
    END IF;
  END;
END $$;

BEGIN;
UPDATE public.reliability_head_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       revision = revision + 1
 WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.reliability_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '85911111-1111-4111-8111-111111111111',
      p_report_type => 'reliability',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'unknown',
      p_outcome_health_state => 'unknown',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"verified_recovery_rate",
        "verification_state":"unknown"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic killed"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'accepted_department_report',
        'source_id', 'synthetic-killed',
        'observed_at', now()
      ),
      p_idempotency_key => 'reliability-head:killed',
      p_request_fingerprint => repeat('f', 64),
      p_actor_type => 'agent',
      p_actor_id => 'reliability-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 1,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected Reliability Head kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT IN (
      'reliability_head_tenant_not_enabled',
      'reliability_head_kill_switch_engaged'
    ) THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;
