'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  activationReadiness,
  normalizeCalendlyEvent,
} = require('../core/scheduling/calendly-adapter');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_ID = '22222222-2222-4222-8222-222222222222';

test('Calendly booking normalization excludes invitee PII and is retry-stable', () => {
  const input = {
    tenantId: TENANT_ID,
    eventType: 'invitee.created',
    leadId: LEAD_ID,
    payload: {
      invitee: {
        name: 'Must not persist',
        email: 'must-not-persist@example.test',
      },
      event: {
        uri: 'https://api.calendly.com/scheduled_events/fixture-1',
        start_time: '2026-07-25T18:00:00.000Z',
        end_time: '2026-07-25T18:30:00.000Z',
      },
    },
  };
  const first = normalizeCalendlyEvent(input);
  const retry = normalizeCalendlyEvent(input);

  assert.equal(first.ok, true);
  assert.deepEqual(first, retry);
  assert.equal(first.event.tenant_id, TENANT_ID);
  assert.equal(first.event.lead_id, LEAD_ID);
  assert.equal(first.event.event_type, 'booked');
  assert.equal(JSON.stringify(first).includes('Must not persist'), false);
  assert.equal(JSON.stringify(first).includes('must-not-persist@example.test'), false);
});

test('duration derives an end time without accepting an invalid window', () => {
  const result = normalizeCalendlyEvent({
    tenantId: TENANT_ID,
    eventType: 'invitee.created',
    payload: {
      event: {
        uri: 'https://api.calendly.com/scheduled_events/fixture-2',
        start_time: '2026-07-25T18:00:00.000Z',
        duration: 25,
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.scheduled_end, '2026-07-25T18:25:00.000Z');
});

test('cancellation needs only the stable provider event identity', () => {
  const result = normalizeCalendlyEvent({
    tenantId: TENANT_ID,
    eventType: 'invitee.canceled',
    payload: {
      event: { uri: 'https://api.calendly.com/scheduled_events/fixture-1' },
      invitee: { email: 'ignored@example.test' },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.event_type, 'cancelled');
  assert.equal(result.event.scheduled_start, null);
  assert.equal(JSON.stringify(result).includes('ignored@example.test'), false);
});

test('malformed or unsupported provider events fail closed', () => {
  const result = normalizeCalendlyEvent({
    tenantId: 'wrong-tenant',
    eventType: 'invitee.rescheduled',
    payload: {},
    leadId: 'wrong-lead',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'tenant_id_invalid',
    'event_type_unsupported',
    'lead_id_invalid',
    'provider_event_id_invalid',
  ]);
});

test('activation stays disabled until provider, policy, cohort, and identity agree', () => {
  assert.deepEqual(activationReadiness({}), {
    ready: false,
    mode: 'disabled',
    missing: [
      'scheduling_write_flag',
      'exact_tenant_cohort',
      'active_policy',
      'calendly_policy',
      'availability_rules',
      'active_calendly_integration',
      'calendly_webhook_verification',
      'calendly_booking_url',
      'tenant_outbound_identity',
    ],
  });

  assert.deepEqual(activationReadiness({
    schedulingFlag: true,
    tenantInCohort: true,
    policy: {
      active: true,
      provider: 'calendly',
      availability_rules: { weekdays: ['monday'] },
    },
    integration: {
      active: true,
      webhookVerified: true,
      bookingUrlConfigured: true,
    },
    outboundIdentityReady: true,
  }), {
    ready: true,
    mode: 'supervised',
    missing: [],
  });
});
