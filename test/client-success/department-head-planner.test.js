'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ClientSuccessHeadError,
  planClientSuccessCharter,
  planClientSuccessSupportSnapshot,
  planClientSuccessReport,
  planClientSuccessWork,
  planClientSuccessKillSwitch,
} = require('../../core/client-success/department-head-planner');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHARTER = '22222222-2222-4222-8222-222222222222';
const REPORT = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const SNAPSHOT = '55555555-5555-4555-8555-555555555555';
const INTERVENTION = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const SUPPORT_SNAPSHOT = '88888888-8888-4888-8888-888888888888';
const HEAD = 'client-success-head-supervised';
const SUPPORT_ADAPTER = 'client-success-support-adapter';

function evidence() {
  return {
    schema_version: 1,
    sources: [{
      source_type: 'client_health_ledger',
      source_id: 'snapshot_2026_07',
      evidence_digest: 'a'.repeat(64),
      observed_at: '2026-07-24T12:00:00.000Z',
    }, {
      source_type: 'support_ledger',
      source_id: 'support_2026_07',
      evidence_digest: 'b'.repeat(64),
      observed_at: '2026-07-24T12:01:00.000Z',
    }],
  };
}

function expectCode(fn, code) {
  assert.throws(fn, error => (
    error instanceof ClientSuccessHeadError && error.code === code
  ));
}

test('charter captures mission and measurable KPIs while staying default-off', () => {
  const input = {
    tenantId: TENANT,
    actorId: OWNER,
    version: 1,
    mission: 'Protect client outcomes using observed health and support evidence while escalating material exceptions.',
    kpis: {
      maxFirstResponseMinutes: 60,
      maxResolutionMinutes: 1440,
      maxSlaBreachRateBps: 500,
      minCsatBps: 9000,
      maxOpenCriticalTickets: 1,
    },
    evidence: evidence(),
    idempotencyKey: 'client-success:charter:v1',
  };
  const command = planClientSuccessCharter(input);
  assert.deepEqual(command, planClientSuccessCharter(input));
  assert.equal(command.rpc, 'client_success_head_charter_register_rpc');
  assert.equal(command.args.p_feature_gate_enabled, false);
  assert.equal(command.args.p_min_csat_bps, 9000);
  assert.match(command.args.p_request_fingerprint, /^[a-f0-9]{64}$/);
});

test('canonical support snapshot is adapter-authored and default-off', () => {
  const input = {
    tenantId: TENANT,
    snapshotId: SUPPORT_SNAPSHOT,
    customerId: CUSTOMER,
    sourceSnapshotId: 'support_snapshot_2026_07',
    evidenceDigest: 'c'.repeat(64),
    observedAt: '2026-07-24T12:00:00Z',
    verificationState: 'verified',
    metrics: {
      openedTickets: 10,
      resolvedTickets: 9,
      slaBreachedTickets: 1,
      openCriticalTickets: 0,
      firstResponseMinutes: 30,
      resolutionMinutes: 600,
      csatBps: 9500,
    },
    actorId: SUPPORT_ADAPTER,
    idempotencyKey: 'client-success:support:2026-07',
  };
  const command = planClientSuccessSupportSnapshot(input);
  assert.deepEqual(command, planClientSuccessSupportSnapshot(input));
  assert.equal(command.rpc, 'client_success_support_snapshot_record_rpc');
  assert.equal(command.args.p_authority_tier, 'support_evidence_adapter');
  assert.equal(command.args.p_verification_state, 'verified');
  assert.equal(command.args.p_feature_gate_enabled, false);
});

test('report binds canonical support snapshot and exact Department Head identity', () => {
  const command = planClientSuccessReport({
    tenantId: TENANT,
    charterId: CHARTER,
    reportId: REPORT,
    customerId: CUSTOMER,
    healthSnapshotId: SNAPSHOT,
    interventionId: INTERVENTION,
    supportSnapshotId: SUPPORT_SNAPSHOT,
    actorId: HEAD,
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    evidence: evidence(),
    idempotencyKey: 'client-success:report:2026-07',
  });
  assert.equal(command.rpc, 'client_success_head_report_accept_rpc');
  assert.equal(command.args.p_customer_id, CUSTOMER);
  assert.equal(command.args.p_intervention_id, INTERVENTION);
  assert.equal(command.args.p_support_snapshot_id, SUPPORT_SNAPSHOT);
  assert.equal(command.args.p_actor_id, HEAD);
  assert.equal(command.args.p_authority_tier, 'department_head');
  assert.equal(command.args.p_feature_gate_enabled, false);
});

test('support snapshot rejects internally inconsistent aggregates', () => {
  expectCode(() => planClientSuccessSupportSnapshot({
    tenantId: TENANT,
    snapshotId: SUPPORT_SNAPSHOT,
    customerId: CUSTOMER,
    sourceSnapshotId: 'support_snapshot_invalid',
    evidenceDigest: 'c'.repeat(64),
    observedAt: '2026-07-24T12:00:00Z',
    verificationState: 'verified',
    metrics: {
      openedTickets: 2,
      resolvedTickets: 3,
      slaBreachedTickets: 0,
      openCriticalTickets: 0,
      firstResponseMinutes: 30,
      resolutionMinutes: 600,
      csatBps: 9500,
    },
    actorId: SUPPORT_ADAPTER,
    idempotencyKey: 'client-success:support:invalid',
  }), 'SUPPORT_METRIC_INVALID');
});

test('report refuses caller-provided support source, digest, or metrics', () => {
  for (const injected of [
    { supportSourceId: 'stable_support' },
    { supportEvidenceDigest: 'c'.repeat(64) },
    { supportObservedAt: '2026-07-24T12:00:00Z' },
    { metrics: { openedTickets: 0 } },
  ]) {
    expectCode(() => planClientSuccessReport({
      tenantId: TENANT,
      charterId: CHARTER,
      reportId: REPORT,
      customerId: CUSTOMER,
      healthSnapshotId: SNAPSHOT,
      supportSnapshotId: SUPPORT_SNAPSHOT,
      actorId: HEAD,
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      evidence: evidence(),
      idempotencyKey: 'client-success:report:caller-evidence',
      ...injected,
    }), 'CALLER_SUPPORT_EVIDENCE_FORBIDDEN');
  }
});

test('evidence manifests reject fields outside the minimized citation contract', () => {
  const expanded = evidence();
  expanded.sources[0].customer_name = 'forbidden';
  expectCode(() => planClientSuccessReport({
    tenantId: TENANT,
    charterId: CHARTER,
    reportId: REPORT,
    customerId: CUSTOMER,
    healthSnapshotId: SNAPSHOT,
    supportSnapshotId: SUPPORT_SNAPSHOT,
    actorId: HEAD,
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    evidence: expanded,
    idempotencyKey: 'client-success:report:expanded-evidence',
  }), 'PROHIBITED_ACTION_INPUT');

  const unsupported = evidence();
  unsupported.sources[0].confidence = 1;
  expectCode(() => planClientSuccessReport({
    tenantId: TENANT,
    charterId: CHARTER,
    reportId: REPORT,
    customerId: CUSTOMER,
    healthSnapshotId: SNAPSHOT,
    supportSnapshotId: SUPPORT_SNAPSHOT,
    actorId: HEAD,
    periodStart: '2026-07-01',
    periodEnd: '2026-07-31',
    evidence: unsupported,
    idempotencyKey: 'client-success:report:unsupported-evidence',
  }), 'EVIDENCE_SOURCE_INVALID');
});

test('work planner permits only supervised internal scopes', () => {
  const command = planClientSuccessWork({
    tenantId: TENANT,
    itemId: ITEM,
    reportId: REPORT,
    command: 'create',
    expectedRevision: 0,
    actorType: 'agent',
    actorId: 'client-success-head-supervised',
    authorityTier: 'department_head',
    evidence: evidence(),
    idempotencyKey: 'client-success:item:create:1',
    itemKind: 'work',
    actionScope: 'recommend_intervention',
    title: 'Recommend an intervention for owner review',
    assigneeType: 'agent',
    assigneeId: 'client-success-head-supervised',
    dueAt: '2026-07-25T12:00:00Z',
  });
  assert.equal(command.args.p_action_scope, 'recommend_intervention');
  assert.equal(command.args.p_feature_gate_enabled, false);

  expectCode(() => planClientSuccessWork({
    tenantId: TENANT,
    itemId: ITEM,
    reportId: REPORT,
    command: 'create',
    expectedRevision: 0,
    actorType: 'agent',
    actorId: 'client-success-head-supervised',
    authorityTier: 'department_head',
    evidence: evidence(),
    idempotencyKey: 'client-success:item:send',
    itemKind: 'work',
    actionScope: 'send_customer_message',
    title: 'Forbidden customer communication',
    assigneeType: 'agent',
    assigneeId: 'client-success-head-supervised',
    dueAt: '2026-07-25T12:00:00Z',
  }), 'SUPERVISED_SCOPE_INVALID');
});

test('planner rejects customer PII, provider dispatch, and money inputs', () => {
  for (const forbidden of [
    { customerEmail: 'forbidden@example.invalid' },
    { customer_email: 'forbidden@example.invalid' },
    { Email: 'forbidden@example.invalid' },
    { provider: 'telnyx' },
    { reply: 'send this' },
    { refund: true },
  ]) {
    expectCode(() => planClientSuccessWork({
      tenantId: TENANT,
      itemId: ITEM,
      reportId: REPORT,
      command: 'create',
      expectedRevision: 0,
      actorType: 'agent',
      actorId: 'client-success-head-supervised',
      authorityTier: 'department_head',
      evidence: evidence(),
      idempotencyKey: 'client-success:item:forbidden',
      itemKind: 'work',
      actionScope: 'analyze_client_health',
      title: 'Analyze client health evidence',
      assigneeType: 'agent',
      assigneeId: 'client-success-head-supervised',
      dueAt: '2026-07-25T12:00:00Z',
      ...forbidden,
    }), 'PROHIBITED_ACTION_INPUT');
  }
});

test('owner decisions are distinct and kill switch carries no payload', () => {
  const decision = planClientSuccessWork({
    tenantId: TENANT,
    itemId: ITEM,
    reportId: REPORT,
    command: 'record_decision',
    expectedRevision: 2,
    actorType: 'human',
    actorId: OWNER,
    authorityTier: 'owner',
    evidence: evidence(),
    idempotencyKey: 'client-success:decision:1',
    completionEvidenceDigest: 'd'.repeat(64),
    decision: 'approved',
  });
  assert.equal(decision.args.p_authority_tier, 'owner');
  assert.equal(decision.args.p_decision, 'approved');
  assert.deepEqual(planClientSuccessKillSwitch({
    tenantId: TENANT,
    reasonCode: 'operator_request',
  }), {
    rpc: 'client_success_head_kill_switch_rpc',
    args: { p_tenant_id: TENANT, p_reason: 'operator_request' },
  });
});
