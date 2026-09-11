'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '107_chief_of_staff_shadow_rearm.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'rollbacks', '107_chief_of_staff_shadow_rearm_rollback.sql'),
  'utf8',
);

test('shadow rearm can only produce read-only zero-authority control', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.cos_shadow_activate_rpc/);
  assert.match(migration, /v_role IS DISTINCT FROM 'service_role'/);
  assert.match(migration, /tenant_user\.user_id = p_actor_id/);
  assert.match(migration, /NEW\.execution_mode = 'shadow'/);
  assert.match(migration, /NEW\.read_only = true/);
  for (const field of [
    'production_write_enabled', 'provider_dispatch_enabled',
    'customer_communication_enabled', 'financial_action_enabled',
  ]) {
    assert.match(migration, new RegExp(`${field} = false`), field);
  }
  assert.doesNotMatch(migration, /customer_communication_enabled\s*=\s*true/);
  assert.doesNotMatch(migration, /production_write_enabled\s*=\s*true/);
});

test('direct kill-switch reversal remains blocked and rollback removes the rearm RPC', () => {
  assert.match(migration, /cos_kill_switch_is_one_way/);
  assert.match(migration, /current_setting\('app\.cos_shadow_rearm'/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.cos_shadow_activate_rpc/);
  assert.doesNotMatch(rollback, /UPDATE public\.cos_supervision_controls/);
  assert.doesNotMatch(migration, /^\s*(BEGIN|COMMIT)\s*;/mi);
  assert.doesNotMatch(rollback, /^\s*(BEGIN|COMMIT)\s*;/mi);
});
