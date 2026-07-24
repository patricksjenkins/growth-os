\set ON_ERROR_STOP on

-- Migration 083 runtime proof. Run after autonomous-os-tenant-negative.sql.
-- All identifiers and evidence are synthetic; no provider or customer action
-- is performed.

DO $$
BEGIN
  BEGIN
    INSERT INTO public.client_health_automation_controls (
      tenant_id, enabled, execution_mode, kill_switch_engaged, revision,
      activated_by, activation_evidence
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      true, 'shadow', false, 0,
      'ffffffff-2222-4222-8222-222222222222',
      '{"source":"synthetic_cross_tenant_approval"}'::jsonb
    );
    RAISE EXCEPTION 'expected cross-tenant client-health activation denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'client_health_activation_actor_not_tenant_admin' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO public.client_health_automation_controls (
      tenant_id, enabled, execution_mode, kill_switch_engaged, revision,
      activated_by, activation_evidence
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      true, 'shadow', false, 0,
      '83999999-9999-4999-8999-999999999999',
      '{"source":"synthetic_non_member_approval"}'::jsonb
    );
    RAISE EXCEPTION 'expected non-member client-health activation denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'client_health_activation_actor_not_tenant_admin' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    INSERT INTO public.client_health_automation_controls (
      tenant_id, enabled, execution_mode, kill_switch_engaged, revision,
      activated_by, activation_evidence
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      true, 'shadow', false, 0,
      'eeeeeeee-1111-4111-8111-111111111111',
      '["synthetic_not_an_object"]'::jsonb
    );
    RAISE EXCEPTION 'expected malformed client-health activation evidence denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'client_health_activation_invalid' THEN
      RAISE;
    END IF;
  END;
END $$;

INSERT INTO public.client_health_automation_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged, revision,
  activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true, 'shadow', false, 0,
    'eeeeeeee-1111-4111-8111-111111111111',
    '{"source":"synthetic_test_approval"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
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
    PERFORM public.client_health_signal_snapshot_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_snapshot_id => '83111111-1111-4111-8111-111111111111',
      p_signal_state => 'at_risk',
      p_provenance_type => 'heuristic',
      p_dimensions => '{"engagement":{"state":"unproven"}}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'heuristic_snapshot',
        'source_id', 'synthetic-auth-denied',
        'observed_at', now()
      ),
      p_idempotency_key => 'client-health:auth-denied',
      p_request_fingerprint => repeat('a', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_authority_tier => 'system',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected authenticated client-health RPC denial';
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
    INSERT INTO public.client_health_signal_snapshots (
      id, tenant_id, customer_id, signal_state, provenance_type, dimensions,
      evidence, evidence_digest, evidence_observed_at, actor_type,
      authority_tier, idempotency_key, request_fingerprint,
      semantic_fingerprint
    ) VALUES (
      '83111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      'cccccccc-1111-4111-8111-111111111111',
      'at_risk', 'heuristic', '{"engagement":{"state":"unproven"}}'::jsonb,
      '{"source_type":"heuristic_snapshot"}'::jsonb, repeat('a', 64), now(),
      'system', 'system', 'client-health:direct-denied',
      repeat('a', 64), repeat('a', 64)
    );
    RAISE EXCEPTION 'expected direct service-role client-health write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.client_health_signal_snapshot_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_snapshot_id => '83111111-1111-4111-8111-111111111111',
      p_signal_state => 'at_risk',
      p_provenance_type => 'heuristic',
      p_dimensions => '{"engagement":{"state":"unproven"}}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'heuristic_snapshot',
        'source_id', 'synthetic-disabled',
        'observed_at', now()
      ),
      p_idempotency_key => 'client-health:disabled',
      p_request_fingerprint => repeat('b', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_authority_tier => 'system',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => false
    );
    RAISE EXCEPTION 'expected disabled client-health write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.client_health_signal_snapshot_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_customer_id => 'dddddddd-2222-4222-8222-222222222222',
      p_snapshot_id => '83111111-1111-4111-8111-111111111111',
      p_signal_state => 'at_risk',
      p_provenance_type => 'observed',
      p_dimensions => '{"engagement":{"state":"at_risk"}}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'observed_signal',
        'source_id', 'synthetic-cross-customer',
        'observed_at', now()
      ),
      p_idempotency_key => 'client-health:cross-customer',
      p_request_fingerprint => repeat('c', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_authority_tier => 'system',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected cross-tenant customer denial';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'client_health_customer_not_found_for_tenant' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.client_health_signal_snapshot_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_snapshot_id => '83911111-1111-4111-8111-111111111111',
      p_signal_state => 'stable',
      p_provenance_type => 'heuristic',
      p_dimensions => '{"engagement":{"state":"green"}}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'heuristic_snapshot',
        'source_id', 'synthetic-false-green',
        'observed_at', now()
      ),
      p_idempotency_key => 'client-health:false-green',
      p_request_fingerprint => repeat('d', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_authority_tier => 'system',
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected heuristic stable signal denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'client_health_signal_contract_invalid' THEN
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
  signal_a jsonb;
  intervention_a jsonb;
  final_a jsonb;
BEGIN
  signal_a := public.client_health_signal_snapshot_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
    p_snapshot_id => '83111111-1111-4111-8111-111111111111',
    p_signal_state => 'at_risk',
    p_provenance_type => 'heuristic',
    p_dimensions => '{"engagement":{"state":"unproven","observations":3}}'::jsonb,
    p_evidence => jsonb_build_object(
      'source_type', 'heuristic_snapshot',
      'source_id', 'synthetic-signal-a',
      'observed_at', now()
    ),
    p_idempotency_key => 'client-health:signal:a',
    p_request_fingerprint => repeat('1', 64),
    p_actor_type => 'system',
    p_actor_id => NULL,
    p_authority_tier => 'system',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );
  IF signal_a->>'outcome' <> 'applied'
     OR signal_a->'snapshot'->>'outcome_evidence_eligible' <> 'false' THEN
    RAISE EXCEPTION 'heuristic signal returned false success';
  END IF;

  PERFORM public.client_health_signal_snapshot_rpc(
    p_tenant_id => '22222222-2222-4222-8222-222222222222',
    p_customer_id => 'dddddddd-2222-4222-8222-222222222222',
    p_snapshot_id => '83111111-2222-4222-8222-222222222222',
    p_signal_state => 'at_risk',
    p_provenance_type => 'observed',
    p_dimensions => '{"support":{"state":"at_risk","open_count":4}}'::jsonb,
    p_evidence => jsonb_build_object(
      'source_type', 'observed_signal',
      'source_id', 'synthetic-signal-b',
      'observed_at', now()
    ),
    p_idempotency_key => 'client-health:signal:b',
    p_request_fingerprint => repeat('2', 64),
    p_actor_type => 'system',
    p_actor_id => NULL,
    p_authority_tier => 'system',
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );

  BEGIN
    PERFORM public.client_health_intervention_command_rpc(
      p_tenant_id => '22222222-2222-4222-8222-222222222222',
      p_customer_id => 'dddddddd-2222-4222-8222-222222222222',
      p_intervention_id => '83211111-2222-4222-8222-222222222222',
      p_action => 'open_intervention',
      p_expected_revision => 0,
      p_idempotency_key => 'client-health:cross-signal',
      p_request_fingerprint => repeat('3', 64),
      p_actor_type => 'service',
      p_actor_id => 'client-health-shadow-worker',
      p_authority_tier => 'client_success',
      p_evidence => jsonb_build_object(
        'source_type', 'intervention_assignment',
        'source_id', 'synthetic-cross-signal',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_signal_snapshot_id => '83111111-1111-4111-8111-111111111111',
      p_owner_id => 'ffffffff-2222-4222-8222-222222222222',
      p_assignee_id => 'ffffffff-2222-4222-8222-222222222222',
      p_sla_due_at => now() + interval '1 day',
      p_action_plan => '{
        "objective":"Verify adoption",
        "action_type":"activation_review",
        "success_metric":"activation_receipt"
      }'::jsonb
    );
    RAISE EXCEPTION 'expected cross-tenant signal denial';
  EXCEPTION WHEN no_data_found THEN
    IF SQLERRM <> 'client_health_signal_not_found_for_identity' THEN
      RAISE;
    END IF;
  END;

  intervention_a := public.client_health_intervention_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
    p_intervention_id => '83211111-1111-4111-8111-111111111111',
    p_action => 'open_intervention',
    p_expected_revision => 0,
    p_idempotency_key => 'client-health:open:a',
    p_request_fingerprint => repeat('4', 64),
    p_actor_type => 'service',
    p_actor_id => 'client-health-shadow-worker',
    p_authority_tier => 'client_success',
    p_evidence => jsonb_build_object(
      'source_type', 'intervention_assignment',
      'source_id', 'synthetic-open-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_signal_snapshot_id => '83111111-1111-4111-8111-111111111111',
    p_owner_id => 'eeeeeeee-1111-4111-8111-111111111111',
    p_assignee_id => '77777777-1111-4111-8111-111111111111',
    p_sla_due_at => now() + interval '1 day',
    p_action_plan => '{
      "objective":"Restore verified adoption",
      "action_type":"guided_activation_review",
      "success_metric":"verified_activation_receipt"
    }'::jsonb
  );
  IF intervention_a->>'outcome' <> 'applied'
     OR intervention_a->'intervention'->>'lifecycle_state' <> 'assigned'
     OR intervention_a->'intervention'->>'outcome_state' <> 'unknown'
     OR intervention_a->'intervention'->>'outcome_healthy' <> 'false'
     OR (intervention_a->'intervention'->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'client-health opening returned false success';
  END IF;

  BEGIN
    PERFORM public.client_health_intervention_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_intervention_id => '83211111-1111-4111-8111-111111111111',
      p_action => 'accept_assignment',
      p_expected_revision => 0,
      p_idempotency_key => 'client-health:stale',
      p_request_fingerprint => repeat('5', 64),
      p_actor_type => 'human',
      p_actor_id => '77777777-1111-4111-8111-111111111111',
      p_authority_tier => 'client_success',
      p_evidence => jsonb_build_object(
        'source_type', 'assignment_acceptance',
        'source_id', 'synthetic-stale',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected stale client-health revision denial';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'client_health_revision_conflict' THEN
      RAISE;
    END IF;
  END;

  BEGIN
    PERFORM public.client_health_intervention_command_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_intervention_id => '83211111-1111-4111-8111-111111111111',
      p_action => 'record_outcome',
      p_expected_revision => 1,
      p_idempotency_key => 'client-health:premature-outcome',
      p_request_fingerprint => repeat('6', 64),
      p_actor_type => 'service',
      p_actor_id => 'client-health-shadow-worker',
      p_authority_tier => 'client_success',
      p_evidence => jsonb_build_object(
        'source_type', 'client_outcome_receipt',
        'source_id', 'synthetic-premature',
        'observed_at', now()
      ),
      p_expected_control_revision => 0,
      p_feature_gate_enabled => true,
      p_outcome_state => 'improved'
    );
    RAISE EXCEPTION 'expected outcome without completion denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'client_health_outcome_evidence_required' THEN
      RAISE;
    END IF;
  END;

  PERFORM public.client_health_intervention_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
    p_intervention_id => '83211111-1111-4111-8111-111111111111',
    p_action => 'accept_assignment',
    p_expected_revision => 1,
    p_idempotency_key => 'client-health:accept:a',
    p_request_fingerprint => repeat('7', 64),
    p_actor_type => 'human',
    p_actor_id => '77777777-1111-4111-8111-111111111111',
    p_authority_tier => 'client_success',
    p_evidence => jsonb_build_object(
      'source_type', 'assignment_acceptance',
      'source_id', 'synthetic-accept-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );

  PERFORM public.client_health_intervention_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
    p_intervention_id => '83211111-1111-4111-8111-111111111111',
    p_action => 'complete_action',
    p_expected_revision => 2,
    p_idempotency_key => 'client-health:complete:a',
    p_request_fingerprint => repeat('8', 64),
    p_actor_type => 'human',
    p_actor_id => '77777777-1111-4111-8111-111111111111',
    p_authority_tier => 'client_success',
    p_evidence => jsonb_build_object(
      'source_type', 'intervention_completion_receipt',
      'source_id', 'synthetic-complete-a',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.client_health_interventions intervention
     WHERE intervention.id = '83211111-1111-4111-8111-111111111111'
       AND intervention.tenant_id = '11111111-1111-4111-8111-111111111111'
       AND intervention.lifecycle_state = 'action_completed'
       AND intervention.outcome_state = 'unproven'
       AND intervention.outcome_verified = false
       AND intervention.outcome_healthy = false
  ) THEN
    RAISE EXCEPTION 'completed action appeared outcome-healthy without evidence';
  END IF;

  final_a := public.client_health_intervention_command_rpc(
    p_tenant_id => '11111111-1111-4111-8111-111111111111',
    p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
    p_intervention_id => '83211111-1111-4111-8111-111111111111',
    p_action => 'record_outcome',
    p_expected_revision => 3,
    p_idempotency_key => 'client-health:outcome:a',
    p_request_fingerprint => repeat('9', 64),
    p_actor_type => 'service',
    p_actor_id => 'client-health-shadow-worker',
    p_authority_tier => 'client_success',
    p_evidence => jsonb_build_object(
      'source_type', 'client_outcome_receipt',
      'source_id', 'synthetic-verified-activation',
      'observed_at', now()
    ),
    p_expected_control_revision => 0,
    p_feature_gate_enabled => true,
    p_outcome_state => 'improved'
  );
  IF final_a->'intervention'->>'lifecycle_state' <> 'outcome_recorded'
     OR final_a->'intervention'->>'outcome_state' <> 'improved'
     OR final_a->'intervention'->>'outcome_verified' <> 'true'
     OR final_a->'intervention'->>'outcome_healthy' <> 'true' THEN
    RAISE EXCEPTION 'verified outcome did not reconcile';
  END IF;
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
  visible_own integer;
  visible_other integer;
BEGIN
  SELECT count(*) INTO visible_own
    FROM public.client_health_interventions intervention
   WHERE intervention.tenant_id = '11111111-1111-4111-8111-111111111111';
  SELECT count(*) INTO visible_other
    FROM public.client_health_interventions intervention
   WHERE intervention.tenant_id = '22222222-2222-4222-8222-222222222222';
  IF visible_own <> 1 OR visible_other <> 0 THEN
    RAISE EXCEPTION 'expected exact-tenant client-health RLS visibility';
  END IF;
END $$;
ROLLBACK;

DO $$
BEGIN
  BEGIN
    UPDATE public.client_health_intervention_events
       SET evidence = '{"tampered":true}'::jsonb
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
       AND intervention_id = '83211111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable client-health evidence denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM <> 'client_health_evidence_is_immutable' THEN
      RAISE;
    END IF;
  END;
END $$;

BEGIN;
UPDATE public.client_health_automation_controls
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
    PERFORM public.client_health_signal_snapshot_rpc(
      p_tenant_id => '11111111-1111-4111-8111-111111111111',
      p_customer_id => 'cccccccc-1111-4111-8111-111111111111',
      p_snapshot_id => '83811111-1111-4111-8111-111111111111',
      p_signal_state => 'at_risk',
      p_provenance_type => 'observed',
      p_dimensions => '{"engagement":{"state":"at_risk"}}'::jsonb,
      p_evidence => jsonb_build_object(
        'source_type', 'observed_signal',
        'source_id', 'synthetic-kill-switch',
        'observed_at', now()
      ),
      p_idempotency_key => 'client-health:killed',
      p_request_fingerprint => repeat('f', 64),
      p_actor_type => 'system',
      p_actor_id => NULL,
      p_authority_tier => 'system',
      p_expected_control_revision => 1,
      p_feature_gate_enabled => true
    );
    RAISE EXCEPTION 'expected engaged client-health kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT IN (
      'client_health_tenant_not_enabled',
      'client_health_kill_switch_engaged'
    ) THEN
      RAISE;
    END IF;
  END;
END $$;
ROLLBACK;
