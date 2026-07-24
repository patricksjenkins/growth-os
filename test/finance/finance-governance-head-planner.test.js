'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FinanceGovernancePlanningError,
  planFinanceGovernanceHeadCommand,
  verifyPlanFingerprint,
} = require('../../core/finance/finance-governance-head-planner');

const TENANT = '11111111-1111-4111-8111-111111111111';
const REPORT = '90111111-1111-4111-8111-111111111111';
const CYCLE = '81111111-1111-4111-8111-111111111111';
const RECORD = '91111111-1111-4111-8111-111111111111';

function report(overrides = {}) {
  return {
    tenantId: TENANT,
    command: 'accept_report',
    reportId: REPORT,
    financeCloseCycleId: CYCLE,
    periodStart: '2026-07-01',
    currency: 'usd',
    attributionRecordIds: [RECORD],
    executionHealth: 'succeeded',
    dataGovernanceState: 'verified',
    governanceEvidenceDigest: 'a'.repeat(64),
    structuredReport: { controls_tested: 12, exceptions: 0 },
    expectedRevision: 0,
    idempotencyKey: 'finance-head:report:2026-07',
    actorId: 'finance-governance-head',
    evidence: {
      source_type: 'canonical_finance_manifest',
      source_id: 'synthetic-2026-07',
      observed_at: '2026-07-31T12:00:00Z',
    },
    ...overrides,
  };
}

test('plans deterministic default-off evidence-only report acceptance', () => {
  const first = planFinanceGovernanceHeadCommand(report());
  const second = planFinanceGovernanceHeadCommand(report());

  assert.equal(first.rpc, 'finance_governance_head_command_rpc');
  assert.equal(first.args.p_currency, 'USD');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.equal(first.args.p_authority_tier, 'department_head');
  assert.equal(first.args.p_request_fingerprint, second.args.p_request_fingerprint);
  assert.equal(verifyPlanFingerprint(first), true);
  assert.deepEqual(first.safety, {
    executionMode: 'supervised_read_only',
    canonicalFinanceMutationAllowed: false,
    moneyMovementAllowed: false,
    providerActionsAllowed: false,
    performsIo: false,
  });
});

test('report contract requires exact integer attribution and close evidence IDs', () => {
  for (const override of [
    { attributionRecordIds: [] },
    { attributionRecordIds: [RECORD, RECORD] },
    { periodStart: '2026-07-02' },
    { governanceEvidenceDigest: 'not-a-digest' },
    {
      structuredReport: {
        controls_tested: 12,
        exceptions: 0,
        NestedMeta: { safe: true },
      },
    },
  ]) {
    assert.throws(
      () => planFinanceGovernanceHeadCommand(report(override)),
      (error) => error instanceof FinanceGovernancePlanningError,
    );
  }
});

test('planner never accepts caller count manifest or truth overrides', () => {
  const plan = planFinanceGovernanceHeadCommand(report());
  assert.equal('p_attribution_record_count' in plan.args, false);
  assert.equal('p_reconciliation_manifest_digest' in plan.args, false);
  assert.equal('p_financial_truth_state' in plan.args, false);
});

test('execution health remains separate from financial truth', () => {
  const plan = planFinanceGovernanceHeadCommand(report({
    executionHealth: 'succeeded',
    dataGovernanceState: 'unverified',
  }));
  assert.equal(plan.args.p_execution_health, 'succeeded');
  assert.equal(plan.args.p_data_governance_state, 'unverified');
  assert.equal('p_financial_truth_state' in plan.args, false);
});

test('work transition is explicitly Head-owned with revision and evidence', () => {
  const plan = planFinanceGovernanceHeadCommand(report({
    command: 'complete_work',
    reportId: null,
    financeCloseCycleId: null,
    periodStart: null,
    currency: null,
    attributionRecordIds: [],
    executionHealth: null,
    dataGovernanceState: null,
    governanceEvidenceDigest: null,
    structuredReport: {},
    caseId: '90333333-1111-4111-8111-111111111111',
    expectedRevision: 2,
    idempotencyKey: 'finance-head:work:complete',
    evidence: {
      source_type: 'completion_receipt',
      source_id: 'synthetic-work-complete',
      observed_at: '2026-08-01T12:00:00Z',
    },
  }));
  assert.equal(plan.args.p_assignee_id, null);
  assert.equal(plan.args.p_expected_revision, 2);
  assert.throws(
    () => planFinanceGovernanceHeadCommand(report({
      command: 'accept_work',
      caseId: '90333333-1111-4111-8111-111111111111',
      assigneeId: 'eeeeeeee-1111-4111-8111-111111111111',
    })),
    (error) => error.code === 'ASSIGNEE_ID_FORBIDDEN',
  );
});

test('goal decision and exception lifecycle commands are planned explicitly', () => {
  for (const [command, outcomeState] of [
    ['complete_goal', 'verified_achieved'],
    ['decide_decision', 'approved'],
    ['resolve_exception', 'verified_not_achieved'],
  ]) {
    const plan = planFinanceGovernanceHeadCommand(report({
      command,
      caseId: '90333333-1111-4111-8111-111111111111',
      outcomeState,
      structuredReport: {},
      contract: {},
      expectedRevision: 1,
      idempotencyKey: `finance-head:${command}`,
    }));
    assert.equal(plan.args.p_command, command);
    assert.equal(plan.args.p_outcome_state, outcomeState);
  }
});

test('case metadata is exact, flat, and specific to each case type', () => {
  for (const [caseType, contract] of [
    ['goal', { measure: 'matched_set' }],
    ['work', { acceptance: ['evidence_attached'] }],
    ['decision', { decision_scope: 'synthetic_review' }],
    ['exception', { resolution: 'evidence_required' }],
  ]) {
    const plan = planFinanceGovernanceHeadCommand(report({
      command: 'create_case',
      reportId: REPORT,
      caseId: '90333333-1111-4111-8111-111111111111',
      financeCloseCycleId: null,
      periodStart: null,
      currency: null,
      attributionRecordIds: [],
      executionHealth: null,
      dataGovernanceState: null,
      governanceEvidenceDigest: null,
      structuredReport: {},
      caseType,
      title: `Create ${caseType} case`,
      ownerId: 'eeeeeeee-1111-4111-8111-111111111111',
      slaDueAt: '2026-08-02T12:00:00Z',
      contract,
      idempotencyKey: `finance-head:${caseType}:create`,
    }));
    assert.deepEqual(plan.args.p_contract, contract);
  }
  for (const contract of [
    { Resolution: 'evidence_required' },
    { resolution: 'evidence_required', NestedMeta: { safe: true } },
    { resolution: 'evidence_required', note: 'unsupported' },
  ]) {
    assert.throws(
      () => planFinanceGovernanceHeadCommand(report({
        command: 'create_case',
        structuredReport: {},
        caseType: 'exception',
        contract,
      })),
      (error) => error.code === 'CASE_METADATA_INVALID',
    );
  }
});

test('production sensitive and mixed-case nested metadata fail', () => {
  for (const forbidden of [
    { charge: 100 },
    { structuredReport: { nested: { refund: true } } },
    { structuredReport: { financialTruthState: 'verified' } },
    { contract: { providerDispatch: true } },
    { contract: { nested: { CustomerEmail: 'synthetic@example.invalid' } } },
    { structuredReport: { nested: { API_KEY: 'synthetic-only' } } },
    { evidence: {
      source_type: 'canonical_finance_manifest',
      source_id: 'synthetic',
      observed_at: '2026-07-31T12:00:00Z',
      productionWrite: true,
    } },
  ]) {
    assert.throws(
      () => planFinanceGovernanceHeadCommand(report(forbidden)),
      (error) => error.code === 'PRODUCTION_ACTION_FORBIDDEN',
    );
  }
});

test('evidence is strictly minimized and requires an observation time', () => {
  for (const evidence of [
    {
      source_type: 'canonical_finance_manifest',
      source_id: 'synthetic',
    },
    {
      source_type: 'canonical_finance_manifest',
      source_id: 'synthetic',
      observed_at: '2026-07-31T12:00:00Z',
      note: 'not allowlisted',
    },
  ]) {
    assert.throws(
      () => planFinanceGovernanceHeadCommand(report({ evidence })),
      (error) => error instanceof FinanceGovernancePlanningError,
    );
  }
});
