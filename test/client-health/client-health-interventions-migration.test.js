'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/083_client_health_interventions.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/083_client_health_interventions_rollback.sql'),
  'utf8'
);
const databaseProof = fs.readFileSync(
  path.join(ROOT, 'test/sql/client-health-interventions-negative.sql'),
  'utf8'
);

test('migration is additive, default-off, and cannot send or call providers', () => {
  assert.match(migration, /enabled\s+boolean NOT NULL DEFAULT false/i);
  assert.match(migration, /kill_switch_engaged\s+boolean NOT NULL DEFAULT true/i);
  assert.match(
    migration,
    /customer_communications_enabled[\s\S]*CHECK \(customer_communications_enabled = false\)/i
  );
  assert.match(
    migration,
    /provider_actions_enabled[\s\S]*CHECK \(provider_actions_enabled = false\)/i
  );
  assert.match(migration, /client_health_external_action_forbidden/i);
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|telnyx[.]|twilio[.]|resend[.]|send_sms|send_email)\b/i
  );
  assert.doesNotMatch(
    migration,
    /\b(ALTER|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?public[.]client_health_scores/i
  );
});

test('enabled activation requires same-tenant privileged membership and structured evidence', () => {
  assert.match(
    migration,
    /jsonb_typeof\(NEW[.]activation_evidence\) <> 'object'[\s\S]*NEW[.]activation_evidence = '\{\}'::jsonb/
  );
  assert.match(
    migration,
    /tenant_user[.]tenant_id = NEW[.]tenant_id[\s\S]*tenant_user[.]user_id = NEW[.]activated_by/
  );
  for (const role of [
    'owner',
    'platform_owner',
    'founder',
    'admin',
    'client_owner',
    'tenant_owner',
  ]) {
    assert.match(migration, new RegExp(`'${role}'`));
  }
  assert.match(migration, /client_health_activation_actor_not_tenant_admin/);
});

test('exact tenant and customer identity is enforced end to end', () => {
  assert.match(
    migration,
    /FOREIGN KEY \(source_signal_snapshot_id, tenant_id, customer_id\)/
  );
  assert.match(
    migration,
    /FOREIGN KEY \(intervention_id, tenant_id, customer_id\)/
  );
  assert.match(
    migration,
    /customer[.]id = p_customer_id[\s\S]*customer[.]tenant_id = p_tenant_id/
  );
  assert.match(migration, /client_health_customer_not_found_for_tenant/);
  assert.match(migration, /client_health_intervention_not_found_for_identity/);
  assert.match(migration, /client_health_signal_not_found_for_identity/);
});

test('heuristic signals cannot be presented as outcome evidence', () => {
  assert.match(
    migration,
    /signal_state IN \([\s\S]*'unknown', 'unproven', 'at_risk', 'stable'/
  );
  assert.match(
    migration,
    /provenance_type = 'heuristic' AND outcome_evidence_eligible = false/
  );
  assert.match(
    migration,
    /NOT \(provenance_type = 'heuristic' AND signal_state = 'stable'\)/
  );
  assert.match(
    migration,
    /outcome_state\s+text NOT NULL DEFAULT 'unknown'/
  );
  assert.match(
    migration,
    /lifecycle_state = 'action_completed'[\s\S]*outcome_state = 'unproven'/
  );
  assert.match(
    migration,
    /p_evidence->>'source_type' <> 'client_outcome_receipt'/
  );
  assert.match(migration, /client_health_outcome_evidence_required/);
});

test('signals, actions, and outcomes retain immutable evidence', () => {
  assert.match(migration, /trg_client_health_signal_snapshots_immutable/);
  assert.match(migration, /trg_client_health_intervention_events_immutable/);
  assert.match(migration, /client_health_evidence_is_immutable/);
  assert.match(migration, /completion_evidence_digest/);
  assert.match(migration, /outcome_evidence_digest/);
  assert.match(migration, /outcome_observed_at/);
});

test('intervention contract includes assignment, acceptance, SLA, escalation, and completion', () => {
  assert.match(migration, /owner_id\s+uuid NOT NULL/);
  assert.match(migration, /assignee_id\s+uuid NOT NULL/);
  assert.match(migration, /assigned_at\s+timestamptz NOT NULL/);
  assert.match(migration, /accepted_at\s+timestamptz/);
  assert.match(migration, /sla_due_at\s+timestamptz NOT NULL/);
  assert.match(migration, /escalated_at\s+timestamptz/);
  assert.match(migration, /action_completed_at\s+timestamptz/);
  assert.match(migration, /client_health_assignment_tenant_mismatch/);
});

test('writes require exact control revision, optimistic revision, idempotency, and service role', () => {
  assert.match(migration, /p_expected_control_revision bigint/);
  assert.match(migration, /client_health_control_revision_conflict/);
  assert.match(migration, /client_health_revision_conflict/);
  assert.match(migration, /client_health_idempotency_conflict/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/);
  assert.match(migration, /client_health_requires_service_role/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public[.]client_health_intervention_command_rpc[\s\S]*TO service_role/
  );
});

test('RLS provides read-only exact-tenant access and no authenticated writes', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FOR SELECT TO authenticated/);
  assert.match(
    migration,
    /auth[.]jwt\(\)->''app_metadata''->>''tenant_id''/
  );
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE|ALL)\b/i
  );
});

test('rollback disables commands while preserving evidence', () => {
  assert.match(rollback, /SET enabled = false/);
  assert.match(rollback, /execution_mode = 'disabled'/);
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(
    rollback,
    /DROP FUNCTION IF EXISTS public[.]client_health_intervention_command_rpc/
  );
  const rollbackWithoutComments = rollback.replace(/--.*$/gm, '');
  assert.doesNotMatch(rollbackWithoutComments, /DROP TABLE|DELETE FROM|TRUNCATE/i);
  assert.match(rollback, /immutable evidence survives rollback/i);
});

test('database proof covers role, gate, tenant, revision, false-green, and immutability negatives', () => {
  for (const expected of [
    'expected authenticated client-health RPC denial',
    'expected cross-tenant client-health activation denial',
    'expected non-member client-health activation denial',
    'expected malformed client-health activation evidence denial',
    'expected disabled client-health write denial',
    'expected cross-tenant customer denial',
    'expected cross-tenant signal denial',
    'expected exact-tenant client-health RLS visibility',
    'expected stale client-health revision denial',
    'expected heuristic stable signal denial',
    'expected outcome without completion denial',
    'expected immutable client-health evidence denial',
    'expected engaged client-health kill switch denial',
  ]) {
    assert.match(databaseProof, new RegExp(expected));
  }
});
