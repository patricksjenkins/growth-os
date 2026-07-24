'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/085_reliability_department_head.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/085_reliability_department_head_rollback.sql'),
  'utf8'
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/reliability-department-head-negative.sql'),
  'utf8'
);

test('charter defines mission, measurable KPIs, report types, and explicit authority', () => {
  assert.match(migration, /mission\s+text NOT NULL/);
  for (const kpi of [
    'incident_detection_to_ack_minutes',
    'tenant_isolation_gate_pass_rate',
    'verified_recovery_rate',
    'agent_business_outcome_rate',
    'audit_evidence_completeness',
    'sla_compliance_rate',
  ]) {
    assert.match(migration, new RegExp(`'${kpi}'`));
  }
  for (const reportType of ['reliability', 'security', 'agent_operations']) {
    assert.match(migration, new RegExp(`'${reportType}'`));
  }
  assert.match(migration, /authority_contract\s+jsonb NOT NULL/);
});

test('foundation is default-off, read-only supervised, and structurally contained', () => {
  assert.match(migration, /enabled\s+boolean NOT NULL DEFAULT false/);
  assert.match(migration, /execution_mode\s+text NOT NULL DEFAULT 'disabled'/);
  assert.match(migration, /'shadow', 'supervised_readonly'/);
  assert.match(migration, /kill_switch_engaged\s+boolean NOT NULL DEFAULT true/);
  for (const authority of [
    'operational_write_authority',
    'production_change_authority',
    'provider_action_authority',
    'customer_communication_authority',
    'money_movement_authority',
  ]) {
    assert.match(
      migration,
      new RegExp(`${authority}[\\s\\S]*CHECK \\(${authority} = false\\)`)
    );
  }
  assert.match(migration, /reliability_head_prohibited_authority/);
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|telnyx[.]|twilio[.]|resend[.]|send_sms|send_email)\b/i
  );
});

test('reports separate execution health from evidence-backed outcome health', () => {
  assert.match(migration, /execution_health_state/);
  assert.match(migration, /outcome_health_state/);
  assert.match(migration, /outcome_verified/);
  assert.match(migration, /reliability_head_false_green_forbidden/);
  assert.match(
    migration,
    /result->>'verification_state' <> 'verified'[\s\S]*result->>'evidence_ref'/
  );
  assert.match(migration, /reliability_head_unproven_outcome_cannot_be_verified/);
});

test('goals, work, decisions, exceptions, and evidence are durable', () => {
  for (const type of ['goal', 'work', 'decision', 'exception']) {
    assert.match(migration, new RegExp(`'${type}'`));
  }
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public[.]reliability_head_events/);
  assert.match(migration, /trg_reliability_head_reports_immutable/);
  assert.match(migration, /trg_reliability_head_events_immutable/);
  assert.match(migration, /reliability_head_evidence_is_immutable/);
});

test('work has assignment, acceptance, SLA, escalation, completion, and outcome contracts', () => {
  assert.match(migration, /owner_id\s+uuid NOT NULL/);
  assert.match(migration, /assignee_id\s+uuid/);
  assert.match(migration, /assigned_at\s+timestamptz/);
  assert.match(migration, /accepted_at\s+timestamptz/);
  assert.match(migration, /sla_due_at\s+timestamptz NOT NULL/);
  assert.match(migration, /escalated_at\s+timestamptz/);
  assert.match(migration, /completed_at\s+timestamptz/);
  assert.match(migration, /completion_evidence_digest/);
  assert.match(migration, /outcome_evidence_digest/);
  assert.match(migration, /business_outcome_receipt/);
});

test('tenant, role, agent identity, idempotency, revision, and kill switch fail closed', () => {
  assert.match(
    migration,
    /tenant_user[.]tenant_id = NEW[.]tenant_id[\s\S]*tenant_user[.]user_id = NEW[.]activated_by/
  );
  assert.match(migration, /reliability_head_activation_actor_not_tenant_admin/);
  assert.match(migration, /reliability_head_agent_identity_mismatch/);
  assert.match(migration, /reliability_head_owner_role_required/);
  assert.match(migration, /reliability_head_report_operator_role_required/);
  assert.match(migration, /reliability_head_action_authority_denied/);
  assert.match(migration, /reliability_head_idempotency_conflict/);
  assert.match(migration, /reliability_head_revision_conflict/);
  assert.match(migration, /reliability_head_control_revision_conflict/);
  assert.match(migration, /reliability_head_kill_switch_is_one_way/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('direct writes are denied and RPCs are service-role-only', () => {
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
  );
  assert.match(migration, /reliability_head_requires_service_role/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public[.]reliability_head_case_command_rpc[\s\S]*TO service_role/
  );
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)\b/i
  );
});

test('rollback disables commands and preserves executive evidence', () => {
  assert.match(rollback, /SET enabled = false/);
  assert.match(rollback, /execution_mode = 'disabled'/);
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]reliability_head_report_rpc/);
  const withoutComments = rollback.replace(/--.*$/gm, '');
  assert.doesNotMatch(withoutComments, /DROP TABLE|DELETE FROM|TRUNCATE/i);
  assert.match(rollback, /immutable executive evidence survives rollback/i);
});

test('database proof covers isolation, authority, false-green, lifecycle, and rollback controls', () => {
  for (const expected of [
    'expected authenticated Reliability Head RPC denial',
    'expected disabled Reliability Head write denial',
    'expected cross-tenant Reliability Head activation denial',
    'expected Reliability Head agent identity denial',
    'expected Reliability Head false-green denial',
    'expected cross-tenant Reliability Head report denial',
    'expected agent decision approval denial',
    'expected stale Reliability Head revision denial',
    'expected Reliability Head outcome-before-completion denial',
    'expected immutable Reliability Head evidence denial',
    'expected Reliability Head kill switch denial',
  ]) {
    assert.match(proof, new RegExp(expected));
  }
});
