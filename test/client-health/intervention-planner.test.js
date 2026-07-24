'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ClientHealthPlanningError,
  planClientHealthSignalSnapshot,
  planClientHealthInterventionCommand,
} = require('../../core/client-health/intervention-planner');

const IDS = Object.freeze({
  tenant: '11111111-1111-4111-8111-111111111111',
  customer: 'cccccccc-1111-4111-8111-111111111111',
  snapshot: '83111111-1111-4111-8111-111111111111',
  intervention: '83211111-1111-4111-8111-111111111111',
  owner: 'eeeeeeee-1111-4111-8111-111111111111',
  assignee: '77777777-1111-4111-8111-111111111111',
});

function base(overrides = {}) {
  return {
    tenantId: IDS.tenant,
    customerId: IDS.customer,
    interventionId: IDS.intervention,
    expectedRevision: 0,
    expectedControlRevision: 0,
    featureGateEnabled: true,
    idempotencyKey: 'client-health:test:open',
    requestFingerprint: 'a'.repeat(64),
    actorType: 'service',
    actorId: 'client-health-shadow-worker',
    authorityTier: 'client_success',
    evidence: {
      source_type: 'intervention_assignment',
      source_id: 'synthetic-assignment',
      observed_at: '2026-07-24T12:00:00.000Z',
    },
    ...overrides,
  };
}

test('signal planner contains heuristic health and produces no external action', () => {
  const planned = planClientHealthSignalSnapshot({
    tenantId: IDS.tenant,
    customerId: IDS.customer,
    snapshotId: IDS.snapshot,
    signalState: 'at_risk',
    provenanceType: 'heuristic',
    dimensions: { engagement: { state: 'unproven', observation_count: 3 } },
    expectedControlRevision: 0,
    featureGateEnabled: true,
    idempotencyKey: 'client-health:test:signal',
    requestFingerprint: 'b'.repeat(64),
    actorType: 'system',
    actorId: null,
    authorityTier: 'system',
    evidence: {
      source_type: 'heuristic_snapshot',
      source_id: 'synthetic-score-v1',
      observed_at: '2026-07-24T12:00:00.000Z',
    },
  });

  assert.equal(planned.signalState, 'at_risk');
  assert.equal(planned.provenanceType, 'heuristic');
  assert.equal(planned.externalActionPermitted, false);
  assert.match(planned.semanticFingerprint, /^[a-f0-9]{64}$/);
  assert.match(planned.evidenceDigest, /^[a-f0-9]{64}$/);
});

test('heuristics cannot assert a stable outcome', () => {
  assert.throws(
    () => planClientHealthSignalSnapshot({
      tenantId: IDS.tenant,
      customerId: IDS.customer,
      snapshotId: IDS.snapshot,
      signalState: 'stable',
      provenanceType: 'heuristic',
      dimensions: { engagement: { state: 'green' } },
      expectedControlRevision: 0,
      featureGateEnabled: true,
      idempotencyKey: 'client-health:test:stable',
      requestFingerprint: 'c'.repeat(64),
      actorType: 'system',
      actorId: null,
      authorityTier: 'system',
      evidence: {
        source_type: 'heuristic_snapshot',
        source_id: 'synthetic-score-v1',
        observed_at: '2026-07-24T12:00:00.000Z',
      },
    }),
    error => error instanceof ClientHealthPlanningError
      && error.code === 'HEURISTIC_STABILITY_FORBIDDEN'
  );
});

test('opening requires exact identity, assignment, SLA, and measurable plan', () => {
  const planned = planClientHealthInterventionCommand(base({
    action: 'open_intervention',
    signalSnapshotId: IDS.snapshot,
    ownerId: IDS.owner,
    assigneeId: IDS.assignee,
    slaDueAt: '2026-07-25T12:00:00.000Z',
    actionPlan: {
      objective: 'Restore verified adoption',
      action_type: 'guided_activation_review',
      success_metric: 'verified_activation_receipt',
    },
  }));

  assert.equal(planned.expectedRevision, 0);
  assert.equal(planned.assigneeId, IDS.assignee);
  assert.equal(planned.externalActionPermitted, false);
  assert.match(planned.semanticFingerprint, /^[a-f0-9]{64}$/);
});

test('outcome planner only accepts an outcome receipt', () => {
  assert.throws(
    () => planClientHealthInterventionCommand(base({
      action: 'record_outcome',
      expectedRevision: 4,
      outcomeState: 'improved',
      evidence: {
        source_type: 'heuristic_snapshot',
        source_id: 'synthetic-green-score',
        observed_at: '2026-07-26T12:00:00.000Z',
      },
    })),
    error => error instanceof ClientHealthPlanningError
      && error.code === 'OUTCOME_EVIDENCE_INVALID'
  );

  const planned = planClientHealthInterventionCommand(base({
    action: 'record_outcome',
    expectedRevision: 4,
    outcomeState: 'improved',
    evidence: {
      source_type: 'client_outcome_receipt',
      source_id: 'synthetic-verified-activation',
      observed_at: '2026-07-26T12:00:00.000Z',
    },
  }));
  assert.equal(planned.outcomeState, 'improved');
});

test('planner rejects disabled gates and communication/provider payloads', () => {
  assert.throws(
    () => planClientHealthInterventionCommand(base({
      action: 'accept_assignment',
      featureGateEnabled: false,
    })),
    error => error.code === 'FEATURE_GATE_DISABLED'
  );
  assert.throws(
    () => planClientHealthInterventionCommand(base({
      action: 'accept_assignment',
      sendEmail: true,
    })),
    error => error.code === 'EXTERNAL_ACTION_FORBIDDEN'
  );
});

test('semantic fingerprints are stable across object key order', () => {
  const common = base({
    action: 'open_intervention',
    signalSnapshotId: IDS.snapshot,
    ownerId: IDS.owner,
    assigneeId: IDS.assignee,
    slaDueAt: '2026-07-25T12:00:00.000Z',
  });
  const first = planClientHealthInterventionCommand({
    ...common,
    actionPlan: {
      objective: 'Verify adoption',
      action_type: 'activation_review',
      success_metric: 'activation_receipt',
    },
  });
  const second = planClientHealthInterventionCommand({
    ...common,
    actionPlan: {
      success_metric: 'activation_receipt',
      objective: 'Verify adoption',
      action_type: 'activation_review',
    },
  });
  assert.equal(first.semanticFingerprint, second.semanticFingerprint);
});
