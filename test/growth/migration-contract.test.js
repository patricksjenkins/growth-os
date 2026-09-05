'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations', '106_growth_pipeline_overhaul.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'rollbacks', '106_growth_pipeline_overhaul_rollback.sql'),
  'utf8',
);

test('growth evidence tables are additive, tenant scoped, and append-only', () => {
  for (const table of ['growth_events', 'growth_stage_state', 'growth_restart_batches', 'growth_restart_candidates']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
  }
  assert.match(migration, /tenant_id uuid NOT NULL REFERENCES public\.tenants/);
  assert.match(migration, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON public\.growth_events/);
  assert.match(migration, /FOR SELECT USING \(auth\.role\(\) = ''service_role'' OR tenant_id/);
  assert.match(migration, /FOR ALL USING \(auth\.role\(\) = ''service_role''\) WITH CHECK \(auth\.role\(\) = ''service_role''\)/);
  assert.match(migration, /auth\.jwt\(\) -> ''app_metadata'' ->> ''tenant_id''/);
  assert.match(migration, /assert_growth_lead_tenant/);
  assert.match(migration, /l\.id = NEW\.lead_id AND l\.tenant_id = NEW\.tenant_id/);
  assert.match(migration, /b\.id = NEW\.batch_id AND b\.tenant_id = NEW\.tenant_id/);
  assert.match(migration, /s\.id = NEW\.first_touch_sequence_id AND s\.tenant_id = NEW\.tenant_id/);
  assert.match(migration, /d\.id = NEW\.applied_enrollment_id AND d\.tenant_id = NEW\.tenant_id/);
  assert.doesNotMatch(migration, /DROP (?:TABLE|COLUMN)/i);
});

test('the migration preserves legacy campaigns while adding a versioned plan contract', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS plan_key/);
  assert.match(migration, /DEFAULT 'legacy-nine-followups-v1'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS total_touches/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS includes_initial_touch/);
});

test('rollback removes only migration 106 additions', () => {
  assert.match(rollback, /DROP TABLE IF EXISTS public\.growth_restart_candidates/);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.growth_events/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.assert_growth_lead_tenant/);
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS public\.(?:leads|drip_campaigns|email_events)/);
});
