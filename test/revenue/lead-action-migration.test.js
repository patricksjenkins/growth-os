'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/084_lead_action_evidence_cohorts.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/084_lead_action_evidence_cohorts_rollback.sql'),
  'utf8',
);
const databaseProof = fs.readFileSync(
  path.join(ROOT, 'test/sql/lead-action-cohorts-negative.sql'),
  'utf8',
);

test('migration is additive, default-off, and structurally cannot send outreach', () => {
  assert.doesNotMatch(
    migration,
    /\b(ALTER|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?public[.]leads/i,
  );
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|telnyx[.]|twilio[.]|resend[.]|stripe[.])\b/i,
  );
  assert.match(migration, /enabled\s+boolean NOT NULL DEFAULT false/);
  assert.match(
    migration,
    /outreach_enabled[\s\S]*CHECK \(outreach_enabled = false\)/,
  );
  assert.match(
    migration,
    /provider_dispatch_enabled[\s\S]*CHECK \(provider_dispatch_enabled = false\)/,
  );
});

test('tenant, lead, action, and action type are exact immutable identity', () => {
  assert.match(
    migration,
    /UNIQUE \(id, tenant_id, lead_id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(lead_id, tenant_id\)[\s\S]*REFERENCES public[.]leads\(id, tenant_id\)/,
  );
  assert.match(
    migration,
    /action[.]id = p_lead_action_id[\s\S]*action[.]tenant_id = p_tenant_id[\s\S]*action[.]lead_id = p_lead_id[\s\S]*action[.]action_type = p_action_type/,
  );
  assert.match(migration, /lead_action_identity_is_immutable/);
});

test('assignment, acceptance, SLA, escalation, completion, and outcome have receipts', () => {
  for (const receipt of [
    'assigned',
    'accepted',
    'escalated',
    'completed',
    'outcome_observed',
    'outcome_unknown',
  ]) {
    assert.match(migration, new RegExp(`'${receipt}'`));
  }
  assert.match(migration, /due_at\s+timestamptz NOT NULL/);
  assert.match(migration, /outcome_due_at\s+timestamptz NOT NULL/);
  assert.match(migration, /escalated_after_due/);
  assert.match(migration, /completed_within_sla/);
  assert.match(migration, /trg_lead_action_receipts_immutable/);
  assert.match(migration, /lead_action_receipt_is_immutable/);
});

test('cohorts separate observed and unknown without claiming causality', () => {
  assert.match(migration, /observed_outcome_count/);
  assert.match(migration, /unknown_outcome_count/);
  assert.match(migration, /pending_outcome_count/);
  assert.match(
    migration,
    /observed_conversion_rate[\s\S]*descriptive_association_only/,
  );
  assert.match(migration, /false AS causal_claim/);
  assert.match(migration, /WITH \(security_invoker = true\)/);
  assert.doesNotMatch(migration, /\bcausal_conversion_rate\b/i);
});

test('no historical cohort dates can be supplied through the command', () => {
  assert.match(
    migration,
    /assigned_at\s+timestamptz NOT NULL DEFAULT now\(\)/,
  );
  assert.doesNotMatch(
    migration,
    /p_(assigned_at|cohort_month|cohort_date)\b/,
  );
  assert.match(migration, /date_trunc\('month', action[.]assigned_at\)/);
});

test('optimistic revision, idempotency, RLS, and direct-write denial are enforced', () => {
  assert.match(migration, /lead_action_revision_conflict/);
  assert.match(migration, /lead_action_idempotency_conflict/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/);
  assert.match(migration, /lead_action_kill_switch_engaged/);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*lead_action_receipts[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration,
    /CREATE POLICY[^;]*FOR (INSERT|UPDATE|DELETE)\b/i,
  );
});

test('command and kill switch RPCs are service-role-only', () => {
  assert.match(migration, /lead_action_requires_service_role/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public[.]lead_action_command_rpc[\s\S]*TO service_role/,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public[.]lead_action_kill_switch_rpc[\s\S]*TO service_role/,
  );
});

test('kill switch stores and returns only a digest of its reason', () => {
  assert.match(
    migration,
    /v_reason_digest := encode\([\s\S]*digest\([\s\S]*p_reason[\s\S]*'sha256'/,
  );
  assert.match(
    migration,
    /'kill_switch_reason_digest', v_reason_digest/,
  );
  assert.match(
    migration,
    /RETURN jsonb_build_object\([\s\S]*'outcome', 'contained'[\s\S]*'tenant_id', p_tenant_id[\s\S]*'revision', v_resulting_revision[\s\S]*'reason_digest', v_reason_digest/,
  );
  assert.doesNotMatch(
    migration,
    /'kill_switch_reason'\s*,\s*p_reason/,
  );
  assert.match(
    databaseProof,
    /kill switch reason plaintext was retained/,
  );
  assert.match(
    databaseProof,
    /kill switch response exposed reason plaintext/,
  );
});

test('rollback disables mutations and preserves evidence', () => {
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]lead_action_command_rpc/);
  const rollbackWithoutComments = rollback.replace(/--.*$/gm, '');
  assert.doesNotMatch(rollbackWithoutComments, /DROP (TABLE|VIEW)/i);
  assert.match(rollback, /immutable evidence and cohort[\s\S]*survive rollback/i);
});

test('database proof covers role, gate, cross-tenant, revision, receipt, and cohorts', () => {
  for (const expected of [
    'expected authenticated lead-action RPC denial',
    'expected disabled lead-action write denial',
    'expected causal lead-action evidence denial',
    'expected cross-tenant lead assignment denial',
    'expected cross-tenant action identity denial',
    'expected stale lead-action revision denial',
    'expected immutable lead-action receipt denial',
    'expected engaged lead-action kill switch denial',
    'tenant A cohort leaked tenant B evidence',
    'observed and unknown cohort counts were not separated',
  ]) {
    assert.match(databaseProof, new RegExp(expected));
  }
});
