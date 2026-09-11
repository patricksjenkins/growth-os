'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  completedEtDay,
  buildCumulativeRevenueMetrics,
  buildCanonicalRevenueMetrics,
  deterministicUuid,
  revenueStage,
  reliabilityRpcArgs,
  sha256,
} = require('../worker/agents/supervised-executive-foundation')._internal;

test('formal Revenue report is one monotonic cumulative cohort, not daily leads plus invented zeros', () => {
  const metrics = buildCumulativeRevenueMetrics([
    { id: 'a', status: 'new_lead' },
    { id: 'b', lifecycle_stage: 'scored', estimate_amount: 100 },
    { id: 'c', status: 'demo_booked', estimate_amount: 500 },
    { id: 'd', status: 'quoted', estimate_amount: 900 },
    {
      id: 'e', status: 'won', final_revenue: 499,
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-11T00:00:00.000Z',
    },
    { id: 'f', status: 'lost' },
  ]);
  assert.deepEqual(metrics, {
    leadsCreated: 6,
    qualifiedLeads: 4,
    appointmentsBooked: 3,
    appointmentsHeld: 2,
    proposalsSent: 2,
    closedWon: 1,
    closedLost: 0,
    openPipelineMinor: 150000,
    bookedRevenueMinor: 49900,
    averageSalesCycleDays: 10,
  });
  assert.equal(revenueStage({ status: 'lost' }), 0, 'legacy loss does not prove a proposal');
});

test('completed report windows are stable Eastern calendar days', () => {
  const period = completedEtDay(new Date('2026-07-24T21:00:00.000Z'));
  assert.deepEqual(period, {
    startIso: '2026-07-23T04:00:00.000Z',
    endIso: '2026-07-24T04:00:00.000Z',
    startDate: '2026-07-23',
    endDate: '2026-07-23',
    dayKey: '2026-07-23',
  });
});

test('formal Revenue funnel requires each canonical milestone instead of promoting a later status', () => {
  const leads = [
    { id: 'a', lead_source: 'prospecting_agent', metadata: {}, created_at: '2026-07-01T00:00:00Z' },
    { id: 'b', lead_source: 'prospecting_agent', metadata: {}, estimate_amount: 500, created_at: '2026-07-01T00:00:00Z' },
    { id: 'c', lead_source: 'prospecting_agent', metadata: {}, estimate_amount: 900, final_revenue: 499, created_at: '2026-07-01T00:00:00Z' },
    { id: 'fixture', lead_source: 'prospecting_agent', metadata: { synthetic: true }, created_at: '2026-07-01T00:00:00Z' },
  ];
  const events = [
    { lead_id: 'a', event_type: 'current_won_state', stage: 'won', occurred_at: '2026-07-20T00:00:00Z' },
    { lead_id: 'b', event_type: 'prospect_qualified', stage: 'qualified', occurred_at: '2026-07-02T00:00:00Z' },
    { lead_id: 'c', event_type: 'prospect_qualified', stage: 'qualified', occurred_at: '2026-07-02T00:00:00Z' },
    { lead_id: 'c', event_type: 'demo_booked', stage: null, occurred_at: '2026-07-03T00:00:00Z' },
    { lead_id: 'c', event_type: 'demo_held_owner_verified', stage: 'demo_held', occurred_at: '2026-07-04T00:00:00Z' },
    { lead_id: 'c', event_type: 'proposal_sent_owner_verified', stage: 'proposal', occurred_at: '2026-07-05T00:00:00Z' },
    { lead_id: 'c', event_type: 'closed_won_owner_verified', stage: 'won', occurred_at: '2026-07-11T00:00:00Z' },
  ];
  assert.deepEqual(buildCanonicalRevenueMetrics({ leads, events }), {
    leadsCreated: 3,
    qualifiedLeads: 2,
    appointmentsBooked: 1,
    appointmentsHeld: 1,
    proposalsSent: 1,
    closedWon: 1,
    closedLost: 0,
    openPipelineMinor: 50000,
    bookedRevenueMinor: 49900,
    averageSalesCycleDays: 10,
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
