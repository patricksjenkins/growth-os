'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SupervisedHeadPlanningError,
  planDepartmentReport,
  planDepartmentRecordCommand,
} = require('../../core/departments/supervised-head-planner');

const IDS = {
  tenant: '11111111-1111-4111-8111-111111111111',
  report: '88111111-1111-4111-8111-111111111111',
  record: '88211111-1111-4111-8111-111111111111',
  owner: 'eeeeeeee-1111-4111-8111-111111111111',
  assignee: 'aaaaaaaa-1111-4111-8111-111111111111',
};

function report(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    departmentKey: 'marketing',
    reportId: IDS.report,
    reportType: 'content_quality_report',
    periodStartedAt: '2026-07-01T00:00:00.000Z',
    periodEndedAt: '2026-07-24T00:00:00.000Z',
    kpiObservations: [{
      kpi: 'accepted_content_rate',
      state: 'unproven',
      valueDigest: 'a'.repeat(64),
      evidenceDigest: 'b'.repeat(64),
    }],
    evidenceReceipts: [{
      sourceType: 'content_quality_control',
      sourceId: 'synthetic-calibration-window',
      evidenceDigest: 'c'.repeat(64),
      observedAt: '2026-07-24T00:00:00.000Z',
    }],
    outcomeHealth: 'unproven',
    expectedControlRevision: 0,
    featureGateEnabled: true,
    executionMode: 'shadow',
    idempotencyKey: 'department-report:synthetic',
    requestFingerprint: 'd'.repeat(64),
    ...overrides,
  };
}

function command(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    departmentKey: 'product_engineering',
    recordId: IDS.record,
    recordType: 'work',
    action: 'create_record',
    delegatedAction: 'run_verification',
    ownerId: IDS.owner,
    assigneeId: IDS.assignee,
    slaDueAt: '2026-07-25T00:00:00.000Z',
    evidenceReceipts: [{
      sourceType: 'verified_problem_report',
      sourceId: 'synthetic-problem',
      evidenceDigest: 'e'.repeat(64),
      observedAt: '2026-07-24T00:00:00.000Z',
    }],
    expectedRevision: 0,
    expectedControlRevision: 0,
    featureGateEnabled: true,
    executionMode: 'shadow',
    idempotencyKey: 'department-work:synthetic',
    requestFingerprint: 'f'.repeat(64),
    ...overrides,
  };
}

test('plans an evidence-backed report without accepting or acting on it', () => {
  const planned = planDepartmentReport(report());
  assert.equal(planned.departmentKey, 'marketing');
  assert.equal(planned.accepted, false);
  assert.equal(planned.externalActionPermitted, false);
  assert.equal(planned.productionWriteAuthority, false);
  assert.match(planned.semanticFingerprint, /^[a-f0-9]{64}$/);
});

test('false-green report health is rejected unless every registered KPI is met', () => {
  assert.throws(
    () => planDepartmentReport(report({ outcomeHealth: 'healthy' })),
    error => error instanceof SupervisedHeadPlanningError
      && error.code === 'FALSE_GREEN_FORBIDDEN',
  );
});

test('unregistered reports and KPI claims fail closed', () => {
  assert.throws(
    () => planDepartmentReport(report({ reportType: 'vibes_summary' })),
    error => error.code === 'REPORT_TYPE_NOT_ACCEPTED',
  );
  assert.throws(
    () => planDepartmentReport(report({
      kpiObservations: [{
        kpi: 'likes',
        state: 'met',
        valueDigest: 'a'.repeat(64),
        evidenceDigest: 'b'.repeat(64),
      }],
    })),
    error => error.code === 'KPI_NOT_ACCEPTED',
  );
});

test('supervised records require exact owners, assignment, SLA, and evidence', () => {
  const planned = planDepartmentRecordCommand(command());
  assert.equal(planned.authorityDecision, 'allow_shadow');
  assert.equal(planned.externalActionPermitted, false);
  assert.equal(planned.expectedRevision, 0);
  assert.match(planned.semanticFingerprint, /^[a-f0-9]{64}$/);

  assert.throws(
    () => planDepartmentRecordCommand(command({ slaDueAt: null })),
    error => error.code === 'SLA_DUE_REQUIRED',
  );
});

test('production, customer contact, money, and unknown actions cannot be delegated', () => {
  for (const delegatedAction of [
    'deploy_production',
    'send_customer_email',
    'move_money',
    'something_new',
  ]) {
    assert.throws(
      () => planDepartmentRecordCommand(command({ delegatedAction })),
      error => ['OWNER_APPROVAL_REQUIRED', 'ACTION_NOT_AUTHORIZED'].includes(error.code),
    );
  }
});

test('sensitive/provider payloads and non-shadow execution are rejected', () => {
  assert.throws(
    () => planDepartmentRecordCommand(command({ providerToken: 'not-a-real-token' })),
    error => error.code === 'EXTERNAL_OR_SENSITIVE_ACTION_FORBIDDEN',
  );
  assert.throws(
    () => planDepartmentRecordCommand(command({ executionMode: 'supervised' })),
    error => error.code === 'SHADOW_MODE_REQUIRED',
  );
});

test('semantic fingerprints are stable across object key ordering', () => {
  const first = planDepartmentRecordCommand(command({
    evidenceReceipts: [{
      sourceType: 'verified_problem_report',
      sourceId: 'synthetic-problem',
      evidenceDigest: 'e'.repeat(64),
      observedAt: '2026-07-24T00:00:00.000Z',
    }],
  }));
  const second = planDepartmentRecordCommand(command({
    evidenceReceipts: [{
      observedAt: '2026-07-24T00:00:00.000Z',
      evidenceDigest: 'e'.repeat(64),
      sourceId: 'synthetic-problem',
      sourceType: 'verified_problem_report',
    }],
  }));
  assert.equal(first.semanticFingerprint, second.semanticFingerprint);
});
