\set ON_ERROR_STOP on

DO $$
DECLARE event_id uuid;
BEGIN
  INSERT INTO public.growth_events (
    tenant_id, lead_id, event_type, stage, source_system, idempotency_key, evidence
  ) VALUES (
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'qualified', 'qualified', 'test', 'same-tenant-event', '{"verified":true}'
  ) RETURNING id INTO event_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.growth_stage_state
    WHERE tenant_id = '11111111-1111-4111-8111-111111111111'
      AND lead_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND last_event_id = event_id
  ) THEN
    RAISE EXCEPTION 'same-tenant event did not project';
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.growth_events (
      tenant_id, lead_id, event_type, source_system, idempotency_key
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cross_tenant_attempt', 'test', 'cross-tenant-event'
    );
    RAISE EXCEPTION 'cross-tenant growth event was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

DO $$
DECLARE batch_id uuid;
BEGIN
  INSERT INTO public.growth_restart_batches (
    tenant_id, policy_version, sequence_plan_key
  ) VALUES (
    '11111111-1111-4111-8111-111111111111', 'test', 'test'
  ) RETURNING id INTO batch_id;
  BEGIN
    INSERT INTO public.growth_restart_candidates (
      batch_id, tenant_id, lead_id, decision, reason
    ) VALUES (
      batch_id,
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'excluded', 'tenant-test'
    );
    RAISE EXCEPTION 'cross-tenant restart candidate was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

DO $$
BEGIN
  BEGIN
    UPDATE public.growth_events
    SET event_type = 'tampered'
    WHERE idempotency_key = 'same-tenant-event';
    RAISE EXCEPTION 'append-only event mutation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'growth_restart_candidates'
      AND policyname = 'tenant_read_growth_restart_candidates'
      AND cmd = 'SELECT'
  ) THEN RAISE EXCEPTION 'tenant read policy missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'growth_restart_candidates'
      AND policyname = 'service_write_growth_restart_candidates'
      AND cmd = 'ALL'
      AND with_check LIKE '%service_role%'
  ) THEN RAISE EXCEPTION 'service-only write policy missing'; END IF;
END $$;

