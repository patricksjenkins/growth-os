'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ChiefOfStaffPlanningError,
  planDepartmentReportCommand,
  planChiefOfStaffCommand,
  verifyPlanFingerprint,
} = require('../../core/executive/chief-of-staff-planner');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = 'eeeeeeee-1111-4111-8111-111111111111';
const CYCLE = '87999999-1111-4111-8111-111111111111';
const RELIABILITY = '87333333-1111-4111-8111-111111111111';
const REVENUE = '87444444-1111-4111-8111-111111111111';

function cycle(overrides = {}) {
  return {
    tenantId: TENANT,
    cycleId: CYCLE,
    command: 'open_cycle',
    reportingPeriodStart: '2026-07-01',
    reportingPeriodEnd: '2026-07-31',
    reliabilityReportId: RELIABILITY,
    revenueReportId: REVENUE,
    expectedRevision: 0,
    idempotencyKey: 'cos:cycle:open:2026-07',
    actorType: 'service',
    actorId: 'chief-of-staff-shadow',
    authorityTier: 'chief_of_staff',
    evidence: {
      source_type: 'accepted_report_manifest',
      source_id: 'synthetic-2026-07',
      observed_at: '2026-07-31T12:00:00Z',
    },
    ...overrides,
  };
}

test('plans deterministic default-off supervised coordination with exact gates', () => {
  const first = planChiefOfStaffCommand(cycle());
  const second = planChiefOfStaffCommand(cycle());

  assert.equal(first.rpc, 'chief_of_staff_command_rpc');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.equal(first.args.p_reliability_report_id, RELIABILITY);
  assert.equal(first.args.p_revenue_report_id, REVENUE);
  assert.equal(first.args.p_request_fingerprint, second.args.p_request_fingerprint);
  assert.equal(verifyPlanFingerprint(first), true);
  assert.deepEqual(first.safety, {
    executionMode: 'supervised_read_only',
    requiredAcceptedReports: [
      'reliability_security_agent_ops',
      'revenue_sales',
    ],
    productionActionsAllowed: false,
    performsIo: false,
  });
});

test('report acceptance planning requires a human tenant owner', () => {
  const plan = planDepartmentReportCommand({
    tenantId: TENANT,
    command: 'accept_report',
    department: 'revenue_sales',
    contractId: '87222222-1111-4111-8111-111111111111',
    contractVersion: 1,
    schemaDigest: 'a'.repeat(64),
    reportId: REVENUE,
    sourceDepartmentReportId: '86cccccc-1111-4111-8111-111111111111',
    reportingPeriodStart: '2026-07-01',
    reportingPeriodEnd: '2026-07-31',
    reportDigest: 'b'.repeat(64),
    outcomeHealth: 'unknown',
    structuredSummary: {},
    expectedRevision: 1,
    idempotencyKey: 'cos:report:accept:revenue:2026-07',
    actorType: 'human',
    actorId: OWNER,
    authorityTier: 'owner',
    evidence: {
      source_type: 'owner_report_acceptance',
      source_id: 'synthetic-revenue-2026-07',
      observed_at: '2026-07-31T12:00:00Z',
    },
  });
  assert.equal(plan.rpc, 'cos_report_command_rpc');
  assert.equal(plan.args.p_feature_gate_enabled, false);
  assert.equal(verifyPlanFingerprint(plan), true);

  assert.throws(
    () => planDepartmentReportCommand({
      ...plan.args,
      tenantId: TENANT,
      command: 'accept_report',
      department: 'revenue_sales',
      contractId: '87222222-1111-4111-8111-111111111111',
      contractVersion: 1,
      schemaDigest: 'a'.repeat(64),
      reportId: REVENUE,
      sourceDepartmentReportId: '86cccccc-1111-4111-8111-111111111111',
      reportingPeriodStart: '2026-07-01',
      reportingPeriodEnd: '2026-07-31',
      reportDigest: 'b'.repeat(64),
      outcomeHealth: 'unknown',
      structuredSummary: {},
      expectedRevision: 1,
      idempotencyKey: 'cos:report:accept:bad-actor',
      actorType: 'service',
      actorId: 'report-worker',
      authorityTier: 'department_head',
      evidence: {
        source_type: 'service_attempt',
        source_id: 'synthetic-denied',
        observed_at: '2026-07-31T12:00:00Z',
      },
    }),
    (error) => error instanceof ChiefOfStaffPlanningError
      && error.code === 'OWNER_ACCEPTANCE_REQUIRED',
  );
});

test('company goals require measurable KPI definitions', () => {
  assert.throws(
    () => planChiefOfStaffCommand(cycle({
      command: 'create_record',
      recordId: '87bbbbbb-1111-4111-8111-111111111111',
      recordType: 'company_goal',
      title: 'Improve acknowledged onboarding',
      ownerType: 'service',
      ownerId: 'chief-of-staff-shadow',
      recordPayload: {},
      expectedRevision: 1,
      idempotencyKey: 'cos:goal:create:missing-kpis',
    })),
    (error) => error.code === 'GOAL_KPIS_REQUIRED',
  );
});

test('dependency records require two distinct goal identities', () => {
  const goalA = '87bbbbbb-1111-4111-8111-111111111111';
  const goalB = '87cccccc-1111-4111-8111-111111111111';
  const plan = planChiefOfStaffCommand(cycle({
    command: 'create_record',
    recordId: '87dddddd-1111-4111-8111-111111111111',
    recordType: 'dependency',
    title: 'Reliability evidence blocks revenue authority',
    ownerType: 'service',
    ownerId: 'chief-of-staff-shadow',
    sourceGoalId: goalA,
    targetGoalId: goalB,
    recordPayload: { dependency_type: 'evidence_gate' },
    expectedRevision: 3,
    idempotencyKey: 'cos:dependency:create:synthetic',
  }));
  assert.equal(plan.args.p_source_goal_id, goalA);
  assert.equal(plan.args.p_target_goal_id, goalB);

  assert.throws(
    () => planChiefOfStaffCommand(cycle({
      command: 'create_record',
      recordId: '87dddddd-1111-4111-8111-111111111111',
      recordType: 'dependency',
      title: 'Invalid self dependency',
      ownerType: 'service',
      ownerId: 'chief-of-staff-shadow',
      sourceGoalId: goalA,
      targetGoalId: goalA,
      expectedRevision: 3,
      idempotencyKey: 'cos:dependency:self:synthetic',
    })),
    (error) => error.code === 'DEPENDENCY_IDENTITY_INVALID',
  );
});

test('production, provider, customer, and financial actions are rejected recursively', () => {
  for (const forbidden of [
    { send: true },
    { recordPayload: { nested: { providerToken: 'secret' } } },
    { recordPayload: { charge: { amount: 100 } } },
    { evidence: {
      source_type: 'accepted_report_manifest',
      source_id: 'synthetic-2026-07',
      observed_at: '2026-07-31T12:00:00Z',
      nested: { productionWrite: true },
    } },
  ]) {
    assert.throws(
      () => planChiefOfStaffCommand(cycle(forbidden)),
      (error) => error.code === 'PRODUCTION_BOUND_INPUT_FORBIDDEN',
    );
  }
});
