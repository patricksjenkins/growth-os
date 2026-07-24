'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '075_work_item_identity_hardening.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(root, 'db', 'rollbacks', '075_work_item_identity_hardening_rollback.sql'),
  'utf8'
);

test('hardening validates current human tenant membership and owner role', () => {
  assert.match(migration, /work_item_human_creator_not_current_tenant_owner/);
  assert.match(migration, /work_item_human_actor_not_current_tenant_owner/);
  assert.match(migration, /tenant_user\.tenant_id = NEW\.tenant_id/i);
  assert.match(migration, /tenant_user\.user_id = v_actor_uuid/i);
  assert.match(migration, /'client_owner', 'tenant_owner'/);
});

test('service-role mutations are forced through the atomic command RPCs', () => {
  assert.match(
    migration,
    /GRANT SELECT ON[\s\S]*public\.work_items[\s\S]*TO service_role/i
  );
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*public\.work_items[\s\S]*public\.work_item_events[\s\S]*public\.work_item_audit_log[\s\S]*FROM service_role/i
  );
});

test('human assignment and typed entities are tenant-bound', () => {
  assert.match(migration, /work_item_human_assignee_not_in_tenant/);
  assert.match(migration, /entity\.tenant_id = NEW\.tenant_id/g);
  assert.match(migration, /work_item_entity_type_not_supported/);
  assert.match(migration, /'lead', 'customer', 'attention_queue', 'ops_incident'/);
});

test('agent and service assignment fail until tenant registries exist', () => {
  assert.match(migration, /work_item_assignee_registry_not_established/);
  assert.match(migration, /work_item_agent_registry_not_established/);
});

test('unchanged legacy assignment and entity fields remain update-compatible', () => {
  assert.match(
    migration,
    /TG_OP = 'INSERT'[\s\S]*NEW\.assignee_type IS DISTINCT FROM OLD\.assignee_type[\s\S]*NEW\.assignee_id IS DISTINCT FROM OLD\.assignee_id/i
  );
  assert.match(
    migration,
    /TG_OP = 'INSERT'[\s\S]*NEW\.entity_type IS DISTINCT FROM OLD\.entity_type[\s\S]*NEW\.entity_id IS DISTINCT FROM OLD\.entity_id/i
  );
});

test('release and reopen clear stale assignment state', () => {
  assert.match(
    migration,
    /NEW\.status = 'open'[\s\S]*NEW\.assignee_type := 'unassigned'[\s\S]*NEW\.assignee_id := NULL[\s\S]*NEW\.claimed_at := NULL/i
  );
});

test('rollback removes guards without changing work data', () => {
  assert.match(rollback, /DROP TRIGGER IF EXISTS trg_work_item_events_identity_guard/i);
  assert.match(rollback, /CREATE OR REPLACE FUNCTION public\.work_items_identity_guard/i);
  assert.match(rollback, /NEW\.assignee_type := 'unassigned'/i);
  assert.doesNotMatch(
    rollback,
    /\b(?:DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE)\b/i
  );
});
