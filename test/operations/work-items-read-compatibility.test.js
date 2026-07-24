'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '073_work_items_read_compatibility.sql'),
  'utf8'
);

test('forward upgrade adds the generated rank and a new index to old 068 databases', () => {
  assert.match(sql, /ALTER TABLE public\.work_items[\s\S]*ADD COLUMN IF NOT EXISTS priority_rank/i);
  assert.match(sql, /idx_work_items_tenant_open_ranked/i);
  assert.doesNotMatch(sql, /idx_work_items_tenant_open\s/i);
});

test('upgrade transaction installs real owner roles and deterministic read grants', () => {
  assert.match(sql, /^\s*BEGIN;/m);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /'client_owner', 'tenant_owner'/);
  assert.match(sql, /GRANT SELECT ON[\s\S]*TO authenticated/i);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM authenticated/i);
});
