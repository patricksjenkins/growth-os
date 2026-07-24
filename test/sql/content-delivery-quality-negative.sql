\set ON_ERROR_STOP on

-- Migration 082 runtime proof. Synthetic identifiers only. Run after the
-- autonomous bootstrap and migrations through 082.
INSERT INTO public.tenants (id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-1111-4111-8111-111111111111',
    'owner'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'bbbbbbbb-2222-4222-8222-222222222222',
    'owner'
  )
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role;
INSERT INTO public.content_drafts (id, tenant_id, status) VALUES
  (
    'cccccccc-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'approved'
  ),
  (
    'dddddddd-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'approved'
  )
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.work_items (
  id, tenant_id, kind, department, title, status, priority, authority_tier,
  assignee_type, source_type, source_id, idempotency_key, action_protocol,
  acceptance_criteria, created_by_type
) VALUES
  (
    'eeeeeeee-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'action', 'marketing', 'Synthetic delivery exception', 'open', 'high',
    'owner', 'unassigned', 'content_delivery', 'synthetic-a',
    'content-work:synthetic:a', '{}'::jsonb, '{}'::jsonb, 'system'
  ),
  (
    'ffffffff-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'action', 'marketing', 'Synthetic delivery exception', 'open', 'high',
    'owner', 'unassigned', 'content_delivery', 'synthetic-b',
    'content-work:synthetic:b', '{}'::jsonb, '{}'::jsonb, 'system'
  )
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.content_delivery_automation_controls (
  tenant_id, enabled, execution_mode, kill_switch_engaged,
  provider_dispatch_enabled, activated_by, activation_evidence
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true, 'shadow', false, false,
    'aaaaaaaa-1111-4111-8111-111111111111',
    '{"source":"synthetic_test"}'::jsonb
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    true, 'shadow', false, false,
    'bbbbbbbb-2222-4222-8222-222222222222',
    '{"source":"synthetic_test"}'::jsonb
  )
ON CONFLICT (tenant_id) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  execution_mode = EXCLUDED.execution_mode,
  kill_switch_engaged = EXCLUDED.kill_switch_engaged,
  activated_by = EXCLUDED.activated_by,
  activation_evidence = EXCLUDED.activation_evidence;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.content_artifact_version_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      'cccccccc-1111-4111-8111-111111111111',
      1, 'linkedin_carousel', repeat('a', 64), repeat('b', 64),
      '2026-07-24T12:00:00Z', 'content-shadow-worker',
      'content:authenticated:denied', repeat('c', 64), true
    );
    RAISE EXCEPTION 'expected authenticated content delivery RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.content_delivery_kill_switch_rpc(
      '11111111-1111-4111-8111-111111111111',
      'unauthorized_containment'
    );
    RAISE EXCEPTION 'expected authenticated content delivery kill-switch denial';
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
    INSERT INTO public.content_artifact_versions (
      tenant_id, content_draft_id, version, content_type, artifact_digest,
      evidence_digest, evidence_observed_at, actor_id, idempotency_key,
      request_fingerprint
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'cccccccc-1111-4111-8111-111111111111',
      1, 'linkedin_carousel', repeat('a', 64), repeat('b', 64),
      '2026-07-24T12:00:00Z', 'content-shadow-worker',
      'content:direct:denied', repeat('c', 64)
    );
    RAISE EXCEPTION 'expected direct service-role content evidence write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.content_artifact_version_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      'cccccccc-1111-4111-8111-111111111111',
      1, 'linkedin_carousel', repeat('a', 64), repeat('b', 64),
      '2026-07-24T12:00:00Z', 'content-shadow-worker',
      'content:disabled:denied', repeat('c', 64), false
    );
    RAISE EXCEPTION 'expected disabled content delivery write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.content_artifact_version_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      'dddddddd-2222-4222-8222-222222222222',
      1, 'linkedin_carousel', repeat('a', 64), repeat('b', 64),
      '2026-07-24T12:00:00Z', 'content-shadow-worker',
      'content:cross-tenant:draft', repeat('c', 64), true
    );
    RAISE EXCEPTION 'expected cross-tenant content draft denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  version_a_result jsonb;
  version_a_replay jsonb;
  version_b_result jsonb;
  rubric_result jsonb;
  calibration_result jsonb;
  evaluation_result jsonb;
  receipt_result jsonb;
  receipt_replay jsonb;
  kill_result jsonb;
  version_a uuid;
  version_b uuid;
  rubric_a uuid;
  calibration_a uuid;
  evaluation_a uuid;
BEGIN
  version_a_result := public.content_artifact_version_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-1111-4111-8111-111111111111',
    1, 'linkedin_carousel', repeat('a', 64), repeat('b', 64),
    '2026-07-24T12:00:00Z', 'content-shadow-worker',
    'content:version:a:1', repeat('1', 64), true
  );
  version_a := (version_a_result->'content_version'->>'id')::uuid;
  version_a_replay := public.content_artifact_version_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-1111-4111-8111-111111111111',
    1, 'linkedin_carousel', repeat('a', 64), repeat('b', 64),
    '2026-07-24T12:00:00Z', 'content-shadow-worker',
    'content:version:a:1', repeat('1', 64), true
  );
  IF version_a_replay->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact artifact version replay';
  END IF;

  version_b_result := public.content_artifact_version_register_rpc(
    '22222222-2222-4222-8222-222222222222',
    'dddddddd-2222-4222-8222-222222222222',
    1, 'linkedin_carousel', repeat('c', 64), repeat('d', 64),
    '2026-07-24T12:00:00Z', 'content-shadow-worker',
    'content:version:b:1', repeat('2', 64), true
  );
  version_b := (version_b_result->'content_version'->>'id')::uuid;

  rubric_result := public.content_quality_rubric_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    'linkedin_final', 1, 80,
    '{"brand_accuracy":{"weight":50},"usefulness":{"weight":50}}'::jsonb,
    repeat('e', 64), repeat('f', 64), '2026-07-24T12:01:00Z',
    'content-quality-worker', 'content:rubric:a:1', repeat('3', 64), true
  );
  rubric_a := (rubric_result->'rubric'->>'id')::uuid;

  calibration_result := public.content_quality_calibration_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    rubric_a, 25, 9200, repeat('1', 64), repeat('2', 64),
    repeat('3', 64), '2026-07-24T12:02:00Z',
    'content-quality-worker', 'content:calibration:a:1', repeat('4', 64), true
  );
  calibration_a := (calibration_result->'calibration'->>'id')::uuid;

  evaluation_result := public.content_quality_evaluation_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    version_a, rubric_a, calibration_a, 91,
    '{"brand_accuracy":94,"usefulness":88}'::jsonb, 'accepted',
    repeat('5', 64), '2026-07-24T12:03:00Z',
    'content-quality-worker', 'content:evaluation:a:1', repeat('6', 64), true
  );
  evaluation_a := (evaluation_result->'evaluation'->>'id')::uuid;

  BEGIN
    PERFORM public.content_delivery_receipt_record_rpc(
      '11111111-1111-4111-8111-111111111111',
      version_a, NULL, NULL, 'buffer', 'account_shadow_01',
      'delivery_false_green', 'linkedin_org_shadow_01', 1,
      'completed', 'no_op', 'accepted', 'delivered', 'achieved',
      'not_applicable', NULL, repeat('7', 64), repeat('8', 64),
      '2026-07-24T12:04:00Z', 'content-shadow-worker',
      'content:receipt:false-green', repeat('9', 64), true
    );
    RAISE EXCEPTION 'expected false-green no-op receipt denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.content_delivery_receipt_record_rpc(
      '11111111-1111-4111-8111-111111111111',
      version_a, NULL, 'ffffffff-2222-4222-8222-222222222222',
      'buffer', 'account_shadow_01', 'delivery_failed_cross_work',
      'linkedin_org_shadow_01', 1, 'failed', 'produced', 'unverified',
      'failed', 'unverified', 'exhausted', NULL, NULL, repeat('a', 64),
      '2026-07-24T12:05:00Z', 'content-shadow-worker',
      'content:receipt:cross-work', repeat('b', 64), true
    );
    RAISE EXCEPTION 'expected owner-work tenant mismatch denial';
  EXCEPTION WHEN foreign_key_violation OR check_violation THEN NULL;
  END;

  receipt_result := public.content_delivery_receipt_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    version_a, evaluation_a, NULL, 'buffer', 'account_shadow_01',
    'delivery_shared_01', 'linkedin_org_shadow_01', 1,
    'completed', 'produced', 'accepted', 'delivered', 'unverified',
    'not_applicable', NULL, NULL, repeat('c', 64),
    '2026-07-24T12:06:00Z', 'content-shadow-worker',
    'content:receipt:a:1', repeat('d', 64), true
  );
  IF receipt_result->>'outcome' <> 'recorded' THEN
    RAISE EXCEPTION 'expected recorded content delivery receipt';
  END IF;
  receipt_replay := public.content_delivery_receipt_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    version_a, evaluation_a, NULL, 'buffer', 'account_shadow_01',
    'delivery_shared_01', 'linkedin_org_shadow_01', 1,
    'completed', 'produced', 'accepted', 'delivered', 'unverified',
    'not_applicable', NULL, NULL, repeat('c', 64),
    '2026-07-24T12:06:00Z', 'content-shadow-worker',
    'content:receipt:a:1', repeat('d', 64), true
  );
  IF receipt_replay->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact content delivery replay';
  END IF;

  BEGIN
    PERFORM public.content_delivery_receipt_record_rpc(
      '22222222-2222-4222-8222-222222222222',
      version_b, NULL, NULL, 'buffer', 'account_shadow_01',
      'delivery_shared_01', 'linkedin_org_shadow_02', 1,
      'completed', 'produced', 'unverified', 'accepted', 'unverified',
      'none', NULL, NULL, repeat('e', 64), '2026-07-24T12:07:00Z',
      'content-shadow-worker', 'content:receipt:b:rebind',
      repeat('f', 64), true
    );
    RAISE EXCEPTION 'expected provider delivery identity rebind denial';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  kill_result := public.content_delivery_kill_switch_rpc(
    '11111111-1111-4111-8111-111111111111',
    'synthetic_containment'
  );
  IF kill_result->>'outcome' <> 'kill_switch_engaged'
     OR kill_result->>'tenant_id' <>
        '11111111-1111-4111-8111-111111111111'
     OR (kill_result->>'revision')::bigint <> 1 THEN
    RAISE EXCEPTION 'content delivery kill switch returned invalid containment result';
  END IF;
  IF kill_result::text LIKE '%synthetic_containment%'
     OR kill_result - 'outcome' - 'tenant_id' - 'revision' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'content delivery kill-switch leaked supplied reason';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.content_delivery_automation_controls
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
       AND enabled = false
       AND execution_mode = 'disabled'
       AND kill_switch_engaged = true
       AND revision = 1
  ) THEN
    RAISE EXCEPTION 'content delivery kill switch did not atomically contain tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.content_delivery_automation_controls
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
       AND enabled = true
       AND execution_mode = 'shadow'
       AND kill_switch_engaged = false
       AND revision = 0
  ) THEN
    RAISE EXCEPTION 'content delivery kill switch changed another tenant';
  END IF;
  BEGIN
    PERFORM public.content_artifact_version_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      'cccccccc-1111-4111-8111-111111111111',
      2, 'linkedin_carousel', repeat('1', 64), repeat('2', 64),
      '2026-07-24T12:08:00Z', 'content-shadow-worker',
      'content:version:a:killed', repeat('3', 64), true
    );
    RAISE EXCEPTION 'expected engaged content delivery kill switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
COMMIT;

BEGIN;
DO $$
BEGIN
  BEGIN
    UPDATE public.content_delivery_automation_controls
       SET kill_switch_engaged = false
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected one-way content delivery kill-switch denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1
      FROM public.content_delivery_automation_controls
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
       AND enabled = false
       AND execution_mode = 'disabled'
       AND kill_switch_engaged = true
       AND revision = 1
  ) THEN
    RAISE EXCEPTION 'one-way content delivery kill-switch denial changed control';
  END IF;
END $$;
ROLLBACK;

BEGIN;
DO $$
BEGIN
  BEGIN
    UPDATE public.content_delivery_receipts
       SET destination_ref = 'mutated'
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable content delivery mutation denial';
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
    SELECT 1 FROM public.content_artifact_versions
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'authenticated content delivery RLS tenant isolation failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.content_delivery_receipts
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'authenticated tenant could not read own content delivery receipt';
  END IF;
END $$;
ROLLBACK;
