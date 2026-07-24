'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  completedUtcDay,
  deterministicUuid,
  reliabilityRpcArgs,
  sha256,
} = require('../worker/agents/supervised-executive-foundation')._internal;

test('completed report windows are stable and never include the current UTC day', () => {
  const period = completedUtcDay(new Date('2026-07-24T21:00:00.000Z'));
  assert.deepEqual(period, {
    startIso: '2026-07-23T00:00:00.000Z',
    endIso: '2026-07-24T00:00:00.000Z',
    startDate: '2026-07-23',
    endDate: '2026-07-23',
    dayKey: '2026-07-23',
  });
});

test('report identities are deterministic UUIDs and day-sensitive', () => {
  const a = deterministicUuid('reliability:tenant-a:2026-07-23');
  const b = deterministicUuid('reliability:tenant-a:2026-07-23');
  const c = deterministicUuid('reliability:tenant-a:2026-07-24');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test('Reliability RPC mapping cannot omit the explicit feature gate', () => {
  const args = reliabilityRpcArgs({
    tenantId: 'tenant',
    reportId: 'report',
    reportType: 'agent_operations',
    periodStart: 'start',
    periodEnd: 'end',
    executionHealthState: 'degraded',
    outcomeHealthState: 'unproven',
    outcomeVerified: false,
    kpiResults: [],
    reportBody: {},
    evidence: {},
    idempotencyKey: 'key',
    requestFingerprint: sha256('fingerprint'),
    actorType: 'agent',
    actorId: 'reliability-head-v1',
    authorityTier: 'department_head',
    expectedControlRevision: 0,
  });
  assert.equal(args.p_feature_gate_enabled, true);
  assert.equal(args.p_outcome_verified, false);
});

test('runtime source contains no outbound provider integration', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'worker',
      'agents',
      'supervised-executive-foundation.js',
    ),
    'utf8',
  );
  assert.doesNotMatch(source, /sendEmail\s*\(/);
  assert.doesNotMatch(source, /sendSms\s*\(/);
  assert.doesNotMatch(source, /placeCall\s*\(/);
  assert.doesNotMatch(source, /resend\.emails/);
  assert.doesNotMatch(source, /api\.telnyx\.com/);
});

test('runtime is registered and scheduled only behind the exact FGA write cohort', () => {
  const server = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'server.js'),
    'utf8',
  );
  const cron = fs.readFileSync(
    path.join(__dirname, '..', 'worker', 'scheduler', 'cron.js'),
    'utf8',
  );
  const featureFlags = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'core',
      'autonomous-os',
      'feature-flags.js',
    ),
    'utf8',
  );

  assert.match(server, /\['supervised-executive-foundation'/);
  assert.match(cron, /isFGAlike\(t\)/);
  assert.match(cron, /flags\.departmentHeadWrites\(\)/);
  assert.match(
    cron,
    /FGA_OS_DEPARTMENT_HEAD_WRITE_TENANT_ALLOWLIST/,
  );
  assert.match(
    featureFlags,
    /enabledOnlyWhenTrue\('FGA_OS_DEPARTMENT_HEAD_WRITES_ENABLED'\)/,
  );
});
