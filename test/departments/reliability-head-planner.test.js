'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ReliabilityHeadPlanningError,
  planReliabilityHeadReport,
  planReliabilityHeadCaseCommand,
} = require('../../core/departments/reliability-head-planner');

const IDS = Object.freeze({
  tenant: '11111111-1111-4111-8111-111111111111',
  report: '85111111-1111-4111-8111-111111111111',
  work: '85211111-1111-4111-8111-111111111111',
  owner: 'eeeeeeee-1111-4111-8111-111111111111',
  assignee: '77777777-1111-4111-8111-111111111111',
});

function common(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    expectedControlRevision: 0,
    featureGateEnabled: true,
    idempotencyKey: 'reliability-head:test',
    requestFingerprint: 'a'.repeat(64),
    actorType: 'agent',
    actorId: 'reliability-head-v1',
    authorityTier: 'department_head',
    evidence: {
      source_type: 'supervised_agent_record',
      source_id: 'synthetic-evidence',
      observed_at: '2026-07-24T12:00:00.000Z',
    },
    ...overrides,
  };
}

test('report planner separates execution health from verified outcome health', () => {
  const report = planReliabilityHeadReport(common({
    reportId: IDS.report,
    reportType: 'reliability',
    periodStart: '2026-07-23T12:00:00.000Z',
    periodEnd: '2026-07-24T12:00:00.000Z',
    executionHealthState: 'healthy',
    outcomeHealthState: 'unproven',
    outcomeVerified: false,
    kpiResults: [{
      kpi_key: 'verified_recovery_rate',
      measured_value: 0.9,
      verification_state: 'unverified',
    }],
    reportBody: { summary: 'Synthetic supervised report' },
  }));

  assert.equal(report.executionHealthState, 'healthy');
  assert.equal(report.outcomeHealthState, 'unproven');
  assert.equal(report.operationalActionPermitted, false);
  assert.match(report.semanticFingerprint, /^[a-f0-9]{64}$/);
});

test('healthy outcome reports require verified evidence for every KPI', () => {
  assert.throws(
    () => planReliabilityHeadReport(common({
      reportId: IDS.report,
      reportType: 'security',
      periodStart: '2026-07-23T12:00:00.000Z',
      periodEnd: '2026-07-24T12:00:00.000Z',
      executionHealthState: 'healthy',
      outcomeHealthState: 'healthy',
      outcomeVerified: true,
      kpiResults: [{
        kpi_key: 'tenant_isolation_gate_pass_rate',
        measured_value: 1,
        verification_state: 'unverified',
      }],
      reportBody: { summary: 'Synthetic false green' },
    })),
    error => error instanceof ReliabilityHeadPlanningError
      && error.code === 'FALSE_GREEN_FORBIDDEN'
  );

  const verified = planReliabilityHeadReport(common({
    reportId: IDS.report,
    reportType: 'security',
    periodStart: '2026-07-23T12:00:00.000Z',
    periodEnd: '2026-07-24T12:00:00.000Z',
    executionHealthState: 'healthy',
    outcomeHealthState: 'healthy',
    outcomeVerified: true,
    kpiResults: [
      {
        kpi_key: 'tenant_isolation_gate_pass_rate',
        measured_value: 1,
        verification_state: 'verified',
        evidence_ref: 'test_run:synthetic-isolation-proof',
      },
      {
        kpi_key: 'audit_evidence_completeness',
        measured_value: 1,
        verification_state: 'verified',
        evidence_ref: 'audit_manifest:synthetic-proof',
      },
    ],
    reportBody: { summary: 'Synthetic verified result' },
  }));
  assert.equal(verified.outcomeVerified, true);
});

test('work planning includes assignment, acceptance contract, and SLA', () => {
  const work = planReliabilityHeadCaseCommand(common({
    caseId: IDS.work,
    action: 'create_work',
    expectedRevision: 0,
    sourceReportId: IDS.report,
    ownerId: IDS.owner,
    assigneeId: IDS.assignee,
    slaDueAt: '2026-07-25T12:00:00.000Z',
    title: 'Verify agent recovery evidence',
    contract: {
      objective: 'Verify recovery',
      acceptance_criteria: ['evidence receipt exists'],
      completion_contract: 'verified_receipt',
    },
  }));
  assert.equal(work.caseType, 'work');
  assert.equal(work.assigneeId, IDS.assignee);
  assert.equal(work.operationalActionPermitted, false);
});

test('work completion cannot masquerade as an achieved outcome', () => {
  assert.throws(
    () => planReliabilityHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'complete_work',
      expectedRevision: 2,
      outcomeState: 'achieved',
    })),
    error => error.code === 'OUTCOME_STATE_FORBIDDEN'
  );

  const outcome = planReliabilityHeadCaseCommand(common({
    caseId: IDS.work,
    action: 'record_work_outcome',
    expectedRevision: 3,
    outcomeState: 'achieved',
    evidence: {
      source_type: 'business_outcome_receipt',
      source_id: 'synthetic-recovery-outcome',
      observed_at: '2026-07-25T12:00:00.000Z',
    },
  }));
  assert.equal(outcome.outcomeState, 'achieved');
});

test('an agent cannot approve its own recommendation', () => {
  assert.throws(
    () => planReliabilityHeadCaseCommand(common({
      caseId: '85311111-1111-4111-8111-111111111111',
      action: 'decide_recommendation',
      expectedRevision: 1,
      decision: 'approved',
      evidence: {
        source_type: 'human_decision_record',
        source_id: 'synthetic-decision',
        observed_at: '2026-07-25T12:00:00.000Z',
      },
    })),
    error => error.code === 'HUMAN_DECISION_REQUIRED'
  );
});

test('planner rejects prohibited operational actions and disabled gates', () => {
  assert.throws(
    () => planReliabilityHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'accept_work',
      expectedRevision: 1,
      deployProduction: true,
    })),
    error => error.code === 'PROHIBITED_ACTION'
  );
  assert.throws(
    () => planReliabilityHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'accept_work',
      expectedRevision: 1,
      featureGateEnabled: false,
    })),
    error => error.code === 'FEATURE_GATE_DISABLED'
  );
});
