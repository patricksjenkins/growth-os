'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MarketingBrandPlanningError,
  planMarketingBrandHeadCommand,
  verifyPlanFingerprint,
} = require('../../core/marketing/marketing-brand-head-planner');

const TENANT = '11111111-1111-4111-8111-111111111111';
const REPORT = '91111111-1111-4111-8111-111111111111';
const VERSION = '82111111-1111-4111-8111-111111111111';
const QUALITY = '83111111-1111-4111-8111-111111111111';
const DELIVERY = '84111111-1111-4111-8111-111111111111';

function report(overrides = {}) {
  return {
    tenantId: TENANT,
    command: 'accept_report',
    reportId: REPORT,
    reportingPeriodStart: '2026-07-01',
    contentVersionIds: [VERSION],
    qualityEvaluationIds: [QUALITY],
    deliveryReceiptIds: [DELIVERY],
    executionHealth: 'succeeded',
    contentCompletionState: 'completed',
    brandComplianceState: 'verified',
    brandComplianceEvidenceDigest: 'a'.repeat(64),
    audienceObservedCount: 40,
    replyObservedCount: 4,
    conversionObservedCount: 1,
    cohortSize: 50,
    metricsEvidenceDigest: 'b'.repeat(64),
    structuredReport: {
      content_quality: { accepted: 1 },
      delivery_receipts: { delivered: 1 },
      audience: { observed: 40 },
      replies: { observed: 4 },
      conversions: { observed: 1 },
      brand_compliance_exceptions: { open: 0 },
      cohort: { size: 50 },
    },
    expectedRevision: 0,
    idempotencyKey: 'marketing-head:report:2026-07',
    actorId: 'marketing-brand-head',
    evidence: {
      source_type: 'content_evidence_manifest',
      source_id: 'synthetic-2026-07',
      observed_at: '2026-07-31T12:00:00Z',
    },
    ...overrides,
  };
}

test('plans deterministic default-off evidence-only report acceptance', () => {
  const first = planMarketingBrandHeadCommand(report());
  const second = planMarketingBrandHeadCommand(report());
  assert.equal(first.rpc, 'marketing_brand_head_command_rpc');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.equal(first.args.p_authority_tier, 'department_head');
  assert.equal(first.args.p_request_fingerprint, second.args.p_request_fingerprint);
  assert.equal(verifyPlanFingerprint(first), true);
  assert.deepEqual(first.safety, {
    executionMode: 'supervised_read_only',
    publicationAllowed: false,
    providerDispatchAllowed: false,
    customerContactAllowed: false,
    paidAdvertisingAllowed: false,
    spendAllowed: false,
    productionWriteAllowed: false,
    performsIo: false,
  });
});

test('report requires exact source evidence and bounded observations', () => {
  for (const override of [
    { contentVersionIds: [] },
    { contentVersionIds: [VERSION, VERSION] },
    { reportingPeriodStart: '2026-07-02' },
    { brandComplianceEvidenceDigest: 'bad' },
    { audienceObservedCount: 60, cohortSize: 50 },
    { replyObservedCount: 41 },
    { metricsEvidenceDigest: null },
  ]) {
    assert.throws(
      () => planMarketingBrandHeadCommand(report(override)),
      (error) => error instanceof MarketingBrandPlanningError,
    );
  }
});

test('completed content carries no caller supplied quality delivery or effect state', () => {
  const plan = planMarketingBrandHeadCommand(report());
  assert.equal(plan.args.p_payload.content_completion_state, 'completed');
  assert.equal('quality_state' in plan.args.p_payload, false);
  assert.equal('delivery_state' in plan.args.p_payload, false);
  assert.equal('business_effect_state' in plan.args.p_payload, false);
  assert.equal('causal_claim' in plan.args.p_payload, false);
});

test('unobserved report requires zero metrics and no metrics digest', () => {
  const plan = planMarketingBrandHeadCommand(report({
    audienceObservedCount: 0,
    replyObservedCount: 0,
    conversionObservedCount: 0,
    cohortSize: 0,
    metricsEvidenceDigest: null,
  }));
  assert.equal('metrics_evidence_digest' in plan.args.p_payload, false);
});

test('work transition uses the registered Head actor without a caller assignee', () => {
  const plan = planMarketingBrandHeadCommand(report({
    command: 'complete_work',
    caseId: '91333333-1111-4111-8111-111111111111',
    expectedRevision: 2,
    idempotencyKey: 'marketing-head:work:complete',
  }));
  assert.deepEqual(plan.args.p_payload, {
    case_id: '91333333-1111-4111-8111-111111111111',
  });
  assert.equal(plan.args.p_expected_revision, 2);
  assert.throws(
    () => planMarketingBrandHeadCommand(report({
      command: 'complete_work',
      caseId: '91333333-1111-4111-8111-111111111111',
      assigneeId: 'aaaaaaaa-1111-4111-8111-111111111111',
      expectedRevision: 2,
      idempotencyKey: 'marketing-head:work:caller-assignee',
    })),
    (error) => error.code === 'ASSIGNEE_ID_FORBIDDEN',
  );
});

test('goal decision and exception actions have explicit terminal contracts', () => {
  const goal = planMarketingBrandHeadCommand(report({
    command: 'complete_goal',
    caseId: '91444444-1111-4111-8111-111111111111',
    outcomeState: 'verified_achieved',
    expectedRevision: 1,
    idempotencyKey: 'marketing-head:goal:complete',
  }));
  const decision = planMarketingBrandHeadCommand(report({
    command: 'decide_decision',
    caseId: '91555555-1111-4111-8111-111111111111',
    decisionResult: 'approved',
    expectedRevision: 1,
    idempotencyKey: 'marketing-head:decision:decide',
  }));
  const exception = planMarketingBrandHeadCommand(report({
    command: 'resolve_exception',
    caseId: '91666666-1111-4111-8111-111111111111',
    outcomeState: 'verified_not_achieved',
    expectedRevision: 1,
    idempotencyKey: 'marketing-head:exception:resolve',
  }));
  assert.equal(goal.args.p_payload.outcome_state, 'verified_achieved');
  assert.equal(decision.args.p_payload.decision_result, 'approved');
  assert.equal(exception.args.p_payload.outcome_state, 'verified_not_achieved');
});

test('report case and evidence metadata use exact minimized schemas', () => {
  assert.throws(
    () => planMarketingBrandHeadCommand(report({
      structuredReport: {
        ...report().structuredReport,
        unbounded_metadata: 'no',
      },
    })),
    (error) => error.code === 'REPORT_METADATA_INVALID',
  );
  assert.throws(
    () => planMarketingBrandHeadCommand(report({
      evidence: {
        ...report().evidence,
        campaign_name: 'not-in-schema',
      },
    })),
    (error) => error.code === 'EVIDENCE_SCHEMA_INVALID',
  );
  const work = planMarketingBrandHeadCommand(report({
    command: 'create_case',
    caseId: '91333333-1111-4111-8111-111111111111',
    reportId: REPORT,
    caseType: 'work',
    title: 'Review synthetic brand exception',
    ownerId: 'aaaaaaaa-1111-4111-8111-111111111111',
    slaDueAt: '2026-08-01T12:00:00Z',
    contract: { acceptance: ['evidence-backed-review'] },
    expectedRevision: 0,
    idempotencyKey: 'marketing-head:work:create',
  }));
  assert.deepEqual(work.args.p_payload.contract, {
    acceptance: ['evidence-backed-review'],
  });
});

test('publication contact advertising spend and causal inputs fail closed', () => {
  for (const forbidden of [
    { publish: true },
    { structuredReport: { nested: { providerDispatch: true } } },
    { structuredReport: { nested: { provider_dispatch: true } } },
    { structuredReport: { nested: { 'Provider.Dispatch': true } } },
    { contract: { paidAdvertising: true } },
    { evidence: {
      source_type: 'content_evidence_manifest',
      source_id: 'synthetic',
      observed_at: '2026-07-31T12:00:00Z',
      customerContact: true,
    } },
    { evidence: {
      source_type: 'content_evidence_manifest',
      source_id: 'synthetic',
      observed_at: '2026-07-31T12:00:00Z',
      'Customer-Email': true,
    } },
    { structuredReport: { causalClaim: true } },
  ]) {
    assert.throws(
      () => planMarketingBrandHeadCommand(report(forbidden)),
      (error) => error.code === 'PRODUCTION_ACTION_FORBIDDEN',
    );
  }
});
