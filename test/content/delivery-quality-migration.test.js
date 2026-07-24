'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/082_content_delivery_quality_control.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/082_content_delivery_quality_control_rollback.sql'),
  'utf8',
);
const databaseProof = fs.readFileSync(
  path.join(ROOT, 'test/sql/content-delivery-quality-negative.sql'),
  'utf8',
);

test('migration is additive and cannot publish or alter the legacy content path', () => {
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+public[.]content_drafts/i);
  assert.doesNotMatch(
    migration,
    /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+public[.](content_drafts|content_plans|content_plan_concepts|content_quality_scores)\b/i,
  );
  assert.doesNotMatch(migration, /\b(fetch|axios|buffer[.]|linkedin[.])/i);
  assert.match(migration, /provider_dispatch_enabled[\s\S]*CHECK \(provider_dispatch_enabled = false\)/);
});

test('version, rubric, calibration, evaluation, and receipt ledgers are tenant-bound and immutable', () => {
  for (const table of [
    'content_artifact_versions',
    'content_quality_rubric_versions',
    'content_quality_calibrations',
    'content_quality_evaluations',
    'content_delivery_receipts',
  ]) {
    assert.match(migration, new RegExp(
      `CREATE TABLE IF NOT EXISTS public[.]${table}[\\s\\S]*?tenant_id\\s+uuid NOT NULL`,
    ));
    assert.match(migration, new RegExp(
      `'${table}'`,
    ));
  }
  assert.match(
    migration,
    /EXECUTE format\('ALTER TABLE public[.]%I ENABLE ROW LEVEL SECURITY', v_table\)/,
  );
  assert.match(migration, /content_delivery_evidence_is_immutable/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated, service_role/);
});

test('delivery identity is globally non-rebindable and attempts are version-specific', () => {
  assert.match(
    migration,
    /UNIQUE \(provider, provider_account_ref, provider_delivery_id\)/,
  );
  assert.match(
    migration,
    /UNIQUE \(\s*tenant_id, content_version_id, provider, destination_ref, attempt_number\s*\)/,
  );
  assert.match(migration, /content_delivery_provider_identity_conflict/);
});

test('false-green constraints separate execution, output, quality, delivery, and effect', () => {
  for (const column of [
    'execution_state', 'output_state', 'quality_state',
    'delivery_state', 'business_effect_state',
  ]) {
    assert.match(migration, new RegExp(`${column}\\s+text NOT NULL`));
  }
  assert.match(
    migration,
    /output_state = 'produced'[\s\S]*quality_state <> 'accepted'[\s\S]*delivery_state <> 'delivered'[\s\S]*business_effect_state <> 'achieved'/,
  );
  assert.match(
    migration,
    /delivery_state <> 'delivered'[\s\S]*execution_state = 'completed'[\s\S]*quality_evaluation_id IS NOT NULL/,
  );
  assert.match(
    migration,
    /quality_state = 'unverified' AND quality_evaluation_id IS NULL/,
  );
  assert.match(
    migration,
    /business_effect_state <> 'achieved'[\s\S]*delivery_state = 'delivered'/,
  );
});

test('retry, stuck, exception, and owner work contracts are enforced', () => {
  assert.match(migration, /delivery_state IN \([\s\S]*'stuck'[\s\S]*'exception'/);
  assert.match(
    migration,
    /delivery_state NOT IN \('failed', 'stuck', 'exception'\)[\s\S]*owner_work_item_id IS NOT NULL/,
  );
  assert.match(migration, /work[.]authority_tier = 'owner'/);
  assert.match(migration, /retry_state = 'scheduled' AND next_retry_at IS NOT NULL/);
});

test('quality requires immutable rubric versions and calibration evidence', () => {
  assert.match(migration, /UNIQUE \(tenant_id, rubric_key, version\)/);
  assert.match(migration, /benchmark_set_digest/);
  assert.match(migration, /scorer_config_digest/);
  assert.match(migration, /agreement_basis_points BETWEEN 0 AND 10000/);
  assert.match(migration, /content_quality_calibration_rubric_mismatch/);
  assert.match(migration, /content_quality_state_threshold_mismatch/);
  assert.match(migration, /content_quality_category_score_invalid/);
});

test('RPCs require service role, exact gate, active control, and kill-switch release', () => {
  assert.match(migration, /content_delivery_requires_service_role/);
  assert.match(migration, /p_feature_gate_enabled IS DISTINCT FROM true/);
  assert.match(migration, /content_delivery_writes_disabled/);
  assert.match(migration, /kill_switch_engaged IS DISTINCT FROM false/);
  assert.match(migration, /provider_dispatch_enabled IS DISTINCT FROM false/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/g);
  assert.match(migration, /OLD[.]kill_switch_engaged = true[\s\S]*NEW[.]kill_switch_engaged = false/);
  assert.match(migration, /content_delivery_kill_switch_is_one_way/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public[.]content_delivery_kill_switch_rpc/);
  assert.match(migration, /content_delivery_kill_switch_requires_service_role/);
  assert.match(
    migration,
    /SET enabled = false,[\s\S]*execution_mode = 'disabled',[\s\S]*kill_switch_engaged = true/,
  );
  assert.match(
    migration,
    /'outcome', 'kill_switch_engaged',[\s\S]*'tenant_id', v_control[.]tenant_id,[\s\S]*'revision', v_control[.]revision/,
  );
  assert.doesNotMatch(
    migration,
    /RETURN jsonb_build_object\([\s\S]*'reason',\s*p_reason/,
  );
});

test('rollback removes mutation paths but preserves all evidence tables', () => {
  for (const fn of [
    'content_artifact_version_register_rpc',
    'content_quality_rubric_register_rpc',
    'content_quality_calibration_record_rpc',
    'content_quality_evaluation_record_rpc',
    'content_delivery_receipt_record_rpc',
    'content_delivery_kill_switch_rpc',
  ]) {
    assert.match(rollback, new RegExp(`DROP FUNCTION IF EXISTS public[.]${fn}`));
  }
  assert.doesNotMatch(rollback, /DROP TABLE/i);
});

test('synthetic database proof covers roles, tenant isolation, false green, replay, and immutability', () => {
  for (const phrase of [
    'expected authenticated content delivery RPC denial',
    'expected disabled content delivery write denial',
    'expected cross-tenant content draft denial',
    'expected false-green no-op receipt denial',
    'expected owner-work tenant mismatch denial',
    'expected provider delivery identity rebind denial',
    'expected exact content delivery replay',
    'expected immutable content delivery mutation denial',
    'authenticated content delivery RLS tenant isolation failed',
    'expected authenticated content delivery kill-switch denial',
    'expected engaged content delivery kill switch denial',
    'expected one-way content delivery kill-switch denial',
    'content delivery kill switch changed another tenant',
    'content delivery kill-switch leaked supplied reason',
  ]) {
    assert.match(databaseProof, new RegExp(phrase));
  }
});
