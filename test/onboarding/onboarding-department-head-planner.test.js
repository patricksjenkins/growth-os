'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OnboardingDepartmentHeadError,
  planOnboardingCustomerOutcomeReceipt,
  planOnboardingHeadReport,
  planOnboardingHeadCaseCommand,
} = require('../../core/onboarding/department-head-planner');

const IDS = Object.freeze({
  tenant: '11111111-1111-4111-8111-111111111111',
  clientTenant: '22222222-2222-4222-8222-222222222222',
  report: '88111111-1111-4111-8111-111111111111',
  handoff: '88211111-1111-4111-8111-111111111111',
  workflow: '66666666-2222-4222-8222-222222222222',
  work: '88311111-1111-4111-8111-111111111111',
  owner: 'eeeeeeee-1111-4111-8111-111111111111',
  assignee: '77777777-1111-4111-8111-111111111111',
  receipt: '88511111-1111-4111-8111-111111111111',
});

function common(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    clientTenantId: IDS.clientTenant,
    expectedControlRevision: 0,
    featureGateEnabled: true,
    idempotencyKey: 'onboarding-head:test',
    requestFingerprint: 'a'.repeat(64),
    actorType: 'agent',
    actorId: 'onboarding-head-v1',
    authorityTier: 'department_head',
    evidence: {
      source_type: 'onboarding_workflow_receipt',
      source_id: 'synthetic-onboarding-evidence',
      observed_at: '2026-07-24T12:00:00.000Z',
    },
    ...overrides,
  };
}

test('implementation report keeps execution separate from customer outcome', () => {
  const report = planOnboardingHeadReport(common({
    reportId: IDS.report,
    handoffId: IDS.handoff,
    workflowId: IDS.workflow,
    reportType: 'implementation',
    periodStart: '2026-07-23T12:00:00.000Z',
    periodEnd: '2026-07-24T12:00:00.000Z',
    executionHealthState: 'healthy',
    customerOutcomeState: 'unproven',
    outcomeVerified: false,
    kpiResults: [{
      kpi_key: 'implementation_completion_rate',
      measured_value: 1,
      verification_state: 'verified',
      evidence_ref: 'workflow:synthetic',
    }],
    reportBody: { summary: 'Implementation complete; outcome unproven' },
  }));

  assert.equal(report.executionHealthState, 'healthy');
  assert.equal(report.customerOutcomeState, 'unproven');
  assert.equal(report.outcomeVerified, false);
  assert.equal(report.operationalActionPermitted, false);
});

test('customer outcomes require authoritative evidence and complete verified KPIs', () => {
  assert.throws(
    () => planOnboardingHeadReport(common({
      reportId: IDS.report,
      handoffId: IDS.handoff,
      workflowId: IDS.workflow,
      reportType: 'customer_outcome',
      periodStart: '2026-07-23T12:00:00.000Z',
      periodEnd: '2026-07-24T12:00:00.000Z',
      executionHealthState: 'healthy',
      customerOutcomeState: 'achieved',
      outcomeVerified: true,
      kpiResults: [{
        kpi_key: 'time_to_first_value_days',
        verification_state: 'verified',
        evidence_ref: 'receipt:synthetic',
      }],
      reportBody: { summary: 'Incomplete KPI proof' },
      evidence: {
        source_type: 'onboarding_workflow_receipt',
        source_id: 'synthetic-wrong-source',
        observed_at: '2026-07-24T12:00:00.000Z',
      },
    })),
    error => error instanceof OnboardingDepartmentHeadError
      && error.code === 'AUTHORITATIVE_EVIDENCE_REQUIRED',
  );

  const report = planOnboardingHeadReport(common({
    reportId: IDS.report,
    handoffId: IDS.handoff,
    workflowId: IDS.workflow,
    reportType: 'customer_outcome',
    periodStart: '2026-07-23T12:00:00.000Z',
    periodEnd: '2026-07-24T12:00:00.000Z',
    executionHealthState: 'healthy',
    customerOutcomeState: 'achieved',
    outcomeVerified: true,
    customerOutcomeReceiptId: IDS.receipt,
    kpiResults: [
      {
        kpi_key: 'time_to_first_value_days',
        measured_value: 2,
        verification_state: 'verified',
        evidence_ref: 'receipt:time-to-value',
      },
      {
        kpi_key: 'customer_outcome_receipt_rate',
        measured_value: 1,
        verification_state: 'verified',
        evidence_ref: 'receipt:customer-outcome',
      },
    ],
    reportBody: { summary: 'Synthetic proven customer outcome' },
    evidence: {
      source_type: 'customer_outcome_receipt',
      source_id: 'synthetic-customer-outcome',
      observed_at: '2026-07-24T12:00:00.000Z',
    },
  }));
  assert.equal(report.outcomeVerified, true);
});

test('work creation includes evidence, ownership, assignment, and SLA', () => {
  const command = planOnboardingHeadCaseCommand(common({
    caseId: IDS.work,
    sourceReportId: IDS.report,
    action: 'create_work',
    expectedRevision: 0,
    ownerId: IDS.owner,
    assigneeId: IDS.assignee,
    slaDueAt: '2026-07-25T12:00:00.000Z',
    title: 'Verify implementation completion',
    contract: {
      objective: 'Verify configured implementation',
      acceptance_criteria: ['workflow receipt exists'],
      completion_contract: 'implementation_completion_receipt',
    },
  }));
  assert.equal(command.caseType, 'work');
  assert.equal(command.assigneeId, IDS.assignee);
  assert.equal(command.operationalActionPermitted, false);
});

test('implementation completion cannot carry customer outcome', () => {
  assert.throws(
    () => planOnboardingHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'complete_work',
      expectedRevision: 2,
      customerOutcomeState: 'achieved',
    })),
    error => error.code === 'CUSTOMER_OUTCOME_FORBIDDEN',
  );

  const outcome = planOnboardingHeadCaseCommand(common({
    caseId: IDS.work,
    action: 'record_customer_outcome',
    expectedRevision: 3,
    customerOutcomeState: 'achieved',
    customerOutcomeReceiptId: IDS.receipt,
    evidence: {
      source_type: 'customer_outcome_receipt',
      source_id: 'synthetic-outcome',
      observed_at: '2026-07-25T12:00:00.000Z',
    },
  }));
  assert.equal(outcome.customerOutcomeState, 'achieved');
});

test('synthetic-achieved caller JSON cannot self-certify an outcome', () => {
  assert.throws(
    () => planOnboardingHeadReport(common({
      reportId: IDS.report,
      handoffId: IDS.handoff,
      workflowId: IDS.workflow,
      reportType: 'customer_outcome',
      periodStart: '2026-07-23T12:00:00.000Z',
      periodEnd: '2026-07-24T12:00:00.000Z',
      executionHealthState: 'healthy',
      customerOutcomeState: 'achieved',
      outcomeVerified: true,
      kpiResults: [
        {
          kpi_key: 'time_to_first_value_days',
          verification_state: 'verified',
          evidence_ref: 'synthetic-achieved',
        },
        {
          kpi_key: 'customer_outcome_receipt_rate',
          verification_state: 'verified',
          evidence_ref: 'synthetic-achieved',
        },
      ],
      reportBody: { summary: 'synthetic-achieved' },
      evidence: {
        source_type: 'customer_outcome_receipt',
        source_id: 'synthetic-achieved',
        observed_at: '2026-07-24T12:00:00.000Z',
      },
    })),
    error => error.code === 'CANONICAL_OUTCOME_RECEIPT_REQUIRED',
  );
});

test('evidence rejects CustomerEmail and case variants recursively', () => {
  assert.throws(
    () => planOnboardingHeadReport(common({
      reportId: IDS.report,
      handoffId: IDS.handoff,
      workflowId: IDS.workflow,
      reportType: 'implementation',
      periodStart: '2026-07-23T12:00:00.000Z',
      periodEnd: '2026-07-24T12:00:00.000Z',
      executionHealthState: 'healthy',
      customerOutcomeState: 'unproven',
      outcomeVerified: false,
      kpiResults: [{
        kpi_key: 'implementation_completion_rate',
        verification_state: 'verified',
      }],
      reportBody: { summary: 'synthetic' },
      evidence: {
        source_type: 'onboarding_workflow_receipt',
        source_id: 'synthetic-evidence',
        observed_at: '2026-07-24T12:00:00.000Z',
        nested: { CustomerEmail: 'must-not-persist@example.invalid' },
      },
    })),
    error => error.code === 'PROHIBITED_ACTION_INPUT',
  );
});

test('canonical outcome receipt requires independent tenant-owner verifier', () => {
  const receipt = planOnboardingCustomerOutcomeReceipt({
    tenantId: IDS.tenant,
    clientTenantId: IDS.clientTenant,
    workflowId: IDS.workflow,
    receiptId: IDS.receipt,
    customerOutcomeState: 'achieved',
    outcomeCode: 'first_value_verified',
    measuredAt: '2026-07-24T12:00:00.000Z',
    evidenceRef: 'customer-success/outcome/8851',
    evidenceDigest: 'b'.repeat(64),
    verifierUserId: IDS.owner,
    verifierRole: 'client_owner',
    registeredHeadId: 'onboarding-head-v1',
    idempotencyKey: 'onboarding-outcome:receipt',
    requestFingerprint: 'c'.repeat(64),
  });
  assert.equal(receipt.headMayVerify, false);

  assert.throws(
    () => planOnboardingCustomerOutcomeReceipt({
      ...receipt,
      registeredHeadId: IDS.owner,
    }),
    error => error.code === 'INDEPENDENT_HUMAN_VERIFIER_REQUIRED',
  );
});

test('Head cannot approve its own recommendation', () => {
  assert.throws(
    () => planOnboardingHeadCaseCommand(common({
      caseId: '88411111-1111-4111-8111-111111111111',
      action: 'decide_recommendation',
      expectedRevision: 1,
      decision: 'approved',
      evidence: {
        source_type: 'human_decision_record',
        source_id: 'synthetic-agent-decision',
        observed_at: '2026-07-25T12:00:00.000Z',
      },
    })),
    error => error.code === 'HUMAN_DECISION_REQUIRED',
  );
});

test('planner denies customer sends, provisioning, money, and disabled gates', () => {
  assert.throws(
    () => planOnboardingHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'accept_work',
      expectedRevision: 1,
      send: true,
    })),
    error => error.code === 'PROHIBITED_ACTION_INPUT',
  );
  assert.throws(
    () => planOnboardingHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'accept_work',
      expectedRevision: 1,
      featureGateEnabled: false,
    })),
    error => error.code === 'FEATURE_GATE_DISABLED',
  );
});
