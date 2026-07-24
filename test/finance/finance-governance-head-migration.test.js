'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/090_finance_data_governance_head_supervised.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/090_finance_data_governance_head_supervised_rollback.sql'),
  'utf8',
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/finance-governance-head-negative.sql'),
  'utf8',
);
const concurrencyProof = fs.readFileSync(
  path.join(ROOT, 'test/sql/finance-governance-head-concurrency.sql'),
  'utf8',
);

test('mission and measurable KPI contract are mandatory', () => {
  assert.match(migration, /mission\s+text NOT NULL/);
  for (const kpi of [
    'reconciliation_match_rate',
    'monthly_close_sla_days',
    'exception_resolution_sla_hours',
    'data_quality_pass_rate',
    'evidence_completeness_rate',
    'tenant_isolation_gate_pass_rate',
  ]) assert.match(migration, new RegExp(`'${kpi}'`));
});

test('all production-bound finance authority is structurally false', () => {
  for (const field of [
    'production_write_authority',
    'money_movement_authority',
    'charge_refund_authority',
    'provider_dispatch_authority',
    'pricing_authority',
    'period_lock_authority',
    'export_authority',
    'customer_communication_authority',
  ]) {
    assert.match(
      migration,
      new RegExp(`${field}[\\s\\S]*CHECK \\(${field} = false\\)`),
    );
  }
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|stripe[.]|telnyx[.]|resend[.])\b/i,
  );
});

test('reports are grounded in canonical attribution and monthly-close evidence', () => {
  assert.match(
    migration,
    /REFERENCES public[.]finance_attribution_records\(id, tenant_id\)/,
  );
  assert.match(
    migration,
    /REFERENCES public[.]finance_close_cycles\(id, tenant_id\)/,
  );
  assert.match(migration, /sum\(attribution[.]revenue_minor\)/);
  assert.match(migration, /sum\(attribution[.]cost_minor\)/);
  assert.match(migration, /attribution[.]reconciliation_status <> 'matched'/);
  assert.match(
    migration,
    /v_close[.]reconciliation_record_count\s*=\s*cardinality\(p_attribution_record_ids\)/,
  );
  assert.match(
    migration,
    /v_scope_count = v_close[.]reconciliation_record_count/,
  );
  assert.match(migration, /v_missing = 0/);
  assert.match(
    migration,
    /finance_governance_attribution_manifest_incomplete/,
  );
});

test('green execution cannot imply reconciled financial truth', () => {
  assert.match(migration, /execution_health[\s\S]*financial_truth_state/);
  assert.match(
    migration,
    /v_close[.]close_state = 'shadow_locked'[\s\S]*p_data_governance_state = 'verified'[\s\S]*THEN 'verified'/,
  );
  assert.doesNotMatch(
    migration,
    /p_execution_health\s*=\s*'succeeded'[\s\S]{0,120}THEN 'verified'/,
  );
  assert.match(proof, /green execution incorrectly implied financial truth/);
});

test('durable case lifecycle includes assignment through verified outcome', () => {
  for (const value of [
    'goal', 'work', 'decision', 'exception', 'assigned', 'accepted',
    'escalated', 'completed', 'verified_achieved', 'verified_not_achieved',
  ]) assert.match(migration, new RegExp(`'${value}'`));
  assert.match(migration, /finance_governance_work_acceptance_invalid/);
  assert.match(migration, /finance_governance_work_escalation_invalid/);
  assert.match(migration, /finance_governance_work_completion_invalid/);
  assert.match(migration, /finance_governance_outcome_contract_invalid/);
  assert.match(migration, /finance_governance_goal_completion_invalid/);
  assert.match(migration, /finance_governance_decision_invalid/);
  assert.match(migration, /finance_governance_exception_resolution_invalid/);
  assert.match(migration, /assignee_actor_id IS DISTINCT FROM p_actor_id/);
});

test('authority, idempotency, RLS, immutable evidence, and kill switch fail closed', () => {
  assert.match(migration, /finance_governance_registered_head_required/);
  assert.match(migration, /finance_governance_idempotency_conflict/);
  assert.match(migration, /finance_governance_evidence_is_immutable/);
  assert.match(migration, /finance_governance_kill_switch_is_one_way/);
  assert.match(migration, /kill_switch_reason_digest/);
  assert.match(
    migration,
    /finance_governance_head_controls control[\s\S]*FOR SHARE/,
  );
  assert.match(
    migration,
    /finance_governance_json_has_forbidden_key[\s\S]*regexp_replace\(lower\(v_key\)/,
  );
  assert.match(migration, /finance_governance_evidence_is_minimized/);
  assert.match(migration, /finance_governance_report_metadata_is_minimized/);
  assert.match(migration, /finance_governance_case_contract_is_minimized/);
  assert.match(
    migration,
    /p_evidence \?& ARRAY\[[\s\S]*'source_type', 'source_id', 'observed_at'/,
  );
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*finance_governance_head_events[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
});

test('rollback retains evidence and removes mutation paths', () => {
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(
    rollback,
    /DROP FUNCTION IF EXISTS public[.]finance_governance_head_command_rpc/,
  );
  assert.doesNotMatch(rollback.replace(/--.*$/gm, ''), /DROP TABLE/i);
});

test('PostgreSQL proof covers role, tenant, truth, writes, audit, and containment', () => {
  for (const phrase of [
    'expected authenticated Finance Head RPC denial',
    'expected unregistered Finance Head denial',
    'expected cross-tenant canonical evidence denial',
    'expected partial close manifest exploit denial',
    'expected direct Finance Head service write denial',
    'expected production-bound Finance Head payload denial',
    'expected arbitrary assignee Finance Head denial',
    'expected mixed-case sensitive metadata denial',
    'expected mixed-case unsupported Finance metadata denial',
    'expected stored Finance Head acceptance assignee denial',
    'expected stored Finance Head completion assignee denial',
    'expected every Finance Head work lifecycle transition',
    'expected completed Finance Head goal',
    'expected decided Finance Head decision',
    'expected resolved Finance Head exception',
    'expected immutable Finance Head evidence denial',
    'expected engaged Finance Head kill switch denial',
    'tenant A saw tenant B Finance Head evidence',
  ]) assert.match(proof, new RegExp(phrase));
});

test('two-session proof orders containment after in-flight command completion', () => {
  for (const phrase of [
    'expected kill to wait behind in-flight Finance Head command',
    'prechecked Finance Head command did not finish before kill',
    'concurrent Finance Head kill did not commit containment',
    'expected command after concurrent Finance Head kill denial',
  ]) assert.match(concurrencyProof, new RegExp(phrase));
  assert.match(concurrencyProof, /dblink_send_query/);
  assert.match(concurrencyProof, /dblink_is_busy/);
});
