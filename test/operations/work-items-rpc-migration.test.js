'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '072_work_item_atomic_rpcs.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(root, 'db', 'rollbacks', '072_work_item_atomic_rpcs_rollback.sql'),
  'utf8'
);

function normalizedTypes(signature) {
  return signature
    .split(',')
    .map((type) => type.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function signatureAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing signature marker: ${marker}`);
  const open = source.indexOf('(', start);
  const close = source.indexOf(')', open);
  return normalizedTypes(source.slice(open + 1, close));
}

test('RPC migration is additive, replay-safe, and service-role-only', () => {
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE)\s+TABLE\b/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.work_item_create_rpc/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.work_item_transition_rpc/i);
  assert.match(migration, /SECURITY DEFINER/g);
  assert.match(migration, /work_item_rpc_requires_service_role/g);
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION public\.work_item_create_rpc[\s\S]*FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION public\.work_item_transition_rpc[\s\S]*FROM PUBLIC, anon, authenticated/i
  );
  assert.match(migration, /TO service_role/g);
});

test('permission and rollback signatures match the typed RPC arity', () => {
  const createTypes = [
    'uuid',
    ...Array(17).fill('text'),
    'uuid',
    'jsonb',
    'jsonb',
    'timestamptz',
    'timestamptz',
  ];
  const transitionTypes = [
    'uuid', 'uuid', 'integer',
    ...Array(10).fill('text'),
    'jsonb',
  ];

  assert.deepEqual(
    signatureAfter(migration, 'REVOKE EXECUTE ON FUNCTION public.work_item_create_rpc'),
    createTypes
  );
  assert.deepEqual(
    signatureAfter(migration, 'REVOKE EXECUTE ON FUNCTION public.work_item_transition_rpc'),
    transitionTypes
  );
  assert.deepEqual(
    signatureAfter(rollback, 'DROP FUNCTION IF EXISTS public.work_item_create_rpc'),
    createTypes
  );
  assert.deepEqual(
    signatureAfter(rollback, 'DROP FUNCTION IF EXISTS public.work_item_transition_rpc'),
    transitionTypes
  );
});

test('create atomically binds tenant, audit actor context, item, and event', () => {
  assert.match(migration, /p_tenant_id uuid/i);
  assert.match(migration, /set_config\('app\.actor_id'[\s\S]*true\)/i);
  assert.match(migration, /set_config\('app\.actor_label'[\s\S]*true\)/i);
  assert.match(migration, /INSERT INTO public\.work_items/i);
  assert.match(migration, /INSERT INTO public\.work_item_events/i);
  assert.match(migration, /'work_item_created'/i);
  assert.doesNotMatch(migration, /^\s*(?:COMMIT|ROLLBACK)\s*;/im);
});

test('idempotency serializes retries and distinguishes replay from conflict', () => {
  assert.match(migration, /pg_advisory_xact_lock/g);
  assert.match(migration, /request_fingerprint IS DISTINCT FROM p_request_fingerprint/g);
  assert.match(migration, /'outcome', 'replay'/g);
  assert.match(migration, /work_item_idempotency_fingerprint_conflict/g);
  assert.match(migration, /work_item_idempotency_incomplete_conflict/);
});

test('transition uses tenant-bound row locking and optimistic revision', () => {
  assert.match(
    migration,
    /WHERE w\.tenant_id = p_tenant_id[\s\S]*w\.id = p_work_item_id[\s\S]*FOR UPDATE/i
  );
  assert.match(migration, /v_item\.revision IS DISTINCT FROM p_expected_revision/i);
  assert.match(
    migration,
    /WHERE id = p_work_item_id[\s\S]*tenant_id = p_tenant_id[\s\S]*revision = p_expected_revision/i
  );
  assert.match(migration, /work_item_revision_conflict/g);
});

test('typed transition whitelist enforces state, authority, and agent limits', () => {
  assert.doesNotMatch(migration, /p_(?:patch|updates|changes)\s+jsonb/i);
  assert.doesNotMatch(migration, /jsonb_populate_record|jsonb_to_record/i);
  assert.match(migration, /agent_owner_authority_forbidden/g);
  assert.match(migration, /v_actor_rank < v_required_rank/i);
  assert.match(migration, /work_item_transition_not_allowed/i);
  assert.match(migration, /assignee_fields_only_allowed_for_claim/i);
  assert.match(migration, /verification_fields_only_allowed_for_verified/i);
});

test('rollback drops only RPC functions and preserves ledger data', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.work_item_transition_rpc/i);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.work_item_create_rpc/i);
  assert.doesNotMatch(rollback, /\b(?:DROP|TRUNCATE|DELETE)\s+TABLE\b/i);
  assert.doesNotMatch(rollback, /\bDELETE\s+FROM\b/i);
});
