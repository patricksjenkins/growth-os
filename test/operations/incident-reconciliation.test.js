'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateIncidentReconciliationGate,
  planIncidentRecoveryReconciliation,
} = require('../../core/operations/incident-reconciliation');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
const WORK_ITEM_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-07-24T16:00:00.000Z';
const ENABLED = Object.freeze({
  controlPlaneApi: true,
  decisionQueueWrites: true,
  incidentReconciliationWrites: true,
});
const SYSTEM_ACTOR = Object.freeze({
  type: 'system',
  authority_tier: 'system',
});

function request(overrides = {}) {
  return {
    tenant_id: TENANT_ID,
    incident_id: INCIDENT_ID,
    work_item_id: WORK_ITEM_ID,
    expected_work_item_revision: 4,
    idempotency_key: `incident-recovered:${INCIDENT_ID}`,
    verification_method: 'successful_run',
    verification_reference: 'agent_job:44444444-4444-4444-8444-444444444444',
    observed_at: '2026-07-24T15:59:00.000Z',
    required_authority_tier: 'system',
    ...overrides,
  };
}

test('incident reconciliation is default-off behind all three write gates', () => {
  const result = evaluateIncidentReconciliationGate({
    actor: SYSTEM_ACTOR,
    flagSnapshot: {},
  });

  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasons, [
    'control_plane_api_disabled',
    'decision_queue_writes_disabled',
    'incident_reconciliation_writes_disabled',
  ]);
});

test('incident-specific gate is required even when generic control writes are enabled', () => {
  const result = evaluateIncidentReconciliationGate({
    actor: SYSTEM_ACTOR,
    flagSnapshot: {
      controlPlaneApi: true,
      decisionQueueWrites: true,
    },
  });

  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasons, ['incident_reconciliation_writes_disabled']);
});

test('planner emits a typed, tenant-bound request with deterministic fingerprint', () => {
  const first = planIncidentRecoveryReconciliation(request(), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });
  const second = planIncidentRecoveryReconciliation(request(), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(first.ok, true);
  assert.match(first.request_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.request_fingerprint, second.request_fingerprint);
  assert.equal(first.rpc.p_tenant_id, TENANT_ID);
  assert.equal(first.rpc.p_incident_id, INCIDENT_ID);
  assert.equal(first.rpc.p_work_item_id, WORK_ITEM_ID);
  assert.equal(first.rpc.p_feature_gate_enabled, true);
  assert.equal(first.rpc.p_actor_id, null);
});

test('idempotency key is not part of the semantic recovery fingerprint', () => {
  const one = planIncidentRecoveryReconciliation(request({
    idempotency_key: 'incident-recovery:attempt-a',
  }), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });
  const retry = planIncidentRecoveryReconciliation(request({
    idempotency_key: 'incident-recovery:attempt-b',
  }), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(one.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(one.request_fingerprint, retry.request_fingerprint);
});

test('actor identity is part of the immutable recovery fingerprint', () => {
  const system = planIncidentRecoveryReconciliation(request(), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });
  const owner = planIncidentRecoveryReconciliation(request({
    required_authority_tier: 'owner',
  }), {
    actor: { type: 'human', id: 'owner-1', authority_tier: 'owner' },
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(system.ok, true);
  assert.equal(owner.ok, true);
  assert.notEqual(system.request_fingerprint, owner.request_fingerprint);
});

test('planner fails closed on bad identity, stale revision, or future evidence', () => {
  const result = planIncidentRecoveryReconciliation(request({
    tenant_id: 'not-a-tenant',
    expected_work_item_revision: 0,
    verification_method: 'trust_me',
    verification_reference: '',
    observed_at: '2026-07-24T16:01:00.000Z',
  }), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('tenant_id must be a UUID'));
  assert.ok(result.errors.includes('expected_work_item_revision must be a positive integer'));
  assert.ok(result.errors.includes('verification_method is invalid'));
  assert.ok(result.errors.includes(
    'verification_reference must be an opaque namespace:value identifier'
  ));
  assert.ok(result.errors.includes('observed_at cannot be in the future'));
});

test('planner rejects overlong keys instead of silently truncating idempotency', () => {
  const result = planIncidentRecoveryReconciliation(request({
    idempotency_key: 'x'.repeat(201),
  }), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('idempotency_key must be between 8 and 200 characters'));
});

test('evidence references must identify a supported authoritative record type', () => {
  const denied = planIncidentRecoveryReconciliation(request({
    verification_reference: 'customer said their account is fixed',
  }), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });
  const allowed = planIncidentRecoveryReconciliation(request({
    verification_method: 'output_observed',
    verification_reference: 'lead:55555555-5555-4555-8555-555555555555',
  }), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(denied.ok, false);
  assert.ok(denied.errors.some((error) => error.includes('opaque namespace:value')));
  assert.equal(allowed.ok, true);
});

test('system recovery cannot close a work item reserved for owner authority', () => {
  const result = planIncidentRecoveryReconciliation(request({
    required_authority_tier: 'owner',
  }), {
    actor: SYSTEM_ACTOR,
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('insufficient_authority_tier'));
});
