'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/092_product_engineering_head_supervised.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(
    ROOT,
    'db/rollbacks/092_product_engineering_head_supervised_rollback.sql',
  ),
  'utf8',
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/product-engineering-head-negative.sql'),
  'utf8',
);

test('mission contract covers every Product and Engineering outcome area', () => {
  assert.match(migration, /mission\s+text NOT NULL/);
  for (const kpi of [
    'reliability_quality_pass_rate',
    'change_lead_time_hours',
    'change_throughput_rate',
    'regression_escape_rate',
    'tenant_isolation_gate_pass_rate',
    'incident_escape_rate',
    'rollback_readiness_rate',
    'accessibility_debt_count',
    'security_debt_count',
    'product_outcome_achievement_rate',
  ]) assert.match(migration, new RegExp(`'${kpi}'`));
  for (const reportType of [
    'reliability_quality',
    'change_throughput',
    'regression_isolation',
    'incident_rollback',
    'accessibility_security',
    'product_outcome',
  ]) assert.match(migration, new RegExp(`'${reportType}'`));
});

test('all production and external authority is structurally false', () => {
  for (const field of [
    'code_merge_authority',
    'deployment_authority',
    'migration_apply_authority',
    'feature_activation_authority',
    'release_authority',
    'external_provider_authority',
    'customer_communication_authority',
    'money_movement_authority',
    'pricing_authority',
    'legal_policy_authority',
  ]) {
    assert.match(
      migration,
      new RegExp(`${field}[\\s\\S]*CHECK \\(${field} = false\\)`),
    );
  }
  assert.match(migration, /product_engineering_head_prohibited_authority/);
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|telnyx[.]|twilio[.]|resend[.]|send_sms|send_email)\b/i,
  );
});

test('reports require bounded exact-tenant evidence by report class', () => {
  assert.match(migration, /engineering_evidence_manifest/);
  assert.match(migration, /jsonb_array_length\(p_evidence->'sources'\) NOT BETWEEN 1 AND 50/);
  assert.match(migration, /source->>'source_tenant_id' IS DISTINCT FROM p_tenant_id::text/);
  for (const sourceType of [
    'automated_test_run',
    'tenant_isolation_gate',
    'security_scan',
    'accessibility_audit',
    'deployment_readiness_check',
    'rollback_drill',
    'incident_postmortem',
    'product_outcome_receipt',
  ]) assert.match(migration, new RegExp(`'${sourceType}'`));
  assert.match(migration, /product_engineering_head_authoritative_evidence_required/);
  assert.match(migration, /product_engineering_head_kpi_contract_incomplete/);
});

test('verified outcomes bind to immutable independent owner receipts', () => {
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS public[.]product_engineering_outcome_receipts/,
  );
  assert.match(
    migration,
    /product_engineering_head_outcome_verifier_must_be_independent/,
  );
  assert.match(
    migration,
    /product_engineering_head_canonical_outcome_receipt_required/,
  );
  assert.match(migration, /report[.]product_outcome_state = p_product_outcome_state/);
  assert.match(migration, /report[.]product_outcome_receipt_id IS NOT NULL/);
  assert.match(migration, /trg_product_engineering_outcome_receipts_immutable/);
  assert.match(proof, /expected non-owner outcome verifier denial/);
  assert.match(proof, /expected service owner-impersonation denial/);
  assert.match(proof, /expected registered Head self-verification denial/);
  assert.match(proof, /expected caller-labelled outcome receipt denial/);
  assert.match(proof, /expected mismatched report outcome state denial/);
  assert.match(proof, /expected immutable Product Engineering outcome receipt denial/);
});

test('persisted report, source, contract, and event metadata are minimal', () => {
  assert.match(migration, /product_engineering_head_report_shape_invalid/);
  assert.match(
    migration,
    /p_evidence - ARRAY\[[\s\S]*'source_type', 'source_id', 'observed_at'/,
  );
  assert.match(
    migration,
    /source - ARRAY\[[\s\S]*'source_tenant_id', 'digest', 'observed_at'/,
  );
  assert.match(proof, /expected mixed-case sensitive metadata denial/);
});

test('execution and completed work cannot imply product outcome', () => {
  assert.match(migration, /execution_health_state\s+text NOT NULL/);
  assert.match(migration, /product_outcome_state\s+text NOT NULL DEFAULT 'unknown'/);
  assert.match(
    migration,
    /WHEN 'complete_work'[\s\S]*v_next_outcome := 'unproven'/,
  );
  assert.match(migration, /record_product_outcome/);
  assert.match(
    migration,
    /report[.]report_type = 'product_outcome'[\s\S]*report[.]outcome_verified = true/,
  );
  assert.match(migration, /product_engineering_head_false_product_outcome_forbidden/);
  assert.match(migration, /product_outcome_verified\s+boolean GENERATED ALWAYS/);
});

test('durable goals, work, decisions, exceptions, and evidence are supervised', () => {
  for (const type of ['goal', 'work', 'decision', 'exception']) {
    assert.match(migration, new RegExp(`'${type}'`));
  }
  for (const field of [
    'owner_id', 'assignee_id', 'assigned_at', 'accepted_at', 'sla_due_at',
    'escalated_at', 'completed_at', 'completion_evidence_digest',
    'outcome_evidence_digest',
  ]) assert.match(migration, new RegExp(field));
  assert.match(migration, /assignment_acceptance/);
  assert.match(migration, /engineering_completion_receipt/);
  assert.match(migration, /product_outcome_receipt/);
  assert.match(migration, /trg_product_engineering_head_reports_immutable/);
  assert.match(migration, /trg_product_engineering_head_events_immutable/);
});

test('identity, revisions, idempotency, and one-way kill switch fail closed', () => {
  assert.match(migration, /product_engineering_head_agent_identity_mismatch/);
  assert.match(migration, /product_engineering_head_owner_role_required/);
  assert.match(migration, /product_engineering_head_report_operator_role_required/);
  assert.match(migration, /product_engineering_head_activation_actor_not_tenant_admin/);
  assert.match(migration, /product_engineering_head_cross_tenant_report_forbidden/);
  assert.match(migration, /product_engineering_head_cross_tenant_case_forbidden/);
  assert.match(migration, /product_engineering_head_idempotency_conflict/);
  assert.match(migration, /product_engineering_head_revision_conflict/);
  assert.match(migration, /product_engineering_head_control_revision_conflict/);
  assert.match(migration, /product_engineering_head_kill_switch_is_one_way/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('RLS is exact-tenant read-only and service writes use narrow RPCs', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FOR SELECT TO authenticated/);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
  assert.match(migration, /product_engineering_head_requires_service_role/);
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)\b/i,
  );
});

test('rollback contains commands and preserves evidence', () => {
  assert.match(rollback, /SET enabled = false/);
  assert.match(rollback, /execution_mode = 'disabled'/);
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(
    rollback,
    /DROP FUNCTION IF EXISTS public[.]product_engineering_head_report_rpc/,
  );
  const withoutComments = rollback.replace(/--.*$/gm, '');
  assert.doesNotMatch(withoutComments, /DROP TABLE|DELETE FROM|TRUNCATE/i);
  assert.match(rollback, /product engineering evidence survives rollback/i);
  assert.match(rollback, /product_engineering_outcome_receipt_rpc/);
  assert.match(rollback, /product_engineering_outcome_receipts/);
});

test('database proof covers authority, isolation, false green, lifecycle, and containment', () => {
  for (const expected of [
    'expected cross-tenant Product Engineering Head activation denial',
    'expected prohibited Product Engineering Head authority denial',
    'expected direct service-role write denial',
    'expected authenticated Product Engineering Head RPC denial',
    'expected disabled Product Engineering Head write denial',
    'expected Product Engineering Head identity denial',
    'expected cross-tenant Product Engineering Head report denial',
    'expected missing isolation evidence denial',
    'expected false Product Engineering Head outcome denial',
    'expected non-owner outcome verifier denial',
    'expected service owner-impersonation denial',
    'expected registered Head self-verification denial',
    'expected caller-labelled outcome receipt denial',
    'expected mixed-case sensitive metadata denial',
    'expected mismatched report outcome state denial',
    'expected stale Product Engineering Head revision denial',
    'expected Product Engineering Head outcome-before-completion denial',
    'expected agent Product Engineering Head approval denial',
    'expected immutable Product Engineering Head evidence denial',
    'expected Product Engineering Head kill switch denial',
  ]) assert.match(proof, new RegExp(expected));
});
