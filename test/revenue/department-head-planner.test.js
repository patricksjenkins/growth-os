'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RevenueDepartmentHeadError,
  planRevenueCharterRegistration,
  planRevenueReportAcceptance,
  planRevenueHeadWorkCommand,
  planRevenueHeadKillSwitch,
} = require('../../core/revenue/department-head-planner');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHARTER = '22222222-2222-4222-8222-222222222222';
const REPORT = '33333333-3333-4333-8333-333333333333';
const ITEM = '44444444-4444-4444-8444-444444444444';

function evidence(count = 2) {
  return {
    schema_version: 1,
    sources: Array.from({ length: count }, (_, index) => ({
      source_type: index === 0 ? 'sales_ledger' : 'booking_ledger',
      source_id: `snapshot_2026_07_${index + 1}`,
      evidence_digest: String(index + 1).repeat(64),
      observed_at: `2026-07-24T12:0${index}:00.000Z`,
    })),
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => (
    error instanceof RevenueDepartmentHeadError && error.code === code
  ));
}

test('charter planner records mission and measurable KPIs but stays default-off', () => {
  const input = {
    tenantId: TENANT,
    actorId: OWNER,
    version: 1,
    mission: 'Own evidence-backed revenue health, surface exceptions, and coordinate accountable follow-through.',
    targets: {
      qualificationRateBps: 5000,
      appointmentRateBps: 6000,
      heldRateBps: 8000,
      proposalRateBps: 7500,
      winRateBps: 3000,
      maxSalesCycleDays: 45,
    },
    evidence: evidence(),
    idempotencyKey: 'revenue-head:charter:v1',
  };
  const first = planRevenueCharterRegistration(input);
  assert.deepEqual(first, planRevenueCharterRegistration(input));
  assert.equal(first.rpc, 'revenue_head_charter_register_rpc');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.equal(first.args.p_win_rate_target_bps, 3000);
  assert.match(first.args.p_request_fingerprint, /^[a-f0-9]{64}$/);
});

test('report planner accepts only monotonic structured funnel metrics', () => {
  const command = planRevenueReportAcceptance({
    tenantId: TENANT,
    charterId: CHARTER,
    reportId: REPORT,
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    sourceSystem: 'sales_ledger',
    sourceReportId: 'sales_snapshot_2026_07',
    metrics: {
      leadsCreated: 100,
      qualifiedLeads: 60,
      appointmentsBooked: 40,
      appointmentsHeld: 35,
      proposalsSent: 25,
      closedWon: 8,
      closedLost: 12,
      openPipelineMinor: 500000,
      bookedRevenueMinor: 200000,
      averageSalesCycleDays: 32,
    },
    currency: 'usd',
    evidence: evidence(),
    idempotencyKey: 'revenue-head:report:2026-07',
  });
  assert.equal(command.rpc, 'revenue_head_report_accept_rpc');
  assert.equal(command.args.p_currency, 'USD');
  assert.equal(command.args.p_feature_gate_enabled, false);

  expectCode(() => planRevenueReportAcceptance({
    tenantId: TENANT,
    charterId: CHARTER,
    reportId: REPORT,
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    sourceSystem: 'sales_ledger',
    sourceReportId: 'invalid_sequence',
    metrics: {
      leadsCreated: 10,
      qualifiedLeads: 11,
      appointmentsBooked: 0,
      appointmentsHeld: 0,
      proposalsSent: 0,
      closedWon: 0,
      closedLost: 0,
      openPipelineMinor: 0,
      bookedRevenueMinor: 0,
      averageSalesCycleDays: 0,
    },
    currency: 'USD',
    evidence: evidence(),
    idempotencyKey: 'revenue-head:report:invalid',
  }), 'FUNNEL_SEQUENCE_INVALID');
});

test('head work planner permits only evidence-based internal scopes', () => {
  const command = planRevenueHeadWorkCommand({
    tenantId: TENANT,
    itemId: ITEM,
    reportId: REPORT,
    command: 'create',
    expectedRevision: 0,
    actorType: 'agent',
    actorId: 'revenue-head-supervised',
    authorityTier: 'department_head',
    evidence: evidence(),
    idempotencyKey: 'revenue-head:item:create:1',
    itemKind: 'exception',
    actionScope: 'raise_exception',
    title: 'Win rate is below the accepted charter threshold',
    assigneeType: 'agent',
    assigneeId: 'revenue-head-supervised',
    dueAt: '2026-07-25T12:00:00Z',
  });
  assert.equal(command.rpc, 'revenue_head_work_command_rpc');
  assert.equal(command.args.p_action_scope, 'raise_exception');
  assert.equal(command.args.p_feature_gate_enabled, false);

  expectCode(() => planRevenueHeadWorkCommand({
    tenantId: TENANT,
    itemId: ITEM,
    reportId: REPORT,
    command: 'create',
    expectedRevision: 0,
    actorType: 'agent',
    actorId: 'revenue-head-supervised',
    authorityTier: 'department_head',
    evidence: evidence(),
    idempotencyKey: 'revenue-head:item:send',
    itemKind: 'work',
    actionScope: 'send_outreach',
    title: 'Forbidden',
    assigneeType: 'agent',
    assigneeId: 'revenue-head-supervised',
    dueAt: '2026-07-25T12:00:00Z',
  }), 'SUPERVISED_SCOPE_INVALID');
});

test('planner rejects provider, recipient, pricing, and financial mutation inputs', () => {
  for (const forbidden of [
    { recipient: 'opaque-contact' },
    { provider: 'telnyx' },
    { pricing: { amount: 10 } },
    { charge: true },
  ]) {
    expectCode(() => planRevenueHeadWorkCommand({
      tenantId: TENANT,
      itemId: ITEM,
      reportId: REPORT,
      command: 'create',
      expectedRevision: 0,
      actorType: 'agent',
      actorId: 'revenue-head-supervised',
      authorityTier: 'department_head',
      evidence: evidence(),
      idempotencyKey: 'revenue-head:item:forbidden',
      itemKind: 'work',
      actionScope: 'analyze_funnel',
      title: 'Analyze funnel',
      assigneeType: 'agent',
      assigneeId: 'revenue-head-supervised',
      dueAt: '2026-07-25T12:00:00Z',
      ...forbidden,
    }), 'PROHIBITED_ACTION_INPUT');
  }
});

test('owner decisions and head authority are distinct', () => {
  const decision = planRevenueHeadWorkCommand({
    tenantId: TENANT,
    itemId: ITEM,
    reportId: REPORT,
    command: 'record_decision',
    expectedRevision: 2,
    actorType: 'human',
    actorId: OWNER,
    authorityTier: 'owner',
    evidence: evidence(),
    idempotencyKey: 'revenue-head:decision:1',
    completionEvidenceDigest: 'a'.repeat(64),
    decision: 'approved',
  });
  assert.equal(decision.args.p_authority_tier, 'owner');
  assert.equal(decision.args.p_decision, 'approved');

  expectCode(() => planRevenueHeadWorkCommand({
    tenantId: TENANT,
    itemId: ITEM,
    reportId: REPORT,
    command: 'record_decision',
    expectedRevision: 2,
    actorType: 'agent',
    actorId: 'revenue-head-supervised',
    authorityTier: 'owner',
    evidence: evidence(),
    idempotencyKey: 'revenue-head:decision:spoof',
    completionEvidenceDigest: 'a'.repeat(64),
    decision: 'approved',
  }), 'ACTOR_AUTHORITY_INVALID');
});

test('evidence must be structured, cited, and PII-free', () => {
  expectCode(() => planRevenueCharterRegistration({
    tenantId: TENANT,
    actorId: OWNER,
    version: 1,
    mission: 'Own evidence-backed revenue health, surface exceptions, and coordinate accountable follow-through.',
    targets: {
      qualificationRateBps: 5000,
      appointmentRateBps: 6000,
      heldRateBps: 8000,
      proposalRateBps: 7500,
      winRateBps: 3000,
      maxSalesCycleDays: 45,
    },
    evidence: {
      schema_version: 1,
      sources: [{
        source_type: 'sales_ledger',
        source_id: 'snapshot',
        evidence_digest: 'a'.repeat(64),
        observed_at: '2026-07-24T12:00:00Z',
        email: 'forbidden@example.invalid',
      }],
    },
    idempotencyKey: 'revenue-head:charter:pii',
  }), 'PROHIBITED_ACTION_INPUT');

  const duplicate = evidence();
  duplicate.sources[1] = { ...duplicate.sources[0] };
  expectCode(() => planRevenueCharterRegistration({
    tenantId: TENANT,
    actorId: OWNER,
    version: 1,
    mission: 'Own evidence-backed revenue health, surface exceptions, and coordinate accountable follow-through.',
    targets: {
      qualificationRateBps: 5000,
      appointmentRateBps: 6000,
      heldRateBps: 8000,
      proposalRateBps: 7500,
      winRateBps: 3000,
      maxSalesCycleDays: 45,
    },
    evidence: duplicate,
    idempotencyKey: 'revenue-head:charter:duplicate',
  }), 'EVIDENCE_SOURCE_DUPLICATE');
});

test('kill-switch command has no enable or authority parameters', () => {
  assert.deepEqual(planRevenueHeadKillSwitch({
    tenantId: TENANT,
    reasonCode: 'funnel_evidence_mismatch',
  }), {
    rpc: 'revenue_head_kill_switch_rpc',
    args: {
      p_tenant_id: TENANT,
      p_reason: 'funnel_evidence_mismatch',
    },
  });
});
