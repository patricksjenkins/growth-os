'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  commandEnvelope,
  planSchedulingLifecycle,
} = require('../core/scheduling/lifecycle-planner');

const BASE = Object.freeze({
  tenantId: 'tenant-a',
  now: '2026-07-24T14:00:00.000Z',
  appointment: {
    id: 'appointment-a',
    tenant_id: 'tenant-a',
    status: 'needed',
    follow_up_due_at: null,
  },
  lifecycle: {
    tenant_id: 'tenant-a',
    lifecycle_state: 'needed',
    revision: 0,
  },
  control: {
    tenant_id: 'tenant-a',
    enabled: true,
    execution_mode: 'shadow',
    kill_switch_engaged: false,
    provider_dispatch_enabled: false,
  },
  policy: {
    id: 'policy-a',
    active: true,
    provider: 'calendly',
    timezone: 'America/New_York',
    availability_rules: { weekdays: [1, 2, 3, 4, 5] },
  },
  providerConfigured: true,
  calendarAuthorized: true,
});

function plan(overrides = {}) {
  return planSchedulingLifecycle({
    ...BASE,
    ...overrides,
    appointment: { ...BASE.appointment, ...(overrides.appointment || {}) },
    lifecycle: { ...BASE.lifecycle, ...(overrides.lifecycle || {}) },
    control: { ...BASE.control, ...(overrides.control || {}) },
    policy: { ...BASE.policy, ...(overrides.policy || {}) },
  });
}

test('planner emits invitation-ready command only when every readiness gate passes', () => {
  const result = plan();
  assert.equal(result.decision, 'command');
  assert.equal(result.command.action, 'mark_invitation_ready');
  assert.match(result.command.idempotencyKey, /^appointment-lifecycle:v1:[a-f0-9]{64}$/);
  assert.equal(result.command.evidence.source_type, 'policy_evaluation');

  const blocked = plan({ calendarAuthorized: false });
  assert.deepEqual(blocked, {
    decision: 'blocked',
    reason: 'invitation_not_ready',
    details: ['calendar_authorization'],
  });
});

test('planner fails closed on tenant mismatch, disabled mode, and kill switch', () => {
  assert.equal(plan({
    appointment: { tenant_id: 'tenant-b' },
  }).reason, 'tenant_mismatch');
  assert.equal(plan({
    control: { enabled: false },
  }).reason, 'automation_disabled');
  assert.equal(plan({
    control: { kill_switch_engaged: true },
  }).reason, 'kill_switch_engaged');
  assert.equal(plan({
    control: { provider_dispatch_enabled: true },
  }).reason, 'planner_cannot_dispatch');
});

test('invitation cannot become invited without an authoritative delivery receipt', () => {
  const appointment = { status: 'invitation_ready' };
  const lifecycle = { lifecycle_state: 'invitation_ready', revision: 2 };
  assert.equal(plan({ appointment, lifecycle }).reason,
    'invitation_delivery_receipt_required');

  const result = plan({
    appointment,
    lifecycle,
    receipts: { invitationDelivered: { id: 'calendly-delivery-1' } },
  });
  assert.equal(result.decision, 'command');
  assert.equal(result.command.action, 'record_invitation_delivery');
  assert.equal(result.command.expectedRevision, 2);
  assert.equal(result.command.evidence.source_type, 'provider_receipt');
});

test('scheduled projection requires booking evidence before lifecycle synchronization', () => {
  const appointment = { status: 'scheduled' };
  const lifecycle = { lifecycle_state: 'invited', revision: 3 };
  assert.equal(plan({ appointment, lifecycle }).reason, 'booking_receipt_required');

  const result = plan({
    appointment,
    lifecycle,
    receipts: { booking: { id: 'calendar-event-1' } },
  });
  assert.equal(result.command.action, 'synchronize_booking');
});

test('due reminder is a command recommendation and never a send action', () => {
  const result = plan({
    appointment: { status: 'scheduled' },
    lifecycle: {
      lifecycle_state: 'scheduled',
      revision: 4,
      next_reminder_at: '2026-07-24T13:55:00.000Z',
    },
  });
  assert.equal(result.command.action, 'mark_reminder_due');
  assert.doesNotMatch(JSON.stringify(result), /\b(send|dispatch|telnyx|email)\b/i);
});

test('reschedule, preparation, completion, and follow-up require source evidence', () => {
  assert.equal(plan({
    appointment: { status: 'scheduled' },
    lifecycle: { lifecycle_state: 'scheduled', revision: 1 },
    receipts: { providerCancellation: { id: 'cancel-1' } },
  }).command.action, 'mark_reschedule_needed');

  assert.equal(plan({
    appointment: { status: 'scheduled' },
    lifecycle: { lifecycle_state: 'scheduled', revision: 1 },
    receipts: { preparation: { id: 'document-version-1' } },
  }).command.action, 'mark_prepared');

  assert.equal(plan({
    appointment: { status: 'prepared' },
    lifecycle: { lifecycle_state: 'prepared', revision: 2 },
    receipts: { completion: { id: 'meeting-outcome-1' } },
  }).command.action, 'mark_completed');

  const followUp = plan({
    appointment: {
      status: 'completed',
      follow_up_due_at: '2026-07-24T13:00:00.000Z',
    },
    lifecycle: { lifecycle_state: 'completed', revision: 3 },
  });
  assert.equal(followUp.command.action, 'mark_follow_up_due');
  assert.equal(followUp.command.evidence.source_type, 'system_clock');
});

test('command envelope is deterministic and collision-safe across structured fields', () => {
  const base = {
    tenantId: 'tenant-a',
    appointmentId: 'appointment-a',
    action: 'raise_exception',
    expectedRevision: 4,
    evidence: {
      source_type: 'operator_decision',
      source_id: 'decision-a',
      observed_at: '2026-07-24T14:00:00.000Z',
    },
  };
  assert.deepEqual(commandEnvelope(base), commandEnvelope({
    ...base,
    evidence: {
      observed_at: '2026-07-24T14:00:00.000Z',
      source_id: 'decision-a',
      source_type: 'operator_decision',
    },
  }));
  assert.notEqual(
    commandEnvelope(base).requestFingerprint,
    commandEnvelope({ ...base, tenantId: 'tenant-b' }).requestFingerprint
  );
});

test('terminal and exception states never advance autonomously', () => {
  assert.deepEqual(plan({
    appointment: { status: 'cancelled' },
  }), { decision: 'noop', reason: 'terminal_booking_state' });
  assert.equal(plan({
    lifecycle: { lifecycle_state: 'exception' },
  }).reason, 'exception_requires_resolution');
});

test('a verified cancellation can request rescheduling without rewriting history', () => {
  const result = plan({
    appointment: { status: 'cancelled' },
    lifecycle: { lifecycle_state: 'cancelled', revision: 5 },
    receipts: { providerCancellation: { id: 'provider-cancel-1' } },
  });
  assert.equal(result.command.action, 'mark_reschedule_needed');
  assert.equal(result.command.evidence.source_type, 'provider_receipt');
});

test('an elapsed unresolved appointment becomes an evidence-backed exception command', () => {
  const result = plan({
    appointment: {
      status: 'scheduled',
      scheduled_end: '2026-07-24T13:00:00.000Z',
    },
    lifecycle: {
      lifecycle_state: 'scheduled',
      revision: 7,
    },
  });
  assert.equal(result.command.action, 'raise_exception');
  assert.equal(
    result.command.exceptionCode,
    'appointment_window_elapsed_unresolved'
  );
});
