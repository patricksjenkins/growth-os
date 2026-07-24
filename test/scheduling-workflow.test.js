'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  activationReadiness,
  appointmentIdempotencyKey,
  canTransition,
  validateScheduledWindow,
} = require('../core/scheduling/workflow');

test('appointment state machine cannot skip invitation, scheduling, or preparation', () => {
  assert.equal(canTransition('needed', 'scheduled'), false);
  assert.equal(canTransition('needed', 'invitation_ready'), true);
  assert.equal(canTransition('invitation_ready', 'invited'), true);
  assert.equal(canTransition('invited', 'scheduled'), true);
  assert.equal(canTransition('scheduled', 'completed'), false);
  assert.equal(canTransition('scheduled', 'prepared'), true);
  assert.equal(canTransition('prepared', 'completed'), true);
});

test('scheduled windows enforce notice and horizon without booking anything', () => {
  const now = new Date('2026-07-24T12:00:00.000Z');
  assert.deepEqual(validateScheduledWindow({
    start: '2026-07-24T12:30:00.000Z',
    end: '2026-07-24T13:00:00.000Z',
    now,
    policy: { minimum_notice_minutes: 120, maximum_days_ahead: 45 },
  }), { valid: false, errors: ['insufficient_notice'] });

  assert.deepEqual(validateScheduledWindow({
    start: '2026-07-25T12:00:00.000Z',
    end: '2026-07-25T12:30:00.000Z',
    now,
    policy: { minimum_notice_minutes: 120, maximum_days_ahead: 45 },
  }), { valid: true, errors: [] });
});

test('workflow identity is stable across retries', () => {
  const input = {
    tenantId: 'tenant-a',
    appointmentType: 'sales-demo',
    sourceType: 'lead',
    sourceId: 'lead-1',
  };
  assert.equal(appointmentIdempotencyKey(input), appointmentIdempotencyKey(input));
  assert.notEqual(
    appointmentIdempotencyKey({
      tenantId: 't',
      appointmentType: 'a:b',
      sourceType: 'c',
      sourceId: 'd',
    }),
    appointmentIdempotencyKey({
      tenantId: 't',
      appointmentType: 'a',
      sourceType: 'b:c',
      sourceId: 'd',
    })
  );
});

test('scheduled windows reject invalid policy numbers instead of bypassing limits', () => {
  const now = new Date('2026-07-24T12:00:00.000Z');
  const result = validateScheduledWindow({
    start: '2026-07-25T12:00:00.000Z',
    end: '2026-07-25T12:30:00.000Z',
    now,
    policy: {
      minimum_notice_minutes: 'not-a-number',
      maximum_days_ahead: 0,
    },
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, [
    'invalid_minimum_notice',
    'invalid_maximum_days_ahead',
    'too_far_ahead',
  ]);
});

test('calendar writes remain disabled until every activation dependency exists', () => {
  const blocked = activationReadiness({
    policy: { active: false, availability_rules: {} },
    providerConfigured: false,
    calendarAuthorized: false,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.mode, 'disabled');

  const ready = activationReadiness({
    policy: {
      active: true,
      timezone: 'America/New_York',
      provider: 'google',
      availability_rules: { weekdays: [1, 2, 3, 4, 5] },
    },
    providerConfigured: true,
    calendarAuthorized: true,
  });
  assert.deepEqual(ready, { ready: true, missing: [], mode: 'supervised' });
});

test('scheduling migration guards every cross-tenant reference even for service-role writes', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '070_scheduling_control.sql'),
    'utf8'
  );
  assert.match(sql, /appointment_workflows_tenant_guard/i);
  assert.match(sql, /appointment_events_tenant_guard/i);
  assert.match(sql, /id = NEW\.lead_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(sql, /id = NEW\.customer_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(sql, /id = NEW\.preparation_document_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(sql, /user_id = NEW\.owner_user_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(sql, /id = NEW\.appointment_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(sql, /SECURITY DEFINER SET search_path = public, pg_temp/i);
  assert.match(sql, /scheduled_end > scheduled_start/i);
  assert.match(sql, /uq_appointment_provider_event/i);
  assert.match(sql, /FOR SELECT TO authenticated/i);
  assert.doesNotMatch(sql, /FOR (INSERT|UPDATE|DELETE|ALL) TO authenticated/i);
});

test('scheduling rollback refuses to delete appointment evidence', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'rollbacks', '070_scheduling_control_rollback.sql'),
    'utf8'
  );
  assert.match(sql, /appointment data exists/i);
  assert.doesNotMatch(sql, /DROP TABLE[\s\S]{0,80}CASCADE/i);
});
