'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/081_monthly_finance_close_control.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/081_monthly_finance_close_control_rollback.sql'),
  'utf8',
);
const databaseProof = fs.readFileSync(
  path.join(ROOT, 'test/sql/monthly-finance-close-negative.sql'),
  'utf8',
);

test('migration is additive and does not mutate totals, providers, or legacy locks', () => {
  assert.doesNotMatch(
    migration,
    /\b(ALTER|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?public[.]finance_entries/i,
  );
  assert.doesNotMatch(
    migration,
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public[.]finance_period_locks/i,
  );
  assert.doesNotMatch(migration, /\b(fetch|axios|stripe[.]|telnyx[.]|resend[.])\b/i);
  assert.match(migration, /does not calculate or rewrite finance totals/i);
});

test('exact tenant, period, and currency identity is constrained and unique', () => {
  assert.match(
    migration,
    /UNIQUE \(tenant_id, period_start, currency\)/,
  );
  assert.match(
    migration,
    /period_start = date_trunc\('month', period_start\)::date/,
  );
  assert.match(migration, /currency\s+text NOT NULL CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
  assert.match(
    migration,
    /cycle[.]id = p_cycle_id[\s\S]*cycle[.]tenant_id = p_tenant_id[\s\S]*cycle[.]period_start = p_period_start[\s\S]*cycle[.]currency = p_currency/,
  );
});

test('close states cover reconciliation, exception, review, signoff, export, and lock', () => {
  for (const state of [
    'reconciling',
    'exception_review',
    'review_ready',
    'reviewer_approved',
    'signed_off',
    'exported',
    'shadow_locked',
  ]) {
    assert.match(migration, new RegExp(`'${state}'`));
  }
  assert.match(migration, /production_period_lock_applied[\s\S]*CHECK \(production_period_lock_applied = false\)/);
});

test('reconciliation prerequisite validates exact evidence records fail closed', () => {
  assert.match(migration, /cardinality\(p_reconciliation_record_ids\) = 0/);
  assert.match(
    migration,
    /finance_attribution_records attribution[\s\S]*attribution[.]tenant_id = p_tenant_id[\s\S]*attribution[.]currency = p_currency/,
  );
  assert.match(migration, /attribution[.]reconciliation_status = 'matched'/);
  assert.match(migration, /finance_close_reconciliation_prerequisites_unmet/);
  assert.match(migration, /exception[.]status = 'open'/);
  assert.match(migration, /task[.]status <> 'completed'/);
});

test('tasks have assignment, acceptance, SLA, escalation, and completion contracts', () => {
  assert.match(migration, /assignee_id\s+uuid NOT NULL/);
  assert.match(migration, /accepted_at\s+timestamptz/);
  assert.match(migration, /due_at\s+timestamptz NOT NULL/);
  assert.match(migration, /escalated_at\s+timestamptz/);
  assert.match(migration, /completion_evidence_digest/);
  assert.match(migration, /finance_close_task_assignee_tenant_mismatch/);
});

test('review and signoff require tenant humans with separation of duties', () => {
  assert.match(migration, /finance_close_human_not_tenant_member/);
  assert.match(migration, /v_cycle[.]reviewer_id = v_actor_uuid/);
  assert.match(migration, /p_authority_tier <> 'owner'/);
  assert.match(migration, /p_evidence->>'source_type' <> 'signoff_decision'/);
});

test('immutable evidence, optimistic revision, idempotency, and kill switch are enforced', () => {
  assert.match(migration, /trg_finance_close_events_immutable/);
  assert.match(migration, /finance_close_evidence_is_immutable/);
  assert.match(migration, /finance_close_revision_conflict/);
  assert.match(migration, /finance_close_idempotency_conflict/);
  assert.match(migration, /finance_close_kill_switch_engaged/);
  assert.match(
    migration,
    /SET enabled = false,\s+execution_mode = 'disabled',\s+kill_switch_engaged = true/,
  );
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/);
});

test('direct mutations are contained and RPC is service-role-only', () => {
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*finance_close_events[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
  assert.match(migration, /finance_close_requires_service_role/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public[.]finance_close_command_rpc[\s\S]*TO service_role/,
  );
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)\b/i,
  );
});

test('structural containment forbids exports and production period locks', () => {
  assert.match(migration, /provider_export_enabled[\s\S]*CHECK \(provider_export_enabled = false\)/);
  assert.match(migration, /production_period_lock_enabled[\s\S]*CHECK \(production_period_lock_enabled = false\)/);
  assert.match(migration, /finance_close_external_mutation_forbidden/);
  assert.match(migration, /finance_close_kill_switch_is_one_way/);
  assert.match(migration, /finance_close_activation_invalid/);
});

test('rollback removes write paths while preserving evidence tables', () => {
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]finance_close_command_rpc/);
  const rollbackWithoutComments = rollback.replace(/--.*$/gm, '');
  assert.doesNotMatch(rollbackWithoutComments, /DROP TABLE/i);
  assert.match(rollback, /immutable evidence survives rollback/i);
});

test('database proof covers role, gate, tenant, evidence, revision, and immutability negatives', () => {
  for (const expected of [
    'expected authenticated finance-close RPC denial',
    'expected disabled finance-close write denial',
    'expected cross-tenant reconciliation evidence denial',
    'expected stale finance-close revision denial',
    'expected same-person signoff denial',
    'expected immutable finance-close event denial',
    'expected engaged finance-close kill switch denial',
  ]) {
    assert.match(databaseProof, new RegExp(expected));
  }
});
