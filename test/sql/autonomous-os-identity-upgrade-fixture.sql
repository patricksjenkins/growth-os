\set ON_ERROR_STOP on

-- Seed a shape that migration 075 must preserve: a previously accepted agent
-- assignment and legacy entity type. The hardening may reject new instances,
-- but must not freeze unrelated updates to an existing row.
INSERT INTO public.tenants (id)
VALUES ('11111111-1111-4111-8111-111111111111')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.work_items (
  id,
  tenant_id,
  kind,
  department,
  title,
  status,
  assignee_type,
  assignee_id,
  source_type,
  source_id,
  entity_type,
  entity_id,
  idempotency_key
) VALUES (
  '90000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'task',
  'reliability',
  'Legacy assigned work',
  'claimed',
  'agent',
  'legacy-agent',
  'legacy',
  'legacy-source',
  'legacy_record',
  'legacy-id',
  'fixture:legacy-assignment'
);
