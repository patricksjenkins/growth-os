'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/086_revenue_department_head_supervised.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/086_revenue_department_head_supervised_rollback.sql'),
  'utf8',
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/revenue-department-head-negative.sql'),
  'utf8',
);

test('foundation is additive and cannot mutate deployed commercial paths', () => {
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+public[.](leads|messages|outreach_campaigns|finance_entries)/i);
  assert.doesNotMatch(migration, /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+public[.](leads|messages|outreach_campaigns|finance_entries)/i);
  assert.doesNotMatch(migration, /\b(fetch|axios|telnyx[.]|stripe[.]|resend[.]|buffer[.])/i);
});

test('control is supervised read-only with every external authority structurally false', () => {
  assert.match(migration, /execution_mode IN \(\s*'disabled', 'supervised_read_only'/);
  for (const column of [
    'production_write_authority',
    'outreach_enabled',
    'provider_dispatch_enabled',
    'pricing_authority_enabled',
    'financial_authority_enabled',
  ]) {
    assert.match(migration, new RegExp(
      `${column}\\s+boolean NOT NULL DEFAULT false[\\s\\S]*?CHECK \\(${column} = false\\)`,
    ));
  }
  assert.match(migration, /revenue_head_production_authority_forbidden/);
});

test('charter contains a written mission and measurable funnel KPIs', () => {
  assert.match(migration, /mission\s+text NOT NULL/);
  for (const kpi of [
    'qualification_rate_target_bps',
    'appointment_rate_target_bps',
    'held_rate_target_bps',
    'proposal_rate_target_bps',
    'win_rate_target_bps',
    'max_sales_cycle_days',
  ]) {
    assert.match(migration, new RegExp(`${kpi}\\s+integer NOT NULL`));
  }
});

test('only structured evidence-backed reports can produce outcome health', () => {
  assert.match(migration, /report_type\s+text NOT NULL DEFAULT 'sales_outcome_v1'/);
  assert.match(migration, /revenue_head_evidence_contract_invalid/);
  assert.match(migration, /revenue_head_evidence_source_invalid/);
  assert.match(migration, /revenue_head_duplicate_evidence_source/);
  assert.match(migration, /revenue_head_structured_report_invalid/);
  assert.match(migration, /funnel_health\s+text NOT NULL/);
  assert.match(migration, /business_effect_state\s+text NOT NULL/);
  assert.match(migration, /outcome_healthy\s+boolean GENERATED ALWAYS AS/);
  assert.match(
    migration,
    /WHEN v_evidence_count < 2 OR v_evidence_source_type_count < 2[\s\S]*THEN 'unverified'/,
  );
});

test('goals, work, decisions, exceptions, SLA, and evidence are durable and audited', () => {
  assert.match(migration, /item_kind IN \(\s*'goal', 'work', 'decision', 'exception'/);
  assert.match(migration, /status IN \(\s*'assigned', 'accepted', 'in_progress',[\s\S]*'escalated', 'completed'/);
  for (const field of [
    'assigned_at', 'accepted_at', 'started_at', 'due_at',
    'escalated_at', 'completed_at', 'completion_evidence_digest',
  ]) {
    assert.match(migration, new RegExp(field));
  }
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public[.]revenue_head_events/);
  assert.match(migration, /revenue_head_evidence_is_immutable/);
});

test('authority binds the exact registered head and tenant owner', () => {
  assert.match(migration, /p_actor_id IS DISTINCT FROM v_control[.]registered_agent_id/);
  assert.match(migration, /p_authority_tier <> 'department_head'/);
  assert.match(migration, /revenue_head_owner_identity_invalid/);
  assert.match(migration, /revenue_head_decision_requires_human_owner/);
  assert.match(migration, /revenue_head_owner_decision_contract_invalid/);
});

test('RLS, direct-write denial, exact gates, replay, and one-way kill are explicit', () => {
  for (const table of [
    'revenue_head_controls', 'revenue_head_charters', 'revenue_head_reports',
    'revenue_head_items', 'revenue_head_events',
  ]) {
    assert.match(migration, new RegExp(
      `ALTER TABLE public[.]${table} ENABLE ROW LEVEL SECURITY`,
    ));
  }
  assert.match(migration, /FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/g);
  assert.match(migration, /revenue_head_report_idempotency_conflict/);
  assert.match(migration, /revenue_head_work_idempotency_conflict/);
  assert.match(migration, /revenue_head_kill_switch_is_one_way/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public[.]revenue_head_kill_switch_rpc/);
});

test('rollback contains every tenant and preserves all evidence tables', () => {
  assert.match(rollback, /UPDATE public[.]revenue_head_controls[\s\S]*enabled = false[\s\S]*kill_switch_engaged = true/);
  for (const fn of [
    'revenue_head_charter_register_rpc',
    'revenue_head_report_accept_rpc',
    'revenue_head_work_command_rpc',
    'revenue_head_kill_switch_rpc',
  ]) {
    assert.match(rollback, new RegExp(`DROP FUNCTION IF EXISTS public[.]${fn}`));
  }
  assert.doesNotMatch(rollback, /DROP TABLE/i);
});

test('synthetic proof covers tenant, role, scope, health, workflow, and kill negatives', () => {
  for (const phrase of [
    'expected authenticated revenue head RPC denial',
    'expected disabled revenue head write denial',
    'expected cross-tenant charter actor denial',
    'expected duplicate revenue evidence source denial',
    'expected malformed sales report denial',
    'expected report provider identity rebind denial',
    'no-evidence report appeared healthy',
    'expected unregistered revenue head denial',
    'expected prohibited outreach scope denial',
    'expected assignee acceptance mismatch denial',
    'expected stale revenue head revision denial',
    'expected exact revenue head work replay',
    'expected premature revenue head SLA escalation denial',
    'expected department head owner-decision denial',
    'completed work changed funnel outcome health',
    'expected engaged revenue head kill switch denial',
    'expected one-way revenue head kill-switch denial',
    'authenticated revenue head RLS tenant isolation failed',
  ]) {
    assert.match(proof, new RegExp(phrase));
  }
});
