'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/087_chief_of_staff_supervised_control.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/087_chief_of_staff_supervised_control_rollback.sql'),
  'utf8',
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/chief-of-staff-supervised-negative.sql'),
  'utf8',
);

test('foundation is additive, default-off, and structurally read-only', () => {
  assert.match(migration, /enabled\s+boolean NOT NULL DEFAULT false/);
  assert.match(migration, /read_only[\s\S]*CHECK \(read_only = true\)/);
  for (const field of [
    'production_write_enabled',
    'provider_dispatch_enabled',
    'customer_communication_enabled',
    'financial_action_enabled',
  ]) {
    assert.match(
      migration,
      new RegExp(`${field}[\\s\\S]*CHECK \\(${field} = false\\)`),
    );
  }
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|telnyx[.]|twilio[.]|resend[.]|stripe[.])\b/i,
  );
});

test('Reliability and Revenue accepted contracts and reports gate every cycle', () => {
  assert.match(
    migration,
    /report[.]department = 'reliability_security_agent_ops'[\s\S]*report[.]report_state = 'accepted'[\s\S]*contract[.]acceptance_state = 'accepted'/,
  );
  assert.match(
    migration,
    /report[.]department = 'revenue_sales'[\s\S]*report[.]report_state = 'accepted'[\s\S]*contract[.]acceptance_state = 'accepted'/,
  );
  assert.match(migration, /cos_reliability_revenue_report_gate_unmet/);
  assert.match(migration, /REFERENCES public[.]reliability_head_reports/);
  assert.match(migration, /REFERENCES public[.]revenue_head_reports/);
  assert.match(
    migration,
    /report[.]reporting_period_start = p_reporting_period_start[\s\S]*report[.]reporting_period_end = p_reporting_period_end/,
  );
});

test('goals, dependencies, conflicts, decisions, exceptions, and follow-through exist', () => {
  for (const type of [
    'company_goal',
    'dependency',
    'capacity_conflict',
    'decision_required',
    'exception',
    'follow_through',
  ]) {
    assert.match(migration, new RegExp(`'${type}'`));
  }
  assert.match(migration, /jsonb_typeof\(p_record_payload->'kpis'\) <> 'array'/);
  assert.match(migration, /source_goal_id[\s\S]*target_goal_id/);
  assert.match(migration, /cos_follow_through_acceptance_invalid/);
  assert.match(migration, /cos_follow_through_completion_invalid/);
});

test('tenant role, idempotency, immutable audit, and direct-write denial are enforced', () => {
  assert.match(migration, /cos_requires_service_role/);
  assert.match(migration, /cos_human_actor_tenant_mismatch/);
  assert.match(migration, /cos_human_actor_role_mismatch/);
  assert.match(migration, /cos_idempotency_conflict/);
  assert.match(migration, /cos_supervised_event_is_immutable/);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*cos_supervised_events[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(migration, /CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)/i);
});

test('kill switch is one-way, reason-digested, and preserves containment', () => {
  assert.match(migration, /cos_kill_switch_is_one_way/);
  assert.match(migration, /kill_switch_reason_digest/);
  assert.doesNotMatch(migration, /'kill_switch_reason'\s*,\s*p_reason/);
  assert.match(migration, /enabled = false, execution_mode = 'disabled'/);
});

test('rollback removes mutation paths and preserves supervised evidence', () => {
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]chief_of_staff_command_rpc/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]cos_report_command_rpc/);
  assert.doesNotMatch(rollback.replace(/--.*$/gm, ''), /DROP TABLE/i);
});

test('PostgreSQL proof covers prerequisite, tenant, role, write, payload, and kill gates', () => {
  for (const phrase of [
    'expected authenticated Chief of Staff RPC denial',
    'expected direct service-role Chief of Staff write denial',
    'expected unaccepted Revenue contract dependency denial',
    'expected cross-tenant accepted report dependency denial',
    'expected production-bound Chief of Staff payload denial',
    'expected immutable Chief of Staff audit denial',
    'expected engaged Chief of Staff kill switch denial',
    'tenant A saw tenant B Chief of Staff record',
  ]) {
    assert.match(proof, new RegExp(phrase));
  }
});
