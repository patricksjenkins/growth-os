\set ON_ERROR_STOP on

-- Migration 079 runtime proof. This file uses synthetic identifiers only and
-- must run after autonomous-os-bootstrap.sql and migration 079.
INSERT INTO public.tenants (id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.customers (id, tenant_id) VALUES
  ('cccccccc-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('dddddddd-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222')
ON CONFLICT (id) DO NOTHING;

BEGIN;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.billing_identity_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      'tenant', NULL, 'stripe', 'acct_shadow',
      'tenant', 'tenant_shadow_a', 'verified_webhook',
      'evt_identity_unauthorized', repeat('a', 64),
      '2026-07-24T12:00:00Z', 'system', NULL,
      'identity:unauthorized', repeat('b', 64), true
    );
    RAISE EXCEPTION 'expected authenticated billing identity RPC denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM count(*) FROM public.billing_identity_mappings;
    RAISE EXCEPTION 'expected authenticated billing identity read denial';
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
    INSERT INTO public.billing_identity_mappings (
      tenant_id, scope_type, provider, provider_account_ref,
      provider_object_type, provider_object_ref, evidence_type, evidence_id,
      evidence_digest, evidence_observed_at, actor_type, idempotency_key,
      request_fingerprint
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', 'tenant',
      'stripe', 'acct_shadow', 'tenant', 'tenant_direct_denied',
      'verified_webhook', 'evt_direct_denied', repeat('a', 64),
      '2026-07-24T12:00:00Z', 'system', 'identity:direct-denied',
      repeat('b', 64)
    );
    RAISE EXCEPTION 'expected direct service-role billing identity write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.billing_identity_register_rpc(
      '11111111-1111-4111-8111-111111111111',
      'tenant', NULL, 'stripe', 'acct_shadow',
      'tenant', 'tenant_shadow_a', 'verified_webhook',
      'evt_identity_disabled', repeat('a', 64),
      '2026-07-24T12:00:00Z', 'system', NULL,
      'identity:disabled', repeat('b', 64), false
    );
    RAISE EXCEPTION 'expected disabled billing identity write denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role', 'service_role', true);
DO $$
DECLARE
  tenant_a_result jsonb;
  customer_a_result jsonb;
  tenant_b_result jsonb;
  customer_b_result jsonb;
  attribution_result jsonb;
  replay_result jsonb;
  tenant_a_mapping uuid;
  customer_a_mapping uuid;
  tenant_b_mapping uuid;
  customer_b_mapping uuid;
BEGIN
  tenant_a_result := public.billing_identity_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    'tenant', NULL, 'stripe', 'acct_shadow',
    'tenant', 'tenant_shadow_a', 'verified_webhook',
    'evt_tenant_a', repeat('a', 64), '2026-07-24T12:00:00Z',
    'system', NULL, 'identity:tenant:a', repeat('1', 64), true
  );
  tenant_a_mapping := (tenant_a_result->'mapping'->>'id')::uuid;

  customer_a_result := public.billing_identity_register_rpc(
    '11111111-1111-4111-8111-111111111111',
    'customer', 'cccccccc-1111-4111-8111-111111111111',
    'stripe', 'acct_shadow', 'customer', 'cus_shadow_a',
    'verified_webhook', 'evt_customer_a', repeat('b', 64),
    '2026-07-24T12:01:00Z', 'system', NULL,
    'identity:customer:a', repeat('2', 64), true
  );
  customer_a_mapping := (customer_a_result->'mapping'->>'id')::uuid;

  BEGIN
    PERFORM public.billing_identity_register_rpc(
      '22222222-2222-4222-8222-222222222222',
      'customer', 'cccccccc-1111-4111-8111-111111111111',
      'stripe', 'acct_shadow', 'customer', 'cus_cross_tenant',
      'verified_webhook', 'evt_customer_cross', repeat('c', 64),
      '2026-07-24T12:02:00Z', 'system', NULL,
      'identity:customer:cross', repeat('3', 64), true
    );
    RAISE EXCEPTION 'expected cross-tenant customer identity denial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.billing_identity_register_rpc(
      '22222222-2222-4222-8222-222222222222',
      'tenant', NULL, 'stripe', 'acct_shadow',
      'tenant', 'tenant_shadow_a', 'verified_webhook',
      'evt_tenant_rebind', repeat('d', 64),
      '2026-07-24T12:03:00Z', 'system', NULL,
      'identity:tenant:rebind', repeat('4', 64), true
    );
    RAISE EXCEPTION 'expected provider tenant identity rebind denial';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  tenant_b_result := public.billing_identity_register_rpc(
    '22222222-2222-4222-8222-222222222222',
    'tenant', NULL, 'stripe', 'acct_shadow',
    'tenant', 'tenant_shadow_b', 'verified_webhook',
    'evt_tenant_b', repeat('e', 64), '2026-07-24T12:04:00Z',
    'system', NULL, 'identity:tenant:b', repeat('5', 64), true
  );
  tenant_b_mapping := (tenant_b_result->'mapping'->>'id')::uuid;

  customer_b_result := public.billing_identity_register_rpc(
    '22222222-2222-4222-8222-222222222222',
    'customer', 'dddddddd-2222-4222-8222-222222222222',
    'stripe', 'acct_shadow', 'customer', 'cus_shadow_b',
    'verified_webhook', 'evt_customer_b', repeat('f', 64),
    '2026-07-24T12:05:00Z', 'system', NULL,
    'identity:customer:b', repeat('6', 64), true
  );
  customer_b_mapping := (customer_b_result->'mapping'->>'id')::uuid;

  attribution_result := public.finance_attribution_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-1111-4111-8111-111111111111',
    tenant_a_mapping, customer_a_mapping, 'stripe', 'acct_shadow',
    'invoice_paid', 'evt_paid_shared', '2026-07-24', 'USD',
    12000, 2500, 'matched', 12000, 2500, repeat('7', 64),
    '2026-07-24T12:06:00Z', 'system', NULL,
    'attribution:tenant:a', repeat('8', 64), true
  );
  IF attribution_result->>'outcome' <> 'recorded'
     OR (attribution_result->'attribution'->>'margin_minor')::bigint <> 9500 THEN
    RAISE EXCEPTION 'expected exact tenant A attribution and margin';
  END IF;

  replay_result := public.finance_attribution_record_rpc(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-1111-4111-8111-111111111111',
    tenant_a_mapping, customer_a_mapping, 'stripe', 'acct_shadow',
    'invoice_paid', 'evt_paid_shared', '2026-07-24', 'USD',
    12000, 2500, 'matched', 12000, 2500, repeat('7', 64),
    '2026-07-24T12:06:00Z', 'system', NULL,
    'attribution:tenant:a', repeat('8', 64), true
  );
  IF replay_result->>'outcome' <> 'replay' THEN
    RAISE EXCEPTION 'expected exact attribution replay';
  END IF;

  BEGIN
    PERFORM public.finance_attribution_record_rpc(
      '22222222-2222-4222-8222-222222222222',
      'dddddddd-2222-4222-8222-222222222222',
      tenant_b_mapping, customer_b_mapping, 'stripe', 'acct_shadow',
      'invoice_paid', 'evt_paid_shared', '2026-07-24', 'USD',
      12000, 2500, 'matched', 12000, 2500, repeat('7', 64),
      '2026-07-24T12:06:00Z', 'system', NULL,
      'attribution:tenant:b', repeat('9', 64), true
    );
    RAISE EXCEPTION 'expected cross-tenant source event denial';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  IF EXISTS (
    SELECT 1
      FROM public.finance_attribution_records
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'cross-tenant attempt created tenant B attribution';
  END IF;
END $$;
COMMIT;

BEGIN;
SET LOCAL ROLE service_role;
DO $$
BEGIN
  BEGIN
    UPDATE public.finance_attribution_records
       SET revenue_minor = revenue_minor + 1;
    RAISE EXCEPTION 'expected direct service-role attribution mutation denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
ROLLBACK;

BEGIN;
DO $$
BEGIN
  BEGIN
    UPDATE public.finance_attribution_records
       SET revenue_minor = revenue_minor + 1
     WHERE tenant_id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'expected immutable attribution mutation denial';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END $$;
ROLLBACK;
