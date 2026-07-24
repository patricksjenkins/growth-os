'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '068_work_items_control_plane.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(root, 'db', 'rollbacks', '068_work_items_control_plane_rollback.sql'),
  'utf8'
);

test('migration is additive and preserves attention_queue as a compatibility source', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.work_items/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.work_item_events/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.work_item_audit_log/i);
  assert.match(migration, /attention_queue_id\s+uuid REFERENCES public\.attention_queue/i);
  assert.doesNotMatch(migration, /ALTER TABLE public\.attention_queue/i);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|POLICY)\b/i);
});

test('all control-plane tables are tenant scoped with RLS and select-only policies', () => {
  for (const table of ['work_items', 'work_item_events', 'work_item_audit_log']) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    assert.match(migration, new RegExp(`tenant_iso_${table}`, 'i'));
  }
  assert.match(migration, /tenant_id\s+uuid NOT NULL REFERENCES public\.tenants/i);
  assert.match(migration, /auth\.jwt\(\)->'app_metadata'->>'tenant_id'/i);
  assert.match(migration, /auth\.jwt\(\)->'app_metadata'->>'role'/i);
  assert.doesNotMatch(migration, /current_setting\('app\.tenant_id'/i);
  assert.doesNotMatch(migration, /CREATE POLICY[\\s\\S]{0,180}FOR (INSERT|UPDATE|DELETE|ALL)/i);
});

test('schema requires idempotency, event history, audit, and optimistic revision', () => {
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/i);
  assert.match(migration, /request_fingerprint\s+text NOT NULL/i);
  assert.match(migration, /revision\s+integer NOT NULL DEFAULT 1/i);
  assert.match(migration, /CREATE TRIGGER trg_work_items_set_revision/i);
  assert.match(migration, /CREATE TRIGGER trg_work_items_audit/i);
  assert.match(migration, /before_row\s+jsonb/i);
  assert.match(migration, /after_row\s+jsonb/i);
  assert.match(migration, /FOREIGN KEY \(work_item_id, tenant_id\)/i);
  assert.match(migration, /work_items_tenant_guard/i);
  assert.match(migration, /id = NEW\.attention_queue_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(migration, /trg_work_item_events_immutable/i);
  assert.match(migration, /trg_work_item_audit_immutable/i);
});

test('rollback is operator-only, complete, and does not touch attention_queue', () => {
  assert.match(rollback, /DROP TABLE IF EXISTS public\.work_item_audit_log/i);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.work_item_events/i);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.work_items/i);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.work_items_audit_trigger/i);
  assert.match(rollback, /work-item evidence exists/i);
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS public\.attention_queue/i);
  assert.doesNotMatch(rollback, /ALTER TABLE public\.attention_queue/i);
});
