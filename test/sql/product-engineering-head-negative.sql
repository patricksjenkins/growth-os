\set ON_ERROR_STOP on

-- Migration 092 runtime proof. Run after autonomous-os-tenant-negative.sql.
-- Every identity and evidence item is synthetic. No code merge, deployment,
-- migration, feature activation, release, provider/customer communication,
-- pricing/legal change, or financial action occurs.

CREATE OR REPLACE FUNCTION pg_temp.engineering_manifest(
  p_tenant_id uuid,
  p_source_id uuid,
  p_source_type text,
  p_second_source_id uuid DEFAULT NULL,
  p_second_source_type text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_sources jsonb;
BEGIN
  v_sources := jsonb_build_array(jsonb_build_object(
    'source_type', p_source_type,
    'source_id', p_source_id::text,
    'source_tenant_id', p_tenant_id::text,
    'digest', repeat('b', 64),
    'observed_at', now()
  ));
  IF p_second_source_id IS NOT NULL THEN
    v_sources := v_sources || jsonb_build_array(jsonb_build_object(
      'source_type', p_second_source_type,
      'source_id', p_second_source_id::text,
      'source_tenant_id', p_tenant_id::text,
      'digest', repeat('c', 64),
      'observed_at', now()
    ));
  END IF;
  RETURN jsonb_build_object(
    'source_type', 'engineering_evidence_manifest',
    'source_id', 'synthetic-engineering-manifest',
    'observed_at', now(),
    'sources', v_sources
  );
END;
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.product_engineering_head_controls (
      tenant_id, registered_head_id, mission, kpi_contract,
      authority_contract, enabled, execution_mode, kill_switch_engaged,
      activated_by, activation_evidence
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'product-engineering-head-v1',
      'Protect product quality while proving that engineering work creates measured outcomes.',
      '{
        "reliability_quality_pass_rate":{},
        "change_lead_time_hours":{},
        "change_throughput_rate":{},
        "regression_escape_rate":{},
        "tenant_isolation_gate_pass_rate":{},
        "incident_escape_rate":{},
        "rollback_readiness_rate":{},
        "accessibility_debt_count":{},
        "security_debt_count":{},
        "product_outcome_achievement_rate":{}
      }'::jsonb,
      '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
      true, 'shadow', false,
      'ffffffff-2222-4222-8222-222222222222',
      '{"source":"synthetic_cross_tenant_approval"}'::jsonb
    );
    RAISE EXCEPTION
      'expected cross-tenant Product Engineering Head activation denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <>
      'product_engineering_head_activation_actor_not_tenant_admin' THEN
      RAISE;
    END IF;
  END;
END $$;

INSERT INTO public.product_engineering_head_controls (
  tenant_id, registered_head_id, mission, kpi_contract,
  authority_contract, enabled, execution_mode, kill_switch_engaged,
  activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'product-engineering-head-v1',
    'Protect product quality while proving that engineering work creates measured outcomes.',
    '{
      "reliability_quality_pass_rate":{"target":"eq_1"},
      "change_lead_time_hours":{"target":"lte_24"},
      "change_throughput_rate":{"target":"gte_1"},
      "regression_escape_rate":{"target":"eq_0"},
      "tenant_isolation_gate_pass_rate":{"target":"eq_1"},
      "incident_escape_rate":{"target":"eq_0"},
      "rollback_readiness_rate":{"target":"eq_1"},
      "accessibility_debt_count":{"target":"lte_0"},
      "security_debt_count":{"target":"lte_0"},
      "product_outcome_achievement_rate":{"target":"gte_0_8"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
    true, 'shadow', false,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_test_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'ffffffff-2222-4222-8222-222222222222',
    'Protect product quality while proving that engineering work creates measured outcomes.',
    '{
      "reliability_quality_pass_rate":{"target":"eq_1"},
      "change_lead_time_hours":{"target":"lte_24"},
      "change_throughput_rate":{"target":"gte_1"},
      "regression_escape_rate":{"target":"eq_0"},
      "tenant_isolation_gate_pass_rate":{"target":"eq_1"},
      "incident_escape_rate":{"target":"eq_0"},
      "rollback_readiness_rate":{"target":"eq_1"},
      "accessibility_debt_count":{"target":"lte_0"},
      "security_debt_count":{"target":"lte_0"},
      "product_outcome_achievement_rate":{"target":"gte_0_8"}
    }'::jsonb,
    '{"allowed":["analyze","recommend","record_supervised_work","escalate"]}'::jsonb,
    true, 'shadow', false,
    'ffffffff-2222-4222-8222-222222222222',
    '{"source":"synthetic_test_approval"}'::jsonb
  );

DO $$
BEGIN
  BEGIN
    UPDATE public.product_engineering_head_controls
       SET deployment_authority = true
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION
      'expected prohibited Product Engineering Head authority denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'product_engineering_head_prohibited_authority' THEN
      RAISE;
    END IF;
  END;
END $$;

BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE public.product_engineering_head_controls
       SET revision = revision + 1
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected direct service-role write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
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
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92111111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92211111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'reliability_quality',
      p_product_scope => 'platform',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_product_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"reliability_quality_pass_rate",
        "verification_state":"verified",
        "evidence_ref":"synthetic:test-run"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92211111-1111-4111-8111-111111111111',
        'automated_test_run'
      ),
      p_idempotency_key => 'product-engineering:auth-denied',
      p_request_fingerprint => repeat('a', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION
      'expected authenticated Product Engineering Head RPC denial';
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
    PERFORM public.product_engineering_outcome_receipt_rpc(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '92811111-1111-4111-8111-111111111111',
      'achieved', repeat('d', 64), now(),
      jsonb_build_object(
        'source_type', 'owner_verified_product_outcome',
        'source_id', '92811111-1111-4111-8111-111111111111',
        'observed_at', now(), 'measurement_digest', repeat('d', 64)
      ),
      'product-engineering:service-owner-impersonation',
      repeat('2', 64), 'eeeeeeee-1111-4111-8111-111111111111', 0, true
    );
    RAISE EXCEPTION 'expected service owner-impersonation denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"ffffffff-2222-4222-8222-222222222222","app_metadata":{"tenant_id":"22222222-2222-4222-8222-222222222222","role":"tenant_owner"}}',
  true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.product_engineering_outcome_receipt_rpc(
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222222',
      '92822222-2222-4222-8222-222222222222',
      'achieved', repeat('d', 64), now(),
      jsonb_build_object(
        'source_type', 'owner_verified_product_outcome',
        'source_id', '92822222-2222-4222-8222-222222222222',
        'observed_at', now(), 'measurement_digest', repeat('d', 64)
      ),
      'product-engineering:head-self-verification-denied',
      repeat('2', 64), 'ffffffff-2222-4222-8222-222222222222', 0, true
    );
    RAISE EXCEPTION 'expected registered Head self-verification denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <>
      'product_engineering_head_outcome_verifier_must_be_independent' THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"77777777-1111-4111-8111-111111111111","app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"member"}}',
  true
);
DO $$
BEGIN
  BEGIN
    PERFORM public.product_engineering_outcome_receipt_rpc(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '92811111-1111-4111-8111-111111111111',
      'achieved', repeat('d', 64), now(),
      jsonb_build_object(
        'source_type', 'owner_verified_product_outcome',
        'source_id', '92811111-1111-4111-8111-111111111111',
        'observed_at', now(), 'measurement_digest', repeat('d', 64)
      ),
      'product-engineering:member-receipt-denied',
      repeat('2', 64), '77777777-1111-4111-8111-111111111111', 0, true
    );
    RAISE EXCEPTION 'expected non-owner outcome verifier denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'product_engineering_head_outcome_owner_role_required' THEN
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
DECLARE
  v_observed_at timestamptz := now();
  v_receipt jsonb;
  v_replay jsonb;
BEGIN
  v_receipt := public.product_engineering_outcome_receipt_rpc(
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '92811111-1111-4111-8111-111111111111',
    'achieved', repeat('d', 64), v_observed_at,
    jsonb_build_object(
      'source_type', 'owner_verified_product_outcome',
      'source_id', '92811111-1111-4111-8111-111111111111',
      'observed_at', v_observed_at, 'measurement_digest', repeat('d', 64)
    ),
    'product-engineering:owner-outcome-receipt',
    repeat('2', 64), 'eeeeeeee-1111-4111-8111-111111111111', 0, true
  );
  v_replay := public.product_engineering_outcome_receipt_rpc(
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '92811111-1111-4111-8111-111111111111',
    'achieved', repeat('d', 64), v_observed_at,
    jsonb_build_object(
      'source_type', 'owner_verified_product_outcome',
      'source_id', '92811111-1111-4111-8111-111111111111',
      'observed_at', v_observed_at, 'measurement_digest', repeat('d', 64)
    ),
    'product-engineering:owner-outcome-receipt',
    repeat('2', 64), 'eeeeeeee-1111-4111-8111-111111111111', 0, true
  );
  IF v_receipt->>'outcome' <> 'accepted'
     OR v_replay->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected canonical owner receipt and replay';
  END IF;
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92111111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92211111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'reliability_quality',
      p_product_scope => 'platform',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_product_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"reliability_quality_pass_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic disabled"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92211111-1111-4111-8111-111111111111',
        'automated_test_run'
      ),
      p_idempotency_key => 'product-engineering:disabled',
      p_request_fingerprint => repeat('b', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION
      'expected disabled Product Engineering Head write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92111111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92211111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'reliability_quality',
      p_product_scope => 'platform',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_product_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"reliability_quality_pass_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic wrong head"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92211111-1111-4111-8111-111111111111',
        'automated_test_run'
      ),
      p_idempotency_key => 'product-engineering:wrong-head',
      p_request_fingerprint => repeat('c', 64),
      p_actor_type => 'agent',
      p_actor_id => 'not-the-registered-head',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected Product Engineering Head identity denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'product_engineering_head_agent_identity_mismatch' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_report_id => '92111111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92211111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'reliability_quality',
      p_product_scope => 'platform',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'unknown',
      p_product_outcome_state => 'unknown',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"reliability_quality_pass_rate",
        "verification_state":"unknown"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic cross tenant"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92211111-1111-4111-8111-111111111111',
        'automated_test_run'
      ),
      p_idempotency_key => 'product-engineering:cross-tenant',
      p_request_fingerprint => repeat('d', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION
      'expected cross-tenant Product Engineering Head report denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'product_engineering_head_cross_tenant_report_forbidden' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92111111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92211111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'regression_isolation',
      p_product_scope => 'platform',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_product_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"tenant_isolation_gate_pass_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic missing isolation gate"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92211111-1111-4111-8111-111111111111',
        'automated_test_run'
      ),
      p_idempotency_key => 'product-engineering:missing-isolation',
      p_request_fingerprint => repeat('e', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected missing isolation evidence denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'product_engineering_head_authoritative_evidence_required' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92711111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92811111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'product_outcome',
      p_product_scope => 'portfolio',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_product_outcome_state => 'achieved',
      p_outcome_verified => true,
      p_kpi_results => '[{
        "kpi_key":"product_outcome_achievement_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic false green"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92811111-1111-4111-8111-111111111111',
        'product_outcome_receipt'
      ),
      p_idempotency_key => 'product-engineering:false-outcome',
      p_request_fingerprint => repeat('f', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION
      'expected false Product Engineering Head outcome denial';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'product_engineering_head_false_product_outcome_forbidden' THEN
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
  v_report jsonb;
  v_replay jsonb;
  v_work jsonb;
  v_outcome jsonb;
  v_receipt_digest text;
  v_receipt_observed_at timestamptz;
BEGIN
  BEGIN
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92911111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92011111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'product_outcome',
      p_product_scope => 'portfolio',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_product_outcome_state => 'achieved',
      p_outcome_verified => true,
      p_kpi_results => jsonb_build_array(jsonb_build_object(
        'kpi_key', 'product_outcome_achievement_rate',
        'measured_value', 1,
        'verification_state', 'verified',
        'evidence_ref',
          'product_outcome_receipt:92011111-1111-4111-8111-111111111111'
      )),
      p_report_body => '{"summary":"caller-labelled outcome"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92011111-1111-4111-8111-111111111111',
        'product_outcome_receipt'
      ),
      p_idempotency_key => 'product-engineering:self-certified-outcome',
      p_request_fingerprint => repeat('2', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected caller-labelled outcome receipt denial';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'product_engineering_head_canonical_outcome_receipt_required' THEN
      RAISE;
    END IF;
  END;

  v_report := public.product_engineering_head_report_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_report_id => '92111111-1111-4111-8111-111111111111',
    p_source_evidence_id => '92211111-1111-4111-8111-111111111111',
    p_source_run_id => NULL,
    p_report_type => 'regression_isolation',
    p_product_scope => 'platform',
    p_period_start => now() - interval '1 day',
    p_period_end => now(),
    p_execution_health_state => 'healthy',
    p_product_outcome_state => 'unproven',
    p_outcome_verified => false,
    p_kpi_results => '[
      {
        "kpi_key":"regression_escape_rate",
        "measured_value":0,
        "verification_state":"verified",
        "evidence_ref":"test-run:synthetic"
      },
      {
        "kpi_key":"tenant_isolation_gate_pass_rate",
        "measured_value":1,
        "verification_state":"verified",
        "evidence_ref":"isolation-gate:synthetic"
      }
    ]'::jsonb,
    p_report_body =>
      '{"summary":"build and isolation passed; outcome unproven"}'::jsonb,
    p_evidence => pg_temp.engineering_manifest(
      '11111111-1111-4111-8111-111111111111',
      '92211111-1111-4111-8111-111111111111',
      'automated_test_run',
      '92511111-1111-4111-8111-111111111111',
      'tenant_isolation_gate'
    ),
    p_idempotency_key => 'product-engineering:valid-regression',
    p_request_fingerprint => repeat('1', 64),
    p_actor_type => 'agent',
    p_actor_id => 'product-engineering-head-v1',
    p_authority_tier => 'department_head',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF v_report->>'outcome' <> 'accepted'
     OR v_report->'report'->>'product_outcome_state' <> 'unproven' THEN
    RAISE EXCEPTION 'expected honest Product Engineering Head report';
  END IF;

  v_replay := public.product_engineering_head_report_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_report_id => '92111111-1111-4111-8111-111111111111',
    p_source_evidence_id => '92211111-1111-4111-8111-111111111111',
    p_source_run_id => NULL,
    p_report_type => 'regression_isolation',
    p_product_scope => 'platform',
    p_period_start => now() - interval '1 day',
    p_period_end => now(),
    p_execution_health_state => 'healthy',
    p_product_outcome_state => 'unproven',
    p_outcome_verified => false,
    p_kpi_results => '[
      {
        "kpi_key":"regression_escape_rate",
        "measured_value":0,
        "verification_state":"verified",
        "evidence_ref":"test-run:synthetic"
      },
      {
        "kpi_key":"tenant_isolation_gate_pass_rate",
        "measured_value":1,
        "verification_state":"verified",
        "evidence_ref":"isolation-gate:synthetic"
      }
    ]'::jsonb,
    p_report_body =>
      '{"summary":"build and isolation passed; outcome unproven"}'::jsonb,
    p_evidence => pg_temp.engineering_manifest(
      '11111111-1111-4111-8111-111111111111',
      '92211111-1111-4111-8111-111111111111',
      'automated_test_run',
      '92511111-1111-4111-8111-111111111111',
      'tenant_isolation_gate'
    ),
    p_idempotency_key => 'product-engineering:valid-regression',
    p_request_fingerprint => repeat('1', 64),
    p_actor_type => 'agent',
    p_actor_id => 'product-engineering-head-v1',
    p_authority_tier => 'department_head',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF v_replay->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected Product Engineering Head idempotent replay';
  END IF;

  BEGIN
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92011111-1111-4111-8111-111111111112',
      p_source_evidence_id => '92011111-1111-4111-8111-111111111113',
      p_source_run_id => NULL,
      p_report_type => 'reliability_quality',
      p_product_scope => 'platform',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'healthy',
      p_product_outcome_state => 'unproven',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"reliability_quality_pass_rate",
        "verification_state":"verified"
      }]'::jsonb,
      p_report_body =>
        '{"summary":"synthetic","CustomerEmail":"sensitive@example.test"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92011111-1111-4111-8111-111111111113',
        'automated_test_run'
      ),
      p_idempotency_key => 'product-engineering:mixed-case-metadata',
      p_request_fingerprint => repeat('2', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected mixed-case sensitive metadata denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'product_engineering_head_report_shape_invalid' THEN
      RAISE;
    END IF;
  END;

  SELECT receipt.evidence_digest, receipt.observed_at
    INTO v_receipt_digest, v_receipt_observed_at
    FROM public.product_engineering_outcome_receipts receipt
   WHERE receipt.id = '92811111-1111-4111-8111-111111111111'
     AND receipt.tenant_id = '11111111-1111-4111-8111-111111111111';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expected canonical owner-verified outcome receipt';
  END IF;

  PERFORM public.product_engineering_head_report_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_report_id => '92711111-1111-4111-8111-111111111111',
    p_source_evidence_id => '92811111-1111-4111-8111-111111111111',
    p_source_run_id => NULL,
    p_report_type => 'product_outcome',
    p_product_scope => 'portfolio',
    p_period_start => now() - interval '1 day',
    p_period_end => now(),
    p_execution_health_state => 'healthy',
    p_product_outcome_state => 'achieved',
    p_outcome_verified => true,
    p_kpi_results => '[{
      "kpi_key":"product_outcome_achievement_rate",
      "measured_value":1,
      "verification_state":"verified",
      "evidence_ref":"product_outcome_receipt:92811111-1111-4111-8111-111111111111"
    }]'::jsonb,
    p_report_body => '{"summary":"synthetic measured product outcome"}'::jsonb,
    p_evidence => jsonb_build_object(
      'source_type', 'engineering_evidence_manifest',
      'source_id', 'synthetic-owner-outcome-manifest',
      'observed_at', now(),
      'sources', jsonb_build_array(jsonb_build_object(
        'source_type', 'product_outcome_receipt',
        'source_id', '92811111-1111-4111-8111-111111111111',
        'source_tenant_id', '11111111-1111-4111-8111-111111111111',
        'digest', v_receipt_digest,
        'observed_at', v_receipt_observed_at
      ))
    ),
    p_idempotency_key => 'product-engineering:valid-outcome',
    p_request_fingerprint => repeat('2', 64),
    p_actor_type => 'agent',
    p_actor_id => 'product-engineering-head-v1',
    p_authority_tier => 'department_head',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );

  v_work := public.product_engineering_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '92411111-1111-4111-8111-111111111111',
    p_action => 'create_work',
    p_expected_revision => 0,
    p_idempotency_key => 'product-engineering:create-work',
    p_request_fingerprint => repeat('3', 64),
    p_actor_type => 'agent',
    p_actor_id => 'product-engineering-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'supervised_work_contract',
      'source_id', 'synthetic-work-contract',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_source_report_id => '92111111-1111-4111-8111-111111111111',
    p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_assignee_id => '77777777-1111-4111-8111-111111111111',
    p_sla_due_at => now() + interval '1 day',
    p_title => 'Verify tenant-isolation release evidence',
    p_contract => '{
      "objective":"verify release evidence",
      "acceptance_criteria":["isolation gate accepted"]
    }'::jsonb
  );
  IF v_work->'case'->>'lifecycle_state' <> 'assigned' THEN
    RAISE EXCEPTION 'expected assigned Product Engineering Head work';
  END IF;

  BEGIN
    PERFORM public.product_engineering_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '92411111-1111-4111-8111-111111111111',
      p_action => 'record_product_outcome',
      p_expected_revision => 1,
      p_idempotency_key => 'product-engineering:early-outcome',
      p_request_fingerprint => repeat('4', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'product_outcome_receipt',
        'source_id', '92811111-1111-4111-8111-111111111111',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_source_report_id => '92711111-1111-4111-8111-111111111111',
      p_product_outcome_state => 'achieved'
    );
    RAISE EXCEPTION
      'expected Product Engineering Head outcome-before-completion denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'product_engineering_head_product_outcome_invalid' THEN
      RAISE;
    END IF;
  END;

  PERFORM public.product_engineering_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '92411111-1111-4111-8111-111111111111',
    p_action => 'accept_work',
    p_expected_revision => 1,
    p_idempotency_key => 'product-engineering:accept-work',
    p_request_fingerprint => repeat('5', 64),
    p_actor_type => 'human',
    p_actor_id => '77777777-1111-4111-8111-111111111111',
    p_authority_tier => 'operator',
    p_evidence => jsonb_build_object(
      'source_type', 'assignment_acceptance',
      'source_id', 'synthetic-assignment-acceptance',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );

  PERFORM public.product_engineering_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '92411111-1111-4111-8111-111111111111',
    p_action => 'complete_work',
    p_expected_revision => 2,
    p_idempotency_key => 'product-engineering:complete-work',
    p_request_fingerprint => repeat('6', 64),
    p_actor_type => 'human',
    p_actor_id => '77777777-1111-4111-8111-111111111111',
    p_authority_tier => 'operator',
    p_evidence => jsonb_build_object(
      'source_type', 'engineering_completion_receipt',
      'source_id', 'synthetic-engineering-completion',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF (
    SELECT product_outcome_state
      FROM public.product_engineering_head_cases
     WHERE id = '92411111-1111-4111-8111-111111111111'
  ) <> 'unproven' THEN
    RAISE EXCEPTION 'engineering completion falsely claimed product outcome';
  END IF;

  BEGIN
    PERFORM public.product_engineering_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '92411111-1111-4111-8111-111111111111',
      p_action => 'record_product_outcome',
      p_expected_revision => 3,
      p_idempotency_key => 'product-engineering:mismatched-outcome-state',
      p_request_fingerprint => repeat('7', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'product_outcome_receipt',
        'source_id', '92811111-1111-4111-8111-111111111111',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_source_report_id => '92711111-1111-4111-8111-111111111111',
      p_product_outcome_state => 'not_achieved'
    );
    RAISE EXCEPTION 'expected mismatched report outcome state denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'product_engineering_head_product_outcome_invalid' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.product_engineering_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '92411111-1111-4111-8111-111111111111',
      p_action => 'record_product_outcome',
      p_expected_revision => 0,
      p_idempotency_key => 'product-engineering:stale-outcome',
      p_request_fingerprint => repeat('7', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'product_outcome_receipt',
        'source_id', '92811111-1111-4111-8111-111111111111',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_product_outcome_state => 'achieved'
    );
    RAISE EXCEPTION
      'expected stale Product Engineering Head revision denial';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'product_engineering_head_revision_conflict' THEN
      RAISE;
    END IF;
  END;

  v_outcome := public.product_engineering_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '92411111-1111-4111-8111-111111111111',
    p_action => 'record_product_outcome',
    p_expected_revision => 3,
    p_idempotency_key => 'product-engineering:record-outcome',
    p_request_fingerprint => repeat('8', 64),
    p_actor_type => 'agent',
    p_actor_id => 'product-engineering-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'product_outcome_receipt',
      'source_id', '92811111-1111-4111-8111-111111111111',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_source_report_id => '92711111-1111-4111-8111-111111111111',
    p_product_outcome_state => 'achieved'
  );
  IF v_outcome->'case'->>'product_outcome_state' <> 'achieved' THEN
    RAISE EXCEPTION 'expected verified Product Engineering Head outcome';
  END IF;

  PERFORM public.product_engineering_head_case_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_case_id => '92611111-1111-4111-8111-111111111111',
    p_action => 'recommend_decision',
    p_expected_revision => 0,
    p_idempotency_key => 'product-engineering:recommend',
    p_request_fingerprint => repeat('9', 64),
    p_actor_type => 'agent',
    p_actor_id => 'product-engineering-head-v1',
    p_authority_tier => 'department_head',
    p_evidence => jsonb_build_object(
      'source_type', 'engineering_recommendation',
      'source_id', 'synthetic-recommendation',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_source_report_id => '92111111-1111-4111-8111-111111111111',
    p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_sla_due_at => now() + interval '1 day',
    p_title => 'Recommend a supervised engineering priority',
    p_contract => '{"decision_required":"prioritize synthetic work"}'::jsonb
  );
  BEGIN
    PERFORM public.product_engineering_head_case_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_case_id => '92611111-1111-4111-8111-111111111111',
      p_action => 'decide_recommendation',
      p_expected_revision => 1,
      p_idempotency_key => 'product-engineering:self-approve',
      p_request_fingerprint => repeat('0', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_evidence => jsonb_build_object(
        'source_type', 'human_decision_record',
        'source_id', 'synthetic-agent-decision',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_decision => 'approved'
    );
    RAISE EXCEPTION
      'expected agent Product Engineering Head approval denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'product_engineering_head_human_decision_required' THEN
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
  own_receipt_count integer;
  other_receipt_count integer;
BEGIN
  SELECT count(*) INTO own_count
    FROM public.product_engineering_head_reports
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
  SELECT count(*) INTO other_count
    FROM public.product_engineering_head_reports
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  SELECT count(*) INTO own_receipt_count
    FROM public.product_engineering_outcome_receipts
   WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
  SELECT count(*) INTO other_receipt_count
    FROM public.product_engineering_outcome_receipts
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  IF own_count <> 2 OR other_count <> 0
     OR own_receipt_count <> 1 OR other_receipt_count <> 0 THEN
    RAISE EXCEPTION
      'expected exact-tenant Product Engineering Head RLS visibility';
  END IF;
END $$;
ROLLBACK;

DO $$
BEGIN
  BEGIN
    UPDATE public.product_engineering_head_reports
       SET report_body = '{"tampered":true}'::jsonb
     WHERE id = '92111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION
      'expected immutable Product Engineering Head evidence denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'product_engineering_head_evidence_is_immutable' THEN
      RAISE;
    END IF;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE public.product_engineering_outcome_receipts
       SET outcome_state = 'not_achieved'
     WHERE id = '92811111-1111-4111-8111-111111111111';
    RAISE EXCEPTION
      'expected immutable Product Engineering outcome receipt denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'product_engineering_head_evidence_is_immutable' THEN
      RAISE;
    END IF;
  END;
END $$;

BEGIN;
UPDATE public.product_engineering_head_controls
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
    PERFORM public.product_engineering_head_report_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_product_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_report_id => '92911111-1111-4111-8111-111111111111',
      p_source_evidence_id => '92011111-1111-4111-8111-111111111111',
      p_source_run_id => NULL,
      p_report_type => 'reliability_quality',
      p_product_scope => 'platform',
      p_period_start => now() - interval '1 day',
      p_period_end => now(),
      p_execution_health_state => 'unknown',
      p_product_outcome_state => 'unknown',
      p_outcome_verified => false,
      p_kpi_results => '[{
        "kpi_key":"reliability_quality_pass_rate",
        "verification_state":"unknown"
      }]'::jsonb,
      p_report_body => '{"summary":"synthetic killed"}'::jsonb,
      p_evidence => pg_temp.engineering_manifest(
        '11111111-1111-4111-8111-111111111111',
        '92011111-1111-4111-8111-111111111111',
        'automated_test_run'
      ),
      p_idempotency_key => 'product-engineering:killed',
      p_request_fingerprint => repeat('a', 64),
      p_actor_type => 'agent',
      p_actor_id => 'product-engineering-head-v1',
      p_authority_tier => 'department_head',
      p_expected_control_revision => 1,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected Product Engineering Head kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT IN (
      'product_engineering_head_tenant_not_enabled',
      'product_engineering_head_kill_switch_engaged'
    ) THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;
