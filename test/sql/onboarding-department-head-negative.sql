\set ON_ERROR_STOP on

-- Migration 088 runtime proof. Run after autonomous-os-tenant-negative.sql.
-- All identities and evidence are synthetic. No customer, provider, production,
-- provisioning, or financial action occurs.

DO $$
BEGIN
  BEGIN
    INSERT INTO public.onboarding_head_controls (
      tenant_id, registered_head_id, mission, kpi_contract,
      authority_contract, enabled, execution_mode, kill_switch_engaged,
      activated_by, activation_evidence
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'onboarding-head-v1',
      'Deliver acknowledged implementations with evidence and proven customer outcomes.',
      '{
        "closed_won_to_accept_minutes":{},
        "accepted_to_acknowledged_minutes":{},
        "evidence_complete_handoff_rate":{},
        "implementation_completion_rate":{},
        "onboarding_sla_compliance_rate":{},
        "exception_resolution_rate":{},
        "time_to_first_value_days":{},
        "customer_outcome_receipt_rate":{}
      }'::jsonb,
      '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
      true, 'shadow', false,
      'ffffffff-2222-4222-8222-222222222222',
      '{"source":"synthetic_cross_tenant_approval"}'::jsonb
    );
    RAISE EXCEPTION 'expected cross-tenant Onboarding Head activation denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'onboarding_head_activation_actor_not_tenant_admin' THEN
      RAISE;
    END IF;
  END;
END $$;

INSERT INTO public.onboarding_head_controls (
  tenant_id, registered_head_id, mission, kpi_contract,
  authority_contract, enabled, execution_mode, kill_switch_engaged,
  activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'onboarding-head-v1',
    'Deliver acknowledged implementations with evidence and proven customer outcomes.',
    '{
      "closed_won_to_accept_minutes":{"target":"lte_60"},
      "accepted_to_acknowledged_minutes":{"target":"lte_240"},
      "evidence_complete_handoff_rate":{"target":"eq_1"},
      "implementation_completion_rate":{"target":"gte_0_95"},
      "onboarding_sla_compliance_rate":{"target":"gte_0_95"},
      "exception_resolution_rate":{"target":"gte_0_95"},
      "time_to_first_value_days":{"target":"lte_14"},
      "customer_outcome_receipt_rate":{"target":"eq_1"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
    true, 'shadow', false,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_test_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'onboarding-head-v1',
    'Deliver acknowledged implementations with evidence and proven customer outcomes.',
    '{
      "closed_won_to_accept_minutes":{"target":"lte_60"},
      "accepted_to_acknowledged_minutes":{"target":"lte_240"},
      "evidence_complete_handoff_rate":{"target":"eq_1"},
      "implementation_completion_rate":{"target":"gte_0_95"},
      "onboarding_sla_compliance_rate":{"target":"gte_0_95"},
      "exception_resolution_rate":{"target":"gte_0_95"},
      "time_to_first_value_days":{"target":"lte_14"},
      "customer_outcome_receipt_rate":{"target":"eq_1"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
    true, 'shadow', false,
    'ffffffff-2222-4222-8222-222222222222',
    '{"source":"synthetic_test_approval"}'::jsonb
  );

SELECT set_config(
  'app.fixture_onboarding_handoff_id',
  handoff.id::text,
  false
)
  FROM public.closed_won_onboarding_handoffs handoff
  JOIN public.sales_closed_won_events event
    ON event.id = handoff.closed_won_event_id
   AND event.source_tenant_id = handoff.source_tenant_id
 WHERE event.source_event_key = 'fixture:closed-won:tenant-a';

DO $$
BEGIN
  BEGIN
    UPDATE public.onboarding_head_controls
       SET provisioning_authority = true
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected prohibited Onboarding Head authority denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'onboarding_head_prohibited_authority' THEN
      RAISE;
    END IF;
  END;
END $$;

BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE public.onboarding_head_controls
       SET revision = revision + 1
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected direct service-role write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
UPDATE public.onboarding_head_controls
   SET registered_head_id = 'eeeeeeee-1111-4111-8111-111111111111'
 WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"eeeeeeee-1111-4111-8111-111111111111","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.onboarding_customer_outcome_receipt_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_receipt_id => '88611111-1111-4111-8111-111111111111',
      p_outcome_state => 'achieved',
      p_outcome_code => 'first_value_verified',
      p_measured_at => now(),
      p_evidence_ref => 'customer-success/outcome/8861',
      p_evidence_digest => repeat('b', 64),
      p_idempotency_key => 'onboarding-outcome:self-verify',
      p_request_fingerprint => repeat('a', 64)
    );
    RAISE EXCEPTION 'expected Onboarding Head self-verification denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'onboarding_customer_outcome_head_cannot_verify' THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.onboarding_customer_outcome_receipt_rpc(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '66666666-2222-4222-8222-222222222222',
      '88611111-1111-4111-8111-111111111111',
      'achieved', 'first_value_verified', now(),
      'customer-success/outcome/8861', repeat('b', 64),
      'onboarding-outcome:service-denied', repeat('b', 64)
    );
    RAISE EXCEPTION 'expected service outcome verification denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"ffffffff-2222-4222-8222-222222222222","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"tenant_owner"}}',
  true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.onboarding_customer_outcome_receipt_rpc(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '66666666-2222-4222-8222-222222222222',
      '88611111-1111-4111-8111-111111111111',
      'achieved', 'first_value_verified', now(),
      'customer-success/outcome/8861', repeat('b', 64),
      'onboarding-outcome:cross-tenant', repeat('c', 64)
    );
    RAISE EXCEPTION 'expected cross-tenant outcome verifier denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'onboarding_customer_outcome_verifier_not_tenant_owner' THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"eeeeeeee-1111-4111-8111-111111111111","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
DECLARE receipt_result jsonb;
BEGIN
  receipt_result := public.onboarding_customer_outcome_receipt_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_workflow_id => '66666666-2222-4222-8222-222222222222',
    p_receipt_id => '88611111-1111-4111-8111-111111111111',
    p_outcome_state => 'achieved',
    p_outcome_code => 'first_value_verified',
    p_measured_at => now(),
    p_evidence_ref => 'customer-success/outcome/8861',
    p_evidence_digest => repeat('b', 64),
    p_idempotency_key => 'onboarding-outcome:owner-verified',
    p_request_fingerprint => repeat('d', 64)
  );
  IF receipt_result->>'outcome' <> 'accepted' THEN
    RAISE EXCEPTION 'expected canonical customer outcome receipt';
  END IF;
END $$;
COMMIT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.onboarding_head_reports report
     WHERE report.evidence::text ~* 'customer[_ -]?email'
        OR report.kpi_results::text ~* 'customer[_ -]?email'
        OR report.report_body::text ~* 'customer[_ -]?email'
  ) OR EXISTS (
    SELECT 1 FROM public.onboarding_head_events event
     WHERE event.evidence::text ~* 'customer[_ -]?email'
  ) OR EXISTS (
    SELECT 1 FROM public.onboarding_head_cases head_case
     WHERE head_case.contract::text ~* 'customer[_ -]?email'
  ) THEN
    RAISE EXCEPTION 'CustomerEmail evidence persisted';
  END IF;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
DECLARE v_handoff_id uuid;
BEGIN
  v_handoff_id := current_setting('app.fixture_onboarding_handoff_id')::uuid;
  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88111111-1111-4111-8111-111111111111',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id => NULL,
      p_report_type => 'implementation',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_customer_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"implementation_completion_rate",
        "verification_state":"verified",
        "evidence_ref":"workflow:synthetic"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'onboarding_workflow_receipt',
        'source_id', 'synthetic-auth-denied',
        'observed_at', now()
      ),
      p_idempotency_key => 'onboarding-head:auth-denied',
      p_request_fingerprint => repeat('a', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected authenticated Onboarding Head RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE v_handoff_id uuid;
BEGIN
  v_handoff_id := current_setting('app.fixture_onboarding_handoff_id')::uuid;

  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88111111-1111-4111-8111-111111111111',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id => NULL,
      p_report_type => 'implementation',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_customer_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"implementation_completion_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'onboarding_workflow_receipt',
        'source_id', 'synthetic-disabled',
        'observed_at', now()
      ),
      p_idempotency_key => 'onboarding-head:disabled',
      p_request_fingerprint => repeat('b', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled Onboarding Head write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88111111-1111-4111-8111-111111111111',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id => NULL,
      p_report_type => 'implementation',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_customer_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"implementation_completion_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'onboarding_workflow_receipt',
        'source_id', 'synthetic-agent-mismatch',
        'observed_at', now()
      ),
      p_idempotency_key => 'onboarding-head:agent-mismatch',
      p_request_fingerprint => repeat('c', 64),
      p_actor_type => 'agent',
      p_actor_id => 'imposter-onboarding-head',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected Onboarding Head agent identity denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'onboarding_head_agent_identity_mismatch' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88111111-2222-4222-8222-222222222222',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id => NULL,
      p_report_type => 'implementation',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_customer_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"implementation_completion_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic cross tenant"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'onboarding_workflow_receipt',
        'source_id', 'synthetic-cross-handoff',
        'observed_at', now()
      ),
      p_idempotency_key => 'onboarding-head:cross-handoff',
      p_request_fingerprint => repeat('d', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant Onboarding Head handoff denial';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'onboarding_head_handoff_not_found_for_identity' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88911111-1111-4111-8111-111111111111',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id => NULL,
      p_report_type => 'customer_outcome',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_customer_outcome_state => 'achieved',
      p_outcome_verified => true,
      p_kpi_results => '[{
        "kpi_key":"time_to_first_value_days",
        "verification_state":"verified",
        "evidence_ref":"receipt:synthetic"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic incomplete proof"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'customer_outcome_receipt',
        'source_id', 'synthetic-achieved',
        'observed_at', now()
      ),
      p_idempotency_key => 'onboarding-head:synthetic-achieved',
      p_request_fingerprint => repeat('e', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected synthetic-achieved canonical receipt denial';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'onboarding_head_canonical_outcome_receipt_required' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88911111-1111-4111-8111-111111111111',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id =>
        '88611111-1111-4111-8111-111111111111',
      p_report_type => 'customer_outcome',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_customer_outcome_state => 'achieved',
      p_outcome_verified => true,
      p_kpi_results => '[{
        "kpi_key":"time_to_first_value_days",
        "verification_state":"verified",
        "evidence_ref":"receipt:synthetic"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic incomplete KPI proof"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'customer_outcome_receipt',
        'source_id', 'canonical-receipt-8861',
        'observed_at', now()
      ),
      p_idempotency_key => 'onboarding-head:false-outcome',
      p_request_fingerprint => repeat('f', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected false Onboarding Head customer outcome denial';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'onboarding_head_false_customer_outcome_forbidden' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88711111-1111-4111-8111-111111111111',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id => NULL,
      p_report_type => 'implementation',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_customer_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"implementation_completion_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic CustomerEmail regression"}'::jsonb,
      p_evidence => '{
        "source_type":"onboarding_workflow_receipt",
        "source_id":"synthetic-customer-email",
        "observed_at":"2026-07-24T12:00:00Z",
        "nested":{"CustomerEmail":"must-not-persist@example.invalid"}
      }'::jsonb,
      p_idempotency_key => 'onboarding-head:customer-email',
      p_request_fingerprint => repeat('0', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected CustomerEmail evidence denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'onboarding_head_report_structure_invalid' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  v_handoff_id uuid;
  report_result jsonb;
  work_result jsonb;
  outcome_result jsonb;
BEGIN
  v_handoff_id := current_setting('app.fixture_onboarding_handoff_id')::uuid;

  report_result := public.onboarding_head_report_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_report_id => '88111111-1111-4111-8111-111111111111',
    p_handoff_id => v_handoff_id,
    p_workflow_id => '66666666-2222-4222-8222-222222222222',
    p_customer_outcome_receipt_id => NULL,
    p_report_type => 'implementation',
    p_period_start => now() - interval '1 day',
    p_period_end => now(),
    p_execution_health_state => 'healthy',
    p_customer_outcome_state => 'unproven',
    p_outcome_verified => false,
    p_kpi_results => '[{
      "kpi_key":"implementation_completion_rate",
      "measured_value":1,
      "verification_state":"verified",
      "evidence_ref":"workflow:synthetic"
    }]'::jsonb,
    p_report_body => '{"summary":"implementation complete, outcome unproven"}'::jsonb,
    p_evidence => jsonb_build_object(
      'source_type', 'onboarding_workflow_receipt',
      'source_id', 'synthetic-report-a',
      'observed_at', now()
    ),
    p_idempotency_key => 'onboarding-head:report:a',
    p_request_fingerprint => repeat('1', 64),
    p_actor_type => 'agent',
    p_actor_id => 'onboarding-head-v1',
    p_authority_tier => 'department_head',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF report_result->>'outcome' <> 'accepted'
     OR report_result->'report'->>'customer_outcome_state' <> 'unproven'
     OR report_result->'report'->>'outcome_verified' <> 'false' THEN
    RAISE EXCEPTION 'Onboarding Head report returned false success';
  END IF;

  work_result := public.onboarding_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_case_id => '88311111-1111-4111-8111-111111111111',
    p_action => 'create_work',
    p_expected_revision => 0,
    p_idempotency_key => 'onboarding-head:work:a',
    p_request_fingerprint => repeat('2', 64),
    p_actor_type => 'agent',
    p_actor_id => 'onboarding-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'supervised_work_assignment',
      'source_id', 'synthetic-work-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_source_report_id => '88111111-1111-4111-8111-111111111111',
    p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_assignee_id => '77777777-1111-4111-8111-111111111111',
    p_sla_due_at => now() + interval '1 day',
    p_title => 'Verify implementation evidence',
    p_contract => '{
      "objective":"verify implementation",
      "acceptance_criteria":["workflow receipt exists"],
      "completion_contract":"implementation_completion_receipt"
    }'::jsonb
  );
  IF work_result->'case'->>'lifecycle_state' <> 'assigned'
     OR work_result->'case'->>'customer_outcome_state' <> 'unknown'
     OR (work_result->'case'->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'Onboarding Head work returned false success';
  END IF;

  BEGIN
    PERFORM public.onboarding_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_case_id => '88311111-1111-4111-8111-111111111111',
      p_action => 'accept_work',
      p_expected_revision => 0,
      p_idempotency_key => 'onboarding-head:stale',
      p_request_fingerprint => repeat('3', 64),
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
    RAISE EXCEPTION 'expected stale Onboarding Head revision denial';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'onboarding_head_revision_conflict' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.onboarding_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_case_id => '88311111-1111-4111-8111-111111111111',
      p_action => 'record_customer_outcome',
      p_expected_revision => 1,
      p_idempotency_key => 'onboarding-head:premature-outcome',
      p_request_fingerprint => repeat('4', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'customer_outcome_receipt',
        'source_id', 'synthetic-premature',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_customer_outcome_state => 'achieved',
      p_customer_outcome_receipt_id =>
        '88611111-1111-4111-8111-111111111111'
    );
    RAISE EXCEPTION 'expected Onboarding Head outcome-before-completion denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'onboarding_head_customer_outcome_invalid' THEN RAISE; END IF;
  END;

  PERFORM public.onboarding_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_case_id => '88311111-1111-4111-8111-111111111111',
    p_action => 'accept_work',
    p_expected_revision => 1,
    p_idempotency_key => 'onboarding-head:accept:a',
    p_request_fingerprint => repeat('5', 64),
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
  PERFORM public.onboarding_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_case_id => '88311111-1111-4111-8111-111111111111',
    p_action => 'complete_work',
    p_expected_revision => 2,
    p_idempotency_key => 'onboarding-head:complete:a',
    p_request_fingerprint => repeat('6', 64),
    p_actor_type => 'human',
    p_actor_id => '77777777-1111-4111-8111-111111111111',
    p_authority_tier => 'operator',
    p_evidence => jsonb_build_object(
      'source_type', 'implementation_completion_receipt',
      'source_id', 'synthetic-complete-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.onboarding_head_cases head_case
     WHERE head_case.id = '88311111-1111-4111-8111-111111111111'
       AND head_case.lifecycle_state = 'completed'
       AND head_case.customer_outcome_state = 'unproven'
       AND head_case.customer_outcome_verified = false
  ) THEN
    RAISE EXCEPTION 'implementation completion appeared customer-successful';
  END IF;

  outcome_result := public.onboarding_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_case_id => '88311111-1111-4111-8111-111111111111',
    p_action => 'record_customer_outcome',
    p_expected_revision => 3,
    p_idempotency_key => 'onboarding-head:outcome:a',
    p_request_fingerprint => repeat('7', 64),
    p_actor_type => 'agent',
    p_actor_id => 'onboarding-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'customer_outcome_receipt',
      'source_id', 'synthetic-achieved-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_customer_outcome_state => 'achieved',
    p_customer_outcome_receipt_id =>
      '88611111-1111-4111-8111-111111111111'
  );
  IF outcome_result->'case'->>'customer_outcome_state' <> 'achieved'
     OR outcome_result->'case'->>'customer_outcome_verified' <> 'true'
     OR outcome_result->'case'->>'outcome_receipt_id' <>
       '88611111-1111-4111-8111-111111111111' THEN
    RAISE EXCEPTION 'Onboarding Head outcome did not verify';
  END IF;

  PERFORM public.onboarding_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_case_id => '88411111-1111-4111-8111-111111111111',
    p_action => 'recommend_decision',
    p_expected_revision => 0,
    p_idempotency_key => 'onboarding-head:decision:a',
    p_request_fingerprint => repeat('8', 64),
    p_actor_type => 'agent',
    p_actor_id => 'onboarding-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'supervised_recommendation',
      'source_id', 'synthetic-decision-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_source_report_id => '88111111-1111-4111-8111-111111111111',
    p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_sla_due_at => now() + interval '1 day',
    p_title => 'Approve supervised implementation exception',
    p_contract => '{"recommendation":"manual review required"}'::jsonb
  );
  BEGIN
    PERFORM public.onboarding_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_case_id => '88411111-1111-4111-8111-111111111111',
      p_action => 'decide_recommendation',
      p_expected_revision => 1,
      p_idempotency_key => 'onboarding-head:agent-approval',
      p_request_fingerprint => repeat('9', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
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
    RAISE EXCEPTION 'expected agent Onboarding Head approval denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'onboarding_head_human_decision_required' THEN RAISE; END IF;
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
DECLARE own_count integer; other_count integer;
BEGIN
  SELECT count(*) INTO own_count FROM public.onboarding_head_reports
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
  SELECT count(*) INTO other_count FROM public.onboarding_head_reports
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  IF own_count <> 1 OR other_count <> 0 THEN
    RAISE EXCEPTION 'expected exact-tenant Onboarding Head RLS visibility';
  END IF;
END $$;
ROLLBACK;

DO $$
BEGIN
  BEGIN
    UPDATE public.onboarding_head_events
       SET evidence = '{"tampered":true}'::jsonb
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable Onboarding Head evidence denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'onboarding_head_evidence_is_immutable' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.onboarding_customer_outcome_receipts
       SET outcome_code = 'tampered_outcome'
     WHERE id = '88611111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable canonical outcome receipt denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'onboarding_head_evidence_is_immutable' THEN RAISE; END IF;
  END;
END $$;

BEGIN;
UPDATE public.onboarding_head_controls
   SET enabled = false, execution_mode = 'disabled',
       kill_switch_engaged = true, revision = revision + 1
 WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE v_handoff_id uuid;
BEGIN
  v_handoff_id := current_setting('app.fixture_onboarding_handoff_id')::uuid;
  BEGIN
    PERFORM public.onboarding_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_client_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '88811111-1111-4111-8111-111111111111',
      p_handoff_id => v_handoff_id,
      p_workflow_id => '66666666-2222-4222-8222-222222222222',
      p_customer_outcome_receipt_id => NULL,
      p_report_type => 'implementation',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'unknown',
      p_customer_outcome_state => 'unknown',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"implementation_completion_rate",
        "verification_state":"unknown"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic killed"}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'onboarding_workflow_receipt',
        'source_id', 'synthetic-killed',
        'observed_at', now()
      ),
      p_idempotency_key => 'onboarding-head:killed',
      p_request_fingerprint => repeat('f', 64),
      p_actor_type => 'agent',
      p_actor_id => 'onboarding-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 1,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected Onboarding Head kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT IN (
      'onboarding_head_tenant_not_enabled',
      'onboarding_head_kill_switch_engaged'
    ) THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
