'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/088_onboarding_department_head_supervised.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/088_onboarding_department_head_supervised_rollback.sql'),
  'utf8',
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/onboarding-department-head-negative.sql'),
  'utf8',
);

test('charter has written mission, measurable KPIs, reports, and authority', () => {
  assert.match(migration, /mission\s+text NOT NULL/);
  for (const kpi of [
    'closed_won_to_accept_minutes',
    'accepted_to_acknowledged_minutes',
    'evidence_complete_handoff_rate',
    'implementation_completion_rate',
    'onboarding_sla_compliance_rate',
    'exception_resolution_rate',
    'time_to_first_value_days',
    'customer_outcome_receipt_rate',
  ]) assert.match(migration, new RegExp(`'${kpi}'`));
  for (const type of ['handoff', 'implementation', 'customer_outcome']) {
    assert.match(migration, new RegExp(`'${type}'`));
  }
  assert.match(migration, /authority_contract\s+jsonb NOT NULL/);
});

test('control is default-disabled, read-only supervised, and structurally contained', () => {
  assert.match(migration, /enabled\s+boolean NOT NULL DEFAULT false/);
  assert.match(migration, /execution_mode\s+text NOT NULL DEFAULT 'disabled'/);
  assert.match(migration, /'shadow',[\s\S]*'supervised_read_only'/);
  assert.match(migration, /kill_switch_engaged\s+boolean NOT NULL DEFAULT true/);
  for (const field of [
    'operational_write_authority',
    'provisioning_authority',
    'provider_action_authority',
    'customer_communication_authority',
    'production_change_authority',
    'money_movement_authority',
  ]) {
    assert.match(
      migration,
      new RegExp(`${field}[\\s\\S]*CHECK \\(${field} = false\\)`),
    );
  }
  assert.match(migration, /onboarding_head_prohibited_authority/);
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|telnyx[.]|twilio[.]|resend[.]|send_sms|send_email)\b/i,
  );
});

test('reports require authoritative handoff and workflow identities', () => {
  assert.match(
    migration,
    /FOREIGN KEY \(handoff_id, tenant_id\)[\s\S]*closed_won_onboarding_handoffs/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(workflow_id, client_tenant_id\)[\s\S]*onboarding_workflows/,
  );
  assert.match(migration, /onboarding_head_handoff_not_found_for_identity/);
  assert.match(migration, /onboarding_head_workflow_not_authoritative/);
  assert.match(migration, /closed_won_handoff_receipt/);
  assert.match(migration, /onboarding_workflow_receipt/);
  assert.match(migration, /customer_outcome_receipt/);
});

test('completion remains distinct from verified customer outcome', () => {
  assert.match(migration, /customer_outcome_state\s+text NOT NULL DEFAULT 'unknown'/);
  assert.match(
    migration,
    /WHEN 'complete_work'[\s\S]*v_next_outcome := 'unproven'/,
  );
  assert.match(migration, /record_customer_outcome/);
  assert.match(migration, /onboarding_head_false_customer_outcome_forbidden/);
  assert.match(migration, /customer_outcome_verified\s+boolean GENERATED ALWAYS/);
  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS public[.]onboarding_customer_outcome_receipts/,
  );
  assert.match(migration, /onboarding_customer_outcome_receipt_rpc/);
  assert.match(migration, /onboarding_head_canonical_outcome_receipt_required/);
  assert.match(migration, /verified_by_user_id/);
  assert.match(migration, /onboarding_customer_outcome_head_cannot_verify/);
  assert.match(
    migration,
    /FOREIGN KEY \([\s\S]*outcome_receipt_id[\s\S]*onboarding_customer_outcome_receipts/,
  );
});

test('evidence is recursively normalized and minimized before persistence', () => {
  assert.match(migration, /onboarding_head_json_keys_safe/);
  assert.match(migration, /regexp_replace\(lower\(v_key\), '\[\^a-z0-9\]'/);
  assert.match(migration, /'customeremail'/);
  assert.match(migration, /onboarding_head_evidence_is_minimized/);
  assert.match(
    migration,
    /key NOT IN \('source_type', 'source_id', 'observed_at'\)/,
  );
  assert.match(proof, /CustomerEmail/);
  assert.match(proof, /synthetic-achieved/);
});

test('goals, work, decisions, exceptions, and immutable evidence are durable', () => {
  for (const type of ['goal', 'work', 'decision', 'exception']) {
    assert.match(migration, new RegExp(`'${type}'`));
  }
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public[.]onboarding_head_events/);
  assert.match(migration, /trg_onboarding_head_reports_immutable/);
  assert.match(migration, /trg_onboarding_head_events_immutable/);
  assert.match(migration, /onboarding_head_evidence_is_immutable/);
});

test('work contract includes assignment, acceptance, SLA, escalation, completion, and outcome', () => {
  for (const field of [
    'owner_id', 'assignee_id', 'assigned_at', 'accepted_at', 'sla_due_at',
    'escalated_at', 'completed_at', 'completion_evidence_digest',
    'outcome_evidence_digest',
  ]) assert.match(migration, new RegExp(field));
  assert.match(migration, /assignment_acceptance/);
  assert.match(migration, /implementation_completion_receipt/);
  assert.match(migration, /customer_outcome_receipt/);
});

test('tenant, role, registered Head, revisions, idempotency, and kill switch fail closed', () => {
  assert.match(migration, /onboarding_head_agent_identity_mismatch/);
  assert.match(migration, /onboarding_head_owner_role_required/);
  assert.match(migration, /onboarding_head_report_operator_role_required/);
  assert.match(migration, /onboarding_head_activation_actor_not_tenant_admin/);
  assert.match(migration, /onboarding_head_idempotency_conflict/);
  assert.match(migration, /onboarding_head_revision_conflict/);
  assert.match(migration, /onboarding_head_control_revision_conflict/);
  assert.match(migration, /onboarding_head_kill_switch_is_one_way/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('RLS and grants provide read-only exact-tenant access', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FOR SELECT TO authenticated/);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
  assert.match(migration, /onboarding_head_requires_service_role/);
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)\b/i,
  );
});

test('rollback removes commands but preserves immutable evidence', () => {
  assert.match(rollback, /SET enabled = false/);
  assert.match(rollback, /execution_mode = 'disabled'/);
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]onboarding_head_report_rpc/);
  assert.match(
    rollback,
    /DROP FUNCTION IF EXISTS public[.]onboarding_customer_outcome_receipt_rpc/,
  );
  const withoutComments = rollback.replace(/--.*$/gm, '');
  assert.doesNotMatch(withoutComments, /DROP TABLE|DELETE FROM|TRUNCATE/i);
  assert.match(rollback, /immutable onboarding evidence survives rollback/i);
});

test('database proof covers authority, isolation, false outcome, lifecycle, and containment', () => {
  for (const expected of [
    'expected authenticated Onboarding Head RPC denial',
    'expected direct service-role write denial',
    'expected prohibited Onboarding Head authority denial',
    'expected Onboarding Head self-verification denial',
    'expected service outcome verification denial',
    'expected cross-tenant outcome verifier denial',
    'expected disabled Onboarding Head write denial',
    'expected cross-tenant Onboarding Head activation denial',
    'expected Onboarding Head agent identity denial',
    'expected cross-tenant Onboarding Head handoff denial',
    'expected false Onboarding Head customer outcome denial',
    'expected synthetic-achieved canonical receipt denial',
    'expected CustomerEmail evidence denial',
    'expected stale Onboarding Head revision denial',
    'expected Onboarding Head outcome-before-completion denial',
    'expected agent Onboarding Head approval denial',
    'expected immutable Onboarding Head evidence denial',
    'expected immutable canonical outcome receipt denial',
    'expected Onboarding Head kill switch denial',
  ]) assert.match(proof, new RegExp(expected));
});
