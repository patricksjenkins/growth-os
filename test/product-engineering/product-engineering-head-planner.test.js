'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProductEngineeringHeadError,
  planProductEngineeringOutcomeReceipt,
  planProductEngineeringHeadReport,
  planProductEngineeringHeadCaseCommand,
} = require('../../core/product-engineering/department-head-planner');

const IDS = Object.freeze({
  tenant: '11111111-1111-4111-8111-111111111111',
  otherTenant: '22222222-2222-4222-8222-222222222222',
  report: '92111111-1111-4111-8111-111111111111',
  source: '92211111-1111-4111-8111-111111111111',
  sourceRun: '92311111-1111-4111-8111-111111111111',
  work: '92411111-1111-4111-8111-111111111111',
  owner: 'eeeeeeee-1111-4111-8111-111111111111',
  assignee: '77777777-1111-4111-8111-111111111111',
  receipt: '92811111-1111-4111-8111-111111111111',
});

function source(sourceType, sourceId = IDS.source) {
  return {
    source_type: sourceType,
    source_id: sourceId,
    source_tenant_id: IDS.tenant,
    digest: 'b'.repeat(64),
    observed_at: '2026-07-24T12:00:00.000Z',
  };
}

function common(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    productTenantId: IDS.tenant,
    expectedControlRevision: 0,
    featureGateEnabled: true,
    idempotencyKey: 'product-engineering-head:test',
    requestFingerprint: 'a'.repeat(64),
    actorType: 'agent',
    actorId: 'product-engineering-head-v1',
    authorityTier: 'department_head',
    evidence: {
      source_type: 'engineering_evidence_manifest',
      source_id: 'synthetic-engineering-manifest',
      observed_at: '2026-07-24T12:00:00.000Z',
      sources: [source('automated_test_run')],
    },
    ...overrides,
  };
}

function report(overrides = {}) {
  return common({
    reportId: IDS.report,
    sourceEvidenceId: IDS.source,
    sourceRunId: null,
    reportType: 'reliability_quality',
    productScope: 'platform',
    periodStart: '2026-07-23T12:00:00.000Z',
    periodEnd: '2026-07-24T12:00:00.000Z',
    executionHealthState: 'healthy',
    productOutcomeState: 'unproven',
    outcomeVerified: false,
    kpiResults: [{
      kpi_key: 'reliability_quality_pass_rate',
      measured_value: 1,
      verification_state: 'verified',
      evidence_ref: 'test-run:synthetic',
    }],
    reportBody: { summary: 'Build passed; product outcome remains unproven.' },
    ...overrides,
  });
}

test('build success remains separate from measured product outcome', () => {
  const planned = planProductEngineeringHeadReport(report());
  assert.equal(planned.executionHealthState, 'healthy');
  assert.equal(planned.productOutcomeState, 'unproven');
  assert.equal(planned.outcomeVerified, false);
  assert.equal(planned.operationalActionPermitted, false);
});

test('each report class requires its authoritative evidence sources', () => {
  assert.throws(
    () => planProductEngineeringHeadReport(report({
      reportType: 'regression_isolation',
    })),
    error => error instanceof ProductEngineeringHeadError
      && error.code === 'AUTHORITATIVE_EVIDENCE_REQUIRED',
  );

  const planned = planProductEngineeringHeadReport(report({
    reportType: 'regression_isolation',
    kpiResults: [
      {
        kpi_key: 'regression_escape_rate',
        measured_value: 0,
        verification_state: 'verified',
        evidence_ref: 'test-run:synthetic',
      },
      {
        kpi_key: 'tenant_isolation_gate_pass_rate',
        measured_value: 1,
        verification_state: 'verified',
        evidence_ref: 'isolation-gate:synthetic',
      },
    ],
    evidence: {
      source_type: 'engineering_evidence_manifest',
      source_id: 'synthetic-regression-manifest',
      observed_at: '2026-07-24T12:00:00.000Z',
      sources: [
        source('automated_test_run'),
        source(
          'tenant_isolation_gate',
          '92511111-1111-4111-8111-111111111111',
        ),
      ],
    },
  }));
  assert.equal(planned.reportType, 'regression_isolation');
});

test('verified product outcome requires receipt and complete verified KPI proof', () => {
  assert.throws(
    () => planProductEngineeringHeadReport(report({
      reportType: 'product_outcome',
      productOutcomeState: 'achieved',
      outcomeVerified: true,
    })),
    error => error.code === 'AUTHORITATIVE_EVIDENCE_REQUIRED',
  );

  const planned = planProductEngineeringHeadReport(report({
    sourceEvidenceId: IDS.receipt,
    reportType: 'product_outcome',
    productOutcomeState: 'achieved',
    outcomeVerified: true,
    kpiResults: [{
      kpi_key: 'product_outcome_achievement_rate',
      measured_value: 1,
      verification_state: 'verified',
      evidence_ref: `product_outcome_receipt:${IDS.receipt}`,
    }],
    evidence: {
      source_type: 'engineering_evidence_manifest',
      source_id: 'synthetic-outcome-manifest',
      observed_at: '2026-07-24T12:00:00.000Z',
      sources: [source('product_outcome_receipt', IDS.receipt)],
    },
  }));
  assert.equal(planned.outcomeVerified, true);
});

test('cross-tenant report planning fails closed', () => {
  assert.throws(
    () => planProductEngineeringHeadReport(report({
      productTenantId: IDS.otherTenant,
    })),
    error => error.code === 'CROSS_TENANT_COMMAND_FORBIDDEN',
  );
});

test('work contract includes owner, assignment, SLA, and evidence', () => {
  const planned = planProductEngineeringHeadCaseCommand(common({
    caseId: IDS.work,
    action: 'create_work',
    expectedRevision: 0,
    sourceReportId: IDS.report,
    ownerId: IDS.owner,
    assigneeId: IDS.assignee,
    slaDueAt: '2026-07-25T12:00:00.000Z',
    title: 'Verify tenant-isolation release evidence',
    contract: {
      objective: 'Verify regression and isolation evidence',
      acceptance_criteria: ['tenant isolation proof accepted'],
    },
    evidence: {
      source_type: 'supervised_work_contract',
      source_id: 'synthetic-work-contract',
      observed_at: '2026-07-24T12:00:00.000Z',
    },
  }));
  assert.equal(planned.caseType, 'work');
  assert.equal(planned.operationalActionPermitted, false);
});

test('engineering completion remains unproven until separate outcome receipt', () => {
  assert.throws(
    () => planProductEngineeringHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'complete_work',
      expectedRevision: 2,
      productOutcomeState: 'achieved',
      actorType: 'human',
      actorId: IDS.assignee,
      authorityTier: 'operator',
      evidence: {
        source_type: 'engineering_completion_receipt',
        source_id: 'synthetic-completion',
        observed_at: '2026-07-25T12:00:00.000Z',
      },
    })),
    error => error.code === 'PRODUCT_OUTCOME_FORBIDDEN',
  );

  const completed = planProductEngineeringHeadCaseCommand(common({
    caseId: IDS.work,
    action: 'complete_work',
    expectedRevision: 2,
    actorType: 'human',
    actorId: IDS.assignee,
    authorityTier: 'operator',
    evidence: {
      source_type: 'engineering_completion_receipt',
      source_id: 'synthetic-completion',
      observed_at: '2026-07-25T12:00:00.000Z',
    },
  }));
  assert.equal(completed.resultingProductOutcomeState, 'unproven');

  const outcome = planProductEngineeringHeadCaseCommand(common({
    caseId: IDS.work,
    action: 'record_product_outcome',
    expectedRevision: 3,
    sourceReportId: IDS.report,
    productOutcomeState: 'achieved',
    productOutcomeReceiptId: IDS.receipt,
    evidence: {
      source_type: 'product_outcome_receipt',
      source_id: IDS.receipt,
      observed_at: '2026-07-26T12:00:00.000Z',
    },
  }));
  assert.equal(outcome.resultingProductOutcomeState, 'achieved');
});

test('canonical outcome receipt requires an independent owner shape', () => {
  const planned = planProductEngineeringOutcomeReceipt({
    ...common(),
    receiptId: IDS.receipt,
    outcomeState: 'achieved',
    measurementDigest: 'd'.repeat(64),
    observedAt: '2026-07-24T12:00:00.000Z',
    verifiedByUserId: IDS.owner,
    actorType: 'human',
    actorId: IDS.owner,
    authorityTier: 'owner',
    evidence: {
      source_type: 'owner_verified_product_outcome',
      source_id: IDS.receipt,
      observed_at: '2026-07-24T12:00:00.000Z',
      measurement_digest: 'd'.repeat(64),
    },
  });
  assert.equal(planned.receiptId, IDS.receipt);
  assert.equal(planned.operationalActionPermitted, false);
});

test('mixed-case sensitive and undocumented nested metadata fails closed', () => {
  assert.throws(
    () => planProductEngineeringHeadReport(report({
      reportBody: {
        summary: 'synthetic',
        CustomerEmail: 'sensitive@example.test',
      },
    })),
    error => error.code === 'PROHIBITED_ACTION_INPUT'
      || error.code === 'METADATA_SHAPE_INVALID',
  );
  assert.throws(
    () => planProductEngineeringHeadCaseCommand(common({
      caseId: IDS.work,
      action: 'create_work',
      expectedRevision: 0,
      sourceReportId: IDS.report,
      ownerId: IDS.owner,
      assigneeId: IDS.assignee,
      slaDueAt: '2026-07-25T12:00:00.000Z',
      title: 'Strict evidence contract',
      contract: {
        objective: 'Verify the strict shape',
        acceptance_criteria: ['strict shape accepted'],
        RawPayload: { secret: true },
      },
      evidence: {
        source_type: 'supervised_work_contract',
        source_id: 'strict-work',
        observed_at: '2026-07-24T12:00:00.000Z',
      },
    })),
    error => error.code === 'PROHIBITED_ACTION_INPUT'
      || error.code === 'METADATA_SHAPE_INVALID',
  );
});

test('planner denies release, deploy, migration, provider, money, and legal actions', () => {
  for (const prohibited of [
    'mergeCode', 'deployProduction', 'applyMigration', 'activateFeature',
    'releaseTestFlight', 'provider', 'send', 'charge', 'changePricing',
    'changeLegalPolicy',
  ]) {
    assert.throws(
      () => planProductEngineeringHeadCaseCommand(common({
        caseId: IDS.work,
        action: 'accept_work',
        expectedRevision: 1,
        [prohibited]: true,
      })),
      error => error.code === 'PROHIBITED_ACTION_INPUT',
    );
  }
});

test('Head cannot approve its own recommendation', () => {
  assert.throws(
    () => planProductEngineeringHeadCaseCommand(common({
      caseId: '92611111-1111-4111-8111-111111111111',
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
