\set ON_ERROR_STOP on

-- Migration 081 runtime proof. Run after autonomous-os-tenant-negative.sql and
-- billing-attribution-negative.sql. All identifiers and evidence are synthetic.

INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES (
  '11111111-1111-4111-8111-111111111111',
  '88888888-1111-4111-8111-111111111111',
  'admin'
);

INSERT INTO public.finance_close_automation_controls (
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
    PERFORM public.finance_close_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD', 'begin_close', 0,
      'finance-close:authenticated-denied', repeat('a', 64),
      'system', NULL, 'system',
      jsonb_build_object(
        'source_type', 'period_open_attestation',
        'source_id', 'synthetic-auth-denied',
        'observed_at', now()
      ),
      true
    );
    RAISE EXCEPTION 'expected authenticated finance-close RPC denial';
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
    INSERT INTO public.finance_close_cycles (
      id, tenant_id, period_start, currency
    ) VALUES (
      '81111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD'
    );
    RAISE EXCEPTION 'expected direct service-role finance-close write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.finance_close_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD', 'begin_close', 0,
      'finance-close:disabled', repeat('b', 64),
      'system', NULL, 'system',
      jsonb_build_object(
        'source_type', 'period_open_attestation',
        'source_id', 'synthetic-disabled',
        'observed_at', now()
      ),
      false
    );
    RAISE EXCEPTION 'expected disabled finance-close write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  tenant_a_record_id uuid;
  begin_a jsonb;
  replay_a jsonb;
  task_id uuid;
  final_result jsonb;
  legacy_lock_present boolean := false;
BEGIN
  SELECT attribution.id INTO STRICT tenant_a_record_id
    FROM public.finance_attribution_records attribution
   WHERE attribution.tenant_id = '11111111-1111-4111-8111-111111111111'
     AND attribution.source_event_type = 'invoice_paid'
     AND attribution.source_event_id = 'evt_paid_shared';

  begin_a := public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'begin_close', 0,
    'finance-close:begin:a', repeat('1', 64),
    'system', NULL, 'system',
    jsonb_build_object(
      'source_type', 'period_open_attestation',
      'source_id', 'synthetic-period-a',
      'observed_at', now()
    ),
    true
  );
  IF begin_a->>'outcome' <> 'applied'
     OR begin_a->'cycle'->>'close_state' <> 'reconciling'
     OR (begin_a->'cycle'->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'finance-close begin returned false success';
  END IF;

  replay_a := public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'begin_close', 0,
    'finance-close:begin:a', repeat('1', 64),
    'system', NULL, 'system',
    begin_a->'event'->'evidence',
    true
  );
  IF replay_a->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact finance-close replay';
  END IF;

  PERFORM public.finance_close_command_rpc(
    '22222222-2222-4222-8222-222222222222',
    '82222222-2222-4222-8222-222222222222',
    '2026-07-01', 'USD', 'begin_close', 0,
    'finance-close:begin:b', repeat('2', 64),
    'system', NULL, 'system',
    jsonb_build_object(
      'source_type', 'period_open_attestation',
      'source_id', 'synthetic-period-b',
      'observed_at', now()
    ),
    true
  );

  BEGIN
    PERFORM public.finance_close_command_rpc(
      '22222222-2222-4222-8222-222222222222',
      '82222222-2222-4222-8222-222222222222',
      '2026-07-01', 'USD', 'record_reconciliation', 1,
      'finance-close:cross-tenant-record', repeat('3', 64),
      'system', NULL, 'system',
      jsonb_build_object(
        'source_type', 'finance_attribution_manifest',
        'source_id', 'synthetic-cross-tenant-manifest',
        'observed_at', now()
      ),
      true, NULL, NULL, NULL, NULL, ARRAY[tenant_a_record_id]
    );
    RAISE EXCEPTION 'expected cross-tenant reconciliation evidence denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_close_reconciliation_prerequisites_unmet' THEN
      RAISE;
    END IF;
  END;

  PERFORM public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'raise_exception', 1,
    'finance-close:exception:a', repeat('4', 64),
    'human', 'eeeeeeee-1111-4111-8111-111111111111', 'owner',
    jsonb_build_object(
      'source_type', 'reconciliation_exception',
      'source_id', 'synthetic-bank-evidence-missing',
      'observed_at', now()
    ),
    true,
    '83333333-1111-4111-8111-111111111111',
    'bank_evidence_missing',
    'eeeeeeee-1111-4111-8111-111111111111',
    now() + interval '1 day'
  );
  SELECT task.id INTO STRICT task_id
    FROM public.finance_close_tasks task
   WHERE task.tenant_id = '11111111-1111-4111-8111-111111111111'
     AND task.finance_close_exception_id =
       '83333333-1111-4111-8111-111111111111';

  PERFORM public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'accept_task', 2,
    'finance-close:task:accept:a', repeat('5', 64),
    'human', 'eeeeeeee-1111-4111-8111-111111111111', 'owner',
    jsonb_build_object(
      'source_type', 'operator_acceptance',
      'source_id', 'synthetic-task-acceptance',
      'observed_at', now()
    ),
    true, task_id
  );

  PERFORM public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'complete_task', 3,
    'finance-close:task:complete:a', repeat('6', 64),
    'human', 'eeeeeeee-1111-4111-8111-111111111111', 'owner',
    jsonb_build_object(
      'source_type', 'task_completion_receipt',
      'source_id', 'synthetic-task-completion',
      'observed_at', now()
    ),
    true, task_id
  );

  PERFORM public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'record_reconciliation', 4,
    'finance-close:reconciliation:a', repeat('7', 64),
    'service', 'finance-close-worker', 'finance_operator',
    jsonb_build_object(
      'source_type', 'finance_attribution_manifest',
      'source_id', 'synthetic-tenant-a-manifest',
      'observed_at', now()
    ),
    true, NULL, NULL, NULL, NULL, ARRAY[tenant_a_record_id]
  );

  BEGIN
    PERFORM public.finance_close_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD', 'reviewer_approve', 4,
      'finance-close:stale-revision', repeat('8', 64),
      'human', 'eeeeeeee-1111-4111-8111-111111111111', 'owner',
      jsonb_build_object(
        'source_type', 'reviewer_decision',
        'source_id', 'synthetic-stale-review',
        'observed_at', now()
      ),
      true
    );
    RAISE EXCEPTION 'expected stale finance-close revision denial';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  PERFORM public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'reviewer_approve', 5,
    'finance-close:review:a', repeat('9', 64),
    'human', 'eeeeeeee-1111-4111-8111-111111111111', 'owner',
    jsonb_build_object(
      'source_type', 'reviewer_decision',
      'source_id', 'synthetic-review-a',
      'observed_at', now()
    ),
    true
  );

  BEGIN
    PERFORM public.finance_close_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '81111111-1111-4111-8111-111111111111',
      '2026-07-01', 'USD', 'sign_off', 6,
      'finance-close:same-person-signoff', repeat('a', 64),
      'human', 'eeeeeeee-1111-4111-8111-111111111111', 'owner',
      jsonb_build_object(
        'source_type', 'signoff_decision',
        'source_id', 'synthetic-invalid-signoff',
        'observed_at', now()
      ),
      true
    );
    RAISE EXCEPTION 'expected same-person signoff denial';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'finance_close_signoff_invalid' THEN RAISE; END IF;
  END;

  PERFORM public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'sign_off', 6,
    'finance-close:signoff:a', repeat('b', 64),
    'human', '88888888-1111-4111-8111-111111111111', 'owner',
    jsonb_build_object(
      'source_type', 'signoff_decision',
      'source_id', 'synthetic-valid-signoff',
      'observed_at', now()
    ),
    true
  );

  PERFORM public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'record_export', 7,
    'finance-close:export:a', repeat('c', 64),
    'service', 'finance-close-worker', 'finance_operator',
    jsonb_build_object(
      'source_type', 'export_artifact_receipt',
      'source_id', 'synthetic-export-receipt',
      'artifact_id', 'synthetic-export-artifact',
      'observed_at', now()
    ),
    true
  );

  final_result := public.finance_close_command_rpc(
    '11111111-1111-4111-8111-111111111111',
    '81111111-1111-4111-8111-111111111111',
    '2026-07-01', 'USD', 'record_shadow_lock', 8,
    'finance-close:shadow-lock:a', repeat('d', 64),
    'human', '88888888-1111-4111-8111-111111111111', 'owner',
    jsonb_build_object(
      'source_type', 'shadow_lock_decision',
      'source_id', 'synthetic-shadow-lock',
      'observed_at', now()
    ),
    true
  );
  IF to_regclass('public.finance_period_locks') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (
         SELECT 1
           FROM public.finance_period_locks
          WHERE tenant_id = $1
            AND year = 2026
            AND month = 7
       )'
      INTO legacy_lock_present
      USING '11111111-1111-4111-8111-111111111111'::uuid;
  END IF;
  IF final_result->'cycle'->>'close_state' <> 'shadow_locked'
     OR (final_result->'cycle'->>'production_period_lock_applied')::boolean
     OR legacy_lock_present THEN
    RAISE EXCEPTION 'shadow close falsely claimed or applied a production lock';
  END IF;

  PERFORM public.finance_close_kill_switch_rpc(
    '11111111-1111-4111-8111-111111111111',
    'synthetic test containment'
  );
  BEGIN
    PERFORM public.finance_close_command_rpc(
      '11111111-1111-4111-8111-111111111111',
      '84444444-1111-4111-8111-111111111111',
      '2026-08-01', 'USD', 'begin_close', 0,
      'finance-close:killed', repeat('e', 64),
      'system', NULL, 'system',
      jsonb_build_object(
        'source_type', 'period_open_attestation',
        'source_id', 'synthetic-killed',
        'observed_at', now()
      ),
      true
    );
    RAISE EXCEPTION 'expected engaged finance-close kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
COMMIT;

BEGIN;
DO $$
BEGIN
  BEGIN
    UPDATE public.finance_close_events
       SET evidence = jsonb_build_object('tampered', true)
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable finance-close event denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"client_owner"}}',
  true
);
DO $$
DECLARE
  visible_a integer;
  visible_b integer;
BEGIN
  SELECT count(*) INTO visible_a FROM public.finance_close_cycles;
  SELECT count(*) INTO visible_b
    FROM public.finance_close_cycles
   WHERE tenant_id = '22222222-2222-4222-8222-222222222222';
  IF visible_a <> 1 OR visible_b <> 0 THEN
    RAISE EXCEPTION 'authenticated finance-close RLS tenant isolation failed';
  END IF;
END $$;
ROLLBACK;
