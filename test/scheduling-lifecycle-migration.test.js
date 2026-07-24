'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '078_scheduling_lifecycle_control.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'rollbacks', '078_scheduling_lifecycle_control_rollback.sql'),
  'utf8'
);

test('migration is additive, default-off, and permanently dispatch-free', () => {
  assert.match(migration, /enabled\s+boolean NOT NULL DEFAULT false/i);
  assert.match(migration, /kill_switch_engaged\s+boolean NOT NULL DEFAULT true/i);
  assert.match(migration, /provider_dispatch_enabled\s+boolean NOT NULL DEFAULT false[\s\S]*CHECK \(provider_dispatch_enabled = false\)/i);
  assert.match(migration, /scheduling_lifecycle_writes_disabled/i);
  assert.match(migration, /scheduling_lifecycle_kill_switch_engaged/i);
  assert.match(migration, /scheduling_lifecycle_dispatch_forbidden/i);
  assert.match(migration, /scheduling_lifecycle_kill_switch_rpc/i);
  assert.match(migration, /SET enabled = false,[\s\S]*execution_mode = 'disabled',[\s\S]*kill_switch_engaged = true/i);
  assert.doesNotMatch(migration, /\b(http|net\.|telnyx|twilio|resend|send_sms|send_email)\b/i);
});

test('all lifecycle mutations use a service-only atomic RPC', () => {
  assert.match(migration, /appointment_lifecycle_command_rpc/i);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/i);
  assert.match(migration, /appointment_lifecycle_requires_service_role/i);
  assert.match(migration, /FOR UPDATE/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /appointment_lifecycle_revision_conflict/i);
  assert.match(migration, /appointment_lifecycle_idempotency_conflict/i);
  assert.match(migration, /semantic_fingerprint/i);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.appointment_lifecycle_command_rpc[\s\S]*TO service_role/i);
});

test('tenant, evidence, actor, and transition guards fail closed', () => {
  assert.match(migration, /appointment_lifecycle_tenant_mismatch/i);
  assert.match(migration, /appointment_lifecycle_not_found_for_tenant/i);
  assert.match(migration, /appointment_lifecycle_human_not_tenant_owner/i);
  assert.match(migration, /appointment_lifecycle_evidence_required/i);
  assert.match(migration, /appointment_lifecycle_evidence_predates_appointment/i);
  assert.match(migration, /provider_receipt/i);
  assert.match(migration, /document_receipt/i);
  assert.match(migration, /completion_receipt/i);
  assert.match(migration, /appointment_lifecycle_transition_invalid/i);
});

test('lifecycle evidence is immutable and available only through tenant SELECT policy', () => {
  assert.match(migration, /trg_appointment_lifecycle_events_immutable/i);
  assert.match(migration, /autonomous_os_immutable_row/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FOR SELECT TO authenticated/i);
  assert.doesNotMatch(migration, /FOR (?:INSERT|UPDATE|DELETE|ALL) TO authenticated/i);
});

test('rollback disables commands and retains evidence tables', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.appointment_lifecycle_command_rpc/i);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.scheduling_lifecycle_kill_switch_rpc/i);
  assert.match(rollback, /SET enabled = false/i);
  assert.match(rollback, /kill_switch_engaged = true/i);
  assert.doesNotMatch(rollback, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});
