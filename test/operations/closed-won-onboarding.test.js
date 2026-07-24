'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateClosedWonOnboardingGate,
  planClosedWonOnboardingCommand,
} = require('../../core/operations/closed-won-onboarding');

const SOURCE_TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT_TENANT = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const HANDOFF_ID = '55555555-5555-4555-8555-555555555555';
const WORKFLOW_ID = '66666666-6666-4666-8666-666666666666';
const NOW = '2026-07-24T18:00:00.000Z';
const DIGEST = 'a'.repeat(64);
const ACTOR = Object.freeze({
  type: 'human',
  id: '77777777-7777-4777-8777-777777777777',
});

function initiate(overrides = {}) {
  return {
    action: 'initiate',
    source_tenant_id: SOURCE_TENANT,
    lead_id: LEAD_ID,
    customer_id: CUSTOMER_ID,
    client_tenant_id: CLIENT_TENANT,
    source_event_key: `lead-won:${LEAD_ID}:2026-07-24T17:00:00.000Z`,
    closed_won_at: '2026-07-24T17:00:00.000Z',
    accept_by: '2026-07-24T19:00:00.000Z',
    acknowledge_by: '2026-07-24T20:00:00.000Z',
    idempotency_key: `closed-won:${LEAD_ID}`,
    ...overrides,
  };
}

function transition(action, overrides = {}) {
  return {
    action,
    source_tenant_id: SOURCE_TENANT,
    handoff_id: HANDOFF_ID,
    expected_revision: 2,
    idempotency_key: `${action}:${HANDOFF_ID}`,
    reason_code: `${action}_confirmed`,
    evidence_type: {
      accept: 'owner_acceptance',
      acknowledge: 'onboarding_workflow',
      record_retry: 'retry_attempt',
      raise_exception: 'exception',
      complete: 'completion',
    }[action],
    evidence_id: `${action}:${HANDOFF_ID}`,
    evidence_digest: DIGEST,
    evidence_observed_at: '2026-07-24T17:59:00.000Z',
    ...(action === 'acknowledge' ? { onboarding_workflow_id: WORKFLOW_ID } : {}),
    ...(action === 'record_retry'
      ? { retry_at: '2026-07-24T19:00:00.000Z', max_attempts: 5 }
      : {}),
    ...(action === 'raise_exception'
      ? { exception_code: 'missing_client_intake' }
      : {}),
    ...overrides,
  };
}

test('closed-won onboarding writes are independently default-off', () => {
  assert.deepEqual(evaluateClosedWonOnboardingGate(), {
    allowed: false,
    reasons: ['closed_won_onboarding_handoff_disabled'],
  });
  assert.equal(evaluateClosedWonOnboardingGate({ featureEnabled: true }).allowed, true);
});

test('initiate planner binds source lead/customer and client tenant identities', () => {
  const result = planClosedWonOnboardingCommand(initiate(), {
    actor: ACTOR,
    featureEnabled: true,
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.rpc.p_source_tenant_id, SOURCE_TENANT);
  assert.equal(result.rpc.p_lead_id, LEAD_ID);
  assert.equal(result.rpc.p_customer_id, CUSTOMER_ID);
  assert.equal(result.rpc.p_client_tenant_id, CLIENT_TENANT);
  assert.equal(result.rpc.p_feature_gate_enabled, true);
  assert.match(result.request_fingerprint, /^[a-f0-9]{64}$/);
});

test('semantic retries are deterministic but the idempotency key is not fingerprinted', () => {
  const first = planClosedWonOnboardingCommand(initiate({
    idempotency_key: 'first-attempt',
  }), { actor: ACTOR, featureEnabled: true, now: NOW });
  const retry = planClosedWonOnboardingCommand(initiate({
    idempotency_key: 'second-attempt',
  }), { actor: ACTOR, featureEnabled: true, now: NOW });

  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(first.request_fingerprint, retry.request_fingerprint);
});

test('initiate fails closed on invalid identities, timing, or disabled gate', () => {
  const result = planClosedWonOnboardingCommand(initiate({
    source_tenant_id: 'wrong',
    client_tenant_id: '',
    customer_id: 'wrong',
    closed_won_at: '2026-07-24T21:00:00.000Z',
    accept_by: '2026-07-24T16:00:00.000Z',
  }), { actor: ACTOR, now: NOW });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('source_tenant_id must be a UUID'));
  assert.ok(result.errors.includes('client_tenant_id must be a UUID'));
  assert.ok(result.errors.includes('customer_id must be a UUID when provided'));
  assert.ok(result.errors.includes('closed_won_at cannot be in the future'));
  assert.ok(result.errors.includes('accept_by must be after closed_won_at'));
  assert.ok(result.errors.includes('closed_won_onboarding_handoff_disabled'));
});

test('acknowledgment requires authoritative workflow identity and typed evidence', () => {
  const denied = planClosedWonOnboardingCommand(transition('acknowledge', {
    onboarding_workflow_id: null,
    evidence_type: 'owner_acceptance',
  }), { actor: ACTOR, featureEnabled: true, now: NOW });
  const allowed = planClosedWonOnboardingCommand(transition('acknowledge'), {
    actor: ACTOR,
    featureEnabled: true,
    now: NOW,
  });

  assert.equal(denied.ok, false);
  assert.ok(denied.errors.includes('onboarding_workflow_id must be a UUID for acknowledgment'));
  assert.ok(denied.errors.includes('evidence_type must be onboarding_workflow'));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.rpc.p_onboarding_workflow_id, WORKFLOW_ID);
});

test('retry requires future scheduling and bounded attempts', () => {
  const result = planClosedWonOnboardingCommand(transition('record_retry', {
    retry_at: '2026-07-24T17:00:00.000Z',
    max_attempts: 21,
  }), { actor: ACTOR, featureEnabled: true, now: NOW });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('retry_at must be in the future'));
  assert.ok(result.errors.includes('max_attempts must be an integer between 1 and 20'));
});

test('exception codes and evidence are machine-safe and digest-bound', () => {
  const result = planClosedWonOnboardingCommand(transition('raise_exception', {
    exception_code: 'Customer secret token',
    evidence_digest: 'not-a-digest',
  }), { actor: ACTOR, featureEnabled: true, now: NOW });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('exception_code must be a safe machine-readable identifier'));
  assert.ok(result.errors.includes('evidence_digest must be a SHA-256 hex digest'));
});

test('actor identity is part of the immutable semantic fingerprint', () => {
  const owner = planClosedWonOnboardingCommand(transition('accept'), {
    actor: ACTOR,
    featureEnabled: true,
    now: NOW,
  });
  const service = planClosedWonOnboardingCommand(transition('accept'), {
    actor: { type: 'service', id: 'onboarding-worker' },
    featureEnabled: true,
    now: NOW,
  });

  assert.equal(owner.ok, true);
  assert.equal(service.ok, false);
  assert.ok(service.errors.includes('evidence_type must be service_acceptance'));

  const serviceAccepted = planClosedWonOnboardingCommand(transition('accept', {
    evidence_type: 'service_acceptance',
  }), {
    actor: { type: 'service', id: 'onboarding-worker' },
    featureEnabled: true,
    now: NOW,
  });
  assert.equal(serviceAccepted.ok, true);
  assert.notEqual(owner.request_fingerprint, serviceAccepted.request_fingerprint);
});

test('system actors cannot manufacture handoff acceptance evidence', () => {
  const result = planClosedWonOnboardingCommand(transition('accept'), {
    actor: { type: 'system' },
    featureEnabled: true,
    now: NOW,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('accept requires a human owner or identified service'));
});

test('human actors require a verifiable UUID and system actors cannot spoof an identity', () => {
  const human = planClosedWonOnboardingCommand(transition('accept'), {
    actor: { type: 'human', id: 'owner-name' },
    featureEnabled: true,
    now: NOW,
  });
  const system = planClosedWonOnboardingCommand(transition('accept'), {
    actor: { type: 'system', id: 'pretend-owner' },
    featureEnabled: true,
    now: NOW,
  });

  assert.equal(human.ok, false);
  assert.ok(human.errors.includes('human actor.id must be a UUID'));
  assert.equal(system.ok, false);
  assert.ok(system.errors.includes('system actor.id must be empty'));
});
