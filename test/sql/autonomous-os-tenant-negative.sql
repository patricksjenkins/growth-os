\set ON_ERROR_STOP on

INSERT INTO public.tenants (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

INSERT INTO public.attention_queue (id, tenant_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.leads (id, tenant_id) VALUES
  ('aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.customers (id, tenant_id) VALUES
  ('cccccccc-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('dddddddd-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.tenant_users (tenant_id, user_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'eeeeeeee-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222', 'ffffffff-2222-4222-8222-222222222222');

INSERT INTO public.work_items (
  id, tenant_id, kind, department, title, source_type, source_id, idempotency_key
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'decision', 'executive', 'Tenant A decision', 'fixture', 'decision-a', 'fixture:decision:a'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.work_items (
      tenant_id, kind, department, title, source_type, source_id,
      idempotency_key, attention_queue_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'decision', 'executive', 'Invalid attention link', 'fixture',
      'invalid-attention', 'fixture:invalid:attention',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    RAISE EXCEPTION 'expected cross-tenant attention link to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant attention link to fail' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.work_item_events (
      tenant_id, work_item_id, event_type, actor_type, authority_tier,
      idempotency_key, request_fingerprint
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',
      '10000000-0000-4000-8000-000000000001',
      'created', 'system', 'system', 'fixture:event:cross-tenant',
      repeat('a', 64)
    );
    RAISE EXCEPTION 'expected cross-tenant work event to fail';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;
END $$;

INSERT INTO public.documents (
  id, tenant_id, title, document_type
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'Tenant A procedure', 'procedure'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.document_versions (
      tenant_id, document_id, version_number, storage_path,
      original_filename, mime_type, byte_size, sha256
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',
      '20000000-0000-4000-8000-000000000001',
      1,
      '22222222-2222-4222-8222-222222222222/20000000-0000-4000-8000-000000000001/1/a.pdf',
      'a.pdf', 'application/pdf', 1, repeat('a', 64)
    );
    RAISE EXCEPTION 'expected cross-tenant document version to fail';
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.document_versions (
      tenant_id, document_id, version_number, storage_path,
      original_filename, mime_type, byte_size, sha256
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      '20000000-0000-4000-8000-000000000001',
      1,
      '22222222-2222-4222-8222-222222222222/20000000-0000-4000-8000-000000000001/1/a.pdf',
      'a.pdf', 'application/pdf', 1, repeat('a', 64)
    );
    RAISE EXCEPTION 'expected mismatched storage path to fail';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO public.scheduling_policies (
  id, tenant_id, timezone, provider
) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'America/New_York', 'shadow'
);

INSERT INTO public.appointment_workflows (
  id, tenant_id, policy_id, lead_id, customer_id, owner_user_id,
  appointment_type, idempotency_key
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '30000000-0000-4000-8000-000000000001',
  'aaaaaaaa-1111-4111-8111-111111111111',
  'cccccccc-1111-4111-8111-111111111111',
  'eeeeeeee-1111-4111-8111-111111111111',
  'sales-demo', 'fixture:appointment:a'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.appointment_workflows (
      tenant_id, lead_id, appointment_type, idempotency_key
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-2222-4222-8222-222222222222',
      'sales-demo', 'fixture:appointment:cross-tenant'
    );
    RAISE EXCEPTION 'expected cross-tenant appointment lead to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant appointment lead to fail' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.appointment_events (
      tenant_id, appointment_id, event_type, idempotency_key
    ) VALUES (
      '22222222-2222-4222-8222-222222222222',
      '40000000-0000-4000-8000-000000000001',
      'created', 'fixture:appointment:event:cross'
    );
    RAISE EXCEPTION 'expected cross-tenant appointment event to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant appointment event to fail' THEN RAISE; END IF;
  END;

  BEGIN
    INSERT INTO public.referral_credits (
      tenant_id, referrer_lead_id, referee_lead_id
    ) VALUES (
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-2222-4222-8222-222222222222',
      'aaaaaaaa-1111-4111-8111-111111111111'
    );
    RAISE EXCEPTION 'expected cross-tenant referral to fail';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'expected cross-tenant referral to fail' THEN RAISE; END IF;
  END;
END $$;

GRANT SELECT ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log,
  public.documents,
  public.document_versions,
  public.document_chunks,
  public.document_links,
  public.document_events,
  public.scheduling_policies,
  public.appointment_workflows,
  public.appointment_events
TO authenticated;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"owner"}}',
  true
);
DO $$
DECLARE visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.work_items;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'tenant A owner expected 1 visible work item, got %', visible_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.work_items
     WHERE tenant_id = '22222222-2222-4222-8222-222222222222'
  ) THEN
    RAISE EXCEPTION 'tenant A owner can see tenant B work';
  END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"app_metadata":{"tenant_id":"11111111-1111-4111-8111-111111111111","role":"member"}}',
  true
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.work_items) THEN
    RAISE EXCEPTION 'unauthorized tenant member can see executive work';
  END IF;
END $$;
ROLLBACK;
