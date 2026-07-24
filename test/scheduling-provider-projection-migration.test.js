'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '077_calendly_appointment_projection.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(root, 'db', 'rollbacks', '077_calendly_appointment_projection_rollback.sql'),
  'utf8'
);

test('provider projection is default-off and service-role-only', () => {
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/i);
  assert.match(migration, /scheduling_writes_disabled/i);
  assert.match(migration, /appointment_projection_requires_service_role/i);
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION public\.appointment_provider_event_rpc[\s\S]*FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.appointment_provider_event_rpc[\s\S]*TO service_role/i
  );
});

test('projection is tenant-bound, locked, idempotent, and PII-minimal', () => {
  assert.match(migration, /lead\.tenant_id = p_tenant_id/i);
  assert.match(migration, /workflow\.tenant_id = p_tenant_id[\s\S]*FOR UPDATE/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /appointment_event_idempotency_conflict/i);
  assert.match(migration, /'outcome', 'replay'/i);
  assert.doesNotMatch(migration, /\binvitee_(?:name|email)\b/i);
  assert.doesNotMatch(migration, /\braw_payload\b/i);
});

test('booking and cancellation preserve terminal history', () => {
  assert.match(migration, /p_event_type NOT IN \('booked', 'cancelled'\)/i);
  assert.match(migration, /appointment_provider_event_not_found_for_tenant/i);
  assert.match(migration, /appointment_terminal_history_cannot_be_cancelled/i);
  assert.match(migration, /v_workflow\.status <> 'scheduled'/i);
  assert.match(migration, /'provider_booked'/i);
  assert.match(migration, /'provider_cancelled'/i);
});

test('service mutations use the RPC and appointment events are immutable', () => {
  assert.match(migration, /trg_appointment_events_immutable/i);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*appointment_workflows[\s\S]*appointment_events[\s\S]*FROM service_role/i
  );
});

test('rollback removes only the projection and retains scheduling data', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.appointment_provider_event_rpc/i);
  assert.match(rollback, /DROP TRIGGER IF EXISTS trg_appointment_events_immutable/i);
  assert.doesNotMatch(rollback, /\b(?:DROP\s+TABLE|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i);
});
