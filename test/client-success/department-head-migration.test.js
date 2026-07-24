'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/089_client_success_department_head_supervised.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/089_client_success_department_head_supervised_rollback.sql'),
  'utf8',
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/client-success-department-head-negative.sql'),
  'utf8',
);

test('migration is additive and cannot mutate deployed customer paths', () => {
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+public[.](customers|support_tickets|messages|client_health_interventions)/i);
  assert.doesNotMatch(migration, /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+public[.](customers|support_tickets|messages|client_health_interventions)/i);
  assert.doesNotMatch(migration, /\b(fetch|axios|telnyx[.]|stripe[.]|resend[.])/i);
});

test('all external and production authorities are structurally false', () => {
  for (const column of [
    'production_write_authority', 'customer_communications_enabled',
    'provider_dispatch_enabled', 'financial_authority_enabled',
    'refund_credit_authority_enabled',
  ]) {
    assert.match(migration, new RegExp(
      `${column}\\s+boolean NOT NULL DEFAULT false[\\s\\S]*?CHECK \\(${column} = false\\)`,
    ));
  }
  assert.match(migration, /client_success_head_production_authority_forbidden/);
});

test('charter and report have mission, KPIs, authoritative evidence links', () => {
  assert.match(migration, /mission\s+text NOT NULL/);
  for (const kpi of [
    'max_first_response_minutes', 'max_resolution_minutes',
    'max_sla_breach_rate_bps', 'min_csat_bps',
    'max_open_critical_tickets',
  ]) assert.match(migration, new RegExp(`${kpi}\\s+integer NOT NULL`));
  assert.match(migration, /REFERENCES public[.]client_health_signal_snapshots/);
  assert.match(migration, /REFERENCES public[.]client_health_interventions/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public[.]client_success_support_snapshots/);
  assert.match(migration, /REFERENCES public[.]client_success_support_snapshots/);
  assert.match(migration, /support_source_system\s+text NOT NULL DEFAULT 'support_ledger'/);
  assert.match(migration, /verification_state\s+text NOT NULL/);
  assert.match(migration, /client_success_support_snapshot_customer_tenant_mismatch/);
  assert.match(migration, /WHEN v_support[.]verification_state <> 'verified'[\s\S]*THEN 'unverified'/);
  assert.match(migration, /v_support[.]opened_tickets/);
  assert.match(migration, /client_success_head_report_registered_head_required/);
  assert.match(migration, /p_actor_id IS DISTINCT FROM v_control[.]registered_agent_id/);
  assert.doesNotMatch(
    migration.match(/CREATE OR REPLACE FUNCTION public[.]client_success_head_report_accept_rpc[\s\S]*?END;\n[$][$];/)?.[0] || '',
    /p_(support_source_id|support_evidence_digest|support_observed_at|opened_tickets|resolved_tickets|sla_breached_tickets|open_critical_tickets|first_response_minutes|resolution_minutes|csat_bps)/,
  );
});

test('completion cannot manufacture observed client outcome', () => {
  assert.match(migration, /action_completed deliberately remains unproven/);
  assert.match(migration, /v_intervention[.]lifecycle_state = 'outcome_recorded'/);
  assert.match(migration, /v_intervention[.]outcome_verified = true/);
  assert.match(migration, /THEN 'observed_stable'/);
  assert.match(migration, /ELSE 'unproven'/);
  assert.match(migration, /outcome_healthy\s+boolean GENERATED ALWAYS AS/);
});

test('evidence manifests are minimized to exact citation fields', () => {
  assert.match(
    migration,
    /p_evidence - ARRAY\['schema_version', 'sources'\] <> '\{\}'::jsonb/,
  );
  assert.match(
    migration,
    /v_source - ARRAY\[[\s\S]*'source_type', 'source_id', 'evidence_digest', 'observed_at'[\s\S]*\] <> '\{\}'::jsonb/,
  );
});

test('durable lifecycle, exact authority, RLS, replay, and kill are explicit', () => {
  assert.match(migration, /item_kind IN \('goal', 'work', 'decision', 'exception'\)/);
  assert.match(migration, /'assigned', 'accepted', 'in_progress',[\s\S]*'escalated', 'completed'/);
  assert.match(migration, /p_actor_id IS DISTINCT FROM v_control[.]registered_agent_id/);
  assert.match(migration, /client_success_head_decision_requires_human_owner/);
  assert.match(migration, /client_success_head_work_idempotency_conflict/);
  assert.match(migration, /client_success_head_kill_switch_is_one_way/);
  for (const table of [
    'client_success_head_controls', 'client_success_head_charters',
    'client_success_support_snapshots', 'client_success_head_reports',
    'client_success_head_items',
    'client_success_head_events',
  ]) assert.match(migration, new RegExp(
    `ALTER TABLE public[.]${table} ENABLE ROW LEVEL SECURITY`,
  ));
});

test('rollback disables execution and retains evidence', () => {
  assert.match(rollback, /UPDATE public[.]client_success_head_controls[\s\S]*enabled = false[\s\S]*kill_switch_engaged = true/);
  assert.doesNotMatch(rollback, /DROP TABLE/i);
  assert.match(rollback, /evidence_retained/);
});

test('PostgreSQL proof covers false-green, tenant, workflow, and rollback safety', () => {
  for (const phrase of [
    'expected authenticated client success RPC denial',
    'expected disabled client success write denial',
    'expected cross-tenant health evidence denial',
    'expected cross-tenant support evidence denial',
    'expected direct cross-tenant support snapshot denial',
    'stable_support remained falsely healthy',
    'expected unregistered client success report head denial',
    'expected client success report authority denial',
    'expected immutable canonical support snapshot denial',
    'expected exact client success report replay',
    'completed intervention appeared proven',
    'observed improved intervention did not become healthy',
    'completed client success work changed report outcome',
    'expected unregistered client success head denial',
    'expected prohibited customer communication scope denial',
    'expected stale client success revision denial',
    'expected exact client success work replay',
    'expected one-way client success kill-switch denial',
    'authenticated client success RLS tenant isolation failed',
  ]) assert.match(proof, new RegExp(phrase));
});
