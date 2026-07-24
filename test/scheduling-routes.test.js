'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = require('../api/routes/scheduling');

const {
  appointmentProjection,
  parseSchedulingQuery,
  policyProjection,
  requireSchedulingRead,
} = route._internal;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'eeeeeeee-1111-4111-8111-111111111111';

function withSchedulingGate({ enabled, cohort = TENANT_A }, fn) {
  const flagKey = 'FGA_OS_SCHEDULING_CENTER_API_ENABLED';
  const cohortKey = 'FGA_OS_SCHEDULING_CENTER_TENANT_ALLOWLIST';
  const previousFlag = process.env[flagKey];
  const previousCohort = process.env[cohortKey];
  try {
    if (enabled === undefined) delete process.env[flagKey];
    else process.env[flagKey] = enabled;
    process.env[cohortKey] = cohort;
    return fn();
  } finally {
    if (previousFlag === undefined) delete process.env[flagKey];
    else process.env[flagKey] = previousFlag;
    if (previousCohort === undefined) delete process.env[cohortKey];
    else process.env[cohortKey] = previousCohort;
  }
}

function invokeGate({ tenantId = TENANT_A, appTenantId = TENANT_A, role = 'tenant_owner' } = {}) {
  const result = { status: null, next: false };
  withSchedulingGate({ enabled: 'true' }, () => requireSchedulingRead({
    tenantId,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: appTenantId, role } },
  }, {
    status(code) { result.status = code; return this; },
    json() { return this; },
  }, () => { result.next = true; }));
  return result;
}

test('scheduling filters are allowlisted and bounded', () => {
  assert.deepEqual(parseSchedulingQuery({ status: 'scheduled', limit: '500' }), {
    valid: true,
    value: { status: 'scheduled', limit: 100 },
  });
  assert.equal(parseSchedulingQuery({ status: 'calendar_pending' }).valid, false);
});

test('Scheduling Center is hidden unless global flag and exact tenant cohort agree', () => {
  const result = { status: null, next: false };
  const req = {
    tenantId: TENANT_A,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: TENANT_A, role: 'tenant_owner' } },
  };
  const res = {
    status(code) { result.status = code; return this; },
    json() { return this; },
  };
  withSchedulingGate({ enabled: undefined }, () => (
    requireSchedulingRead(req, res, () => { result.next = true; })
  ));
  assert.equal(result.status, 404);
  assert.equal(result.next, false);
  withSchedulingGate({ enabled: 'true', cohort: TENANT_B }, () => (
    requireSchedulingRead(req, res, () => { result.next = true; })
  ));
  assert.equal(result.next, false);
});

test('same-tenant owner may read while role and tenant conflicts fail closed', () => {
  assert.deepEqual(invokeGate(), { status: null, next: true });
  assert.deepEqual(invokeGate({ role: 'member' }), { status: 403, next: false });
  assert.deepEqual(
    invokeGate({ tenantId: TENANT_A, appTenantId: TENANT_B }),
    { status: 403, next: false },
  );
});

test('public scheduling projections omit calendar references, booking URLs, and idempotency keys', () => {
  const policy = policyProjection({
    id: 'policy-1',
    tenant_id: TENANT_A,
    policy_key: 'default',
    timezone: 'America/New_York',
    provider: 'fga_fixed_availability',
    provider_calendar_ref: 'must-not-leak',
    availability_rules: { windows: [{ day: 'sat' }] },
    minimum_notice_minutes: 120,
    buffer_before_minutes: 15,
    buffer_after_minutes: 15,
    maximum_days_ahead: 45,
    reminder_policy: { offsets: [1440] },
    active: true,
    updated_at: '2026-07-24T20:00:00Z',
  });
  const appointment = appointmentProjection({
    id: 'appointment-1',
    tenant_id: TENANT_A,
    policy_id: 'policy-1',
    lead_id: null,
    customer_id: null,
    appointment_type: 'onboarding',
    status: 'needed',
    provider: 'fga_fixed_availability',
    provider_booking_url: 'must-not-leak',
    idempotency_key: 'must-not-leak',
    scheduled_start: null,
    scheduled_end: null,
    attendee_timezone: null,
    preparation_document_id: null,
    outcome_code: null,
    follow_up_due_at: null,
    exception_reason: null,
    created_at: '2026-07-24T20:00:00Z',
    updated_at: '2026-07-24T20:00:00Z',
  });
  assert.equal(policy.fixed_window_count, 1);
  assert.equal(policy.provider_calendar_ref, undefined);
  assert.equal(appointment.provider_booking_url, undefined);
  assert.equal(appointment.idempotency_key, undefined);
});

test('scheduling route mounts below tenant auth/tripwire and exposes no mutations or service client', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.js'), 'utf8');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'routes', 'scheduling.js'),
    'utf8',
  );
  const authMount = server.indexOf("app.use('/api', authMiddleware, tenantMiddleware);");
  const tripwire = server.indexOf(
    "app.use('/api', require('./middleware/cross-tenant-tripwire'));",
  );
  const scheduling = server.indexOf(
    "app.use('/api/scheduling', require('./routes/scheduling'));",
  );
  assert.ok(authMount >= 0 && tripwire > authMount && scheduling > tripwire);
  assert.doesNotMatch(source, /router\.(post|put|patch|delete)\(/);
  assert.doesNotMatch(source, /getServiceClient/);
  assert.doesNotMatch(source, /provider_booking_url.*select/);
  assert.doesNotMatch(source, /provider_calendar_ref.*select/);
});
