'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateWorkItemInput,
  evaluateWriteAuthority,
  evaluateCurrentWriteAuthority,
  planWorkItemCreate,
  planWorkItemTransition,
  buildIdempotencyKey,
  fingerprintRequest,
  classifyIdempotentReplay,
} = require('../../core/operations/work-items');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-07-24T12:00:00.000Z';
const ENABLED = Object.freeze({
  controlPlaneApi: true,
  decisionQueueWrites: true,
  productionAuthority: false,
  departmentHeads: false,
  chiefOfStaff: false,
});

function baseInput(overrides = {}) {
  return {
    tenant_id: TENANT_ID,
    kind: 'decision',
    department: 'Revenue',
    title: 'Approve copy experiment',
    priority: 'high',
    authority_tier: 'owner',
    source_type: 'attention_queue',
    source_id: 'source-123',
    idempotency_key: 'attention:source-123',
    action_protocol: { action: 'review_copy_diff', version: 1 },
    acceptance_criteria: { required: ['owner_decision'] },
    due_at: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

function baseItem(overrides = {}) {
  return {
    id: ITEM_ID,
    tenant_id: TENANT_ID,
    status: 'in_progress',
    revision: 3,
    authority_tier: 'owner',
    verification_state: 'pending',
    ...overrides,
  };
}

test('validation normalizes a safe item while preserving attention_queue compatibility', () => {
  const attentionId = '33333333-3333-4333-8333-333333333333';
  const result = validateWorkItemInput(baseInput({
    attention_queue_id: attentionId,
    department: '  Revenue  ',
  }));

  assert.equal(result.valid, true);
  assert.equal(result.value.department, 'Revenue');
  assert.equal(result.value.status, 'open');
  assert.equal(result.value.attention_queue_id, attentionId);
  assert.deepEqual(result.value.action_protocol, { action: 'review_copy_diff', version: 1 });
});

test('validation rejects secret-like keys from protocols and evidence', () => {
  const result = validateWorkItemInput(baseInput({
    action_protocol: { request: { api_token: 'must-not-be-stored' } },
  }));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('forbidden sensitive key')));
  assert.ok(result.errors.some((error) => error.includes('api_token')));
});

test('all ledger writes are denied when the existing Autonomous OS write flags are absent', () => {
  const decision = evaluateWriteAuthority({
    actor: { type: 'human', id: 'owner-1', authority_tier: 'owner' },
    requiredTier: 'owner',
    flagSnapshot: {},
  });

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons, [
    'control_plane_api_disabled',
    'decision_queue_writes_disabled',
  ]);
});

test('the environment-backed gate also defaults off', () => {
  const names = [
    'FGA_OS_CONTROL_PLANE_API_ENABLED',
    'FGA_OS_DECISION_QUEUE_WRITES_ENABLED',
    'FGA_OS_PRODUCTION_AUTHORITY_ENABLED',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const decision = evaluateCurrentWriteAuthority({
      actor: { type: 'human', id: 'owner-1', authority_tier: 'owner' },
      requiredTier: 'owner',
    });
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.includes('control_plane_api_disabled'));
    assert.ok(decision.reasons.includes('decision_queue_writes_disabled'));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('an enabled ledger still cannot exercise disabled autonomous authority', () => {
  const departmentHead = evaluateWriteAuthority({
    actor: { type: 'agent', id: 'head-revenue', authority_tier: 'department_head' },
    requiredTier: 'department_head',
    flagSnapshot: ENABLED,
  });
  const chief = evaluateWriteAuthority({
    actor: { type: 'agent', id: 'company-cos', authority_tier: 'chief_of_staff' },
    requiredTier: 'chief_of_staff',
    flagSnapshot: ENABLED,
  });
  const production = evaluateWriteAuthority({
    actor: { type: 'human', id: 'owner-1', authority_tier: 'owner' },
    requiredTier: 'owner',
    productionAction: true,
    flagSnapshot: ENABLED,
  });

  assert.equal(departmentHead.allowed, false);
  assert.ok(departmentHead.reasons.includes('department_heads_disabled'));
  assert.equal(chief.allowed, false);
  assert.ok(chief.reasons.includes('chief_of_staff_disabled'));
  assert.equal(production.allowed, false);
  assert.ok(production.reasons.includes('production_authority_disabled'));
});

test('a system producer may raise an owner decision without gaining owner authority', () => {
  const creation = planWorkItemCreate(baseInput(), {
    actor: { type: 'system', authority_tier: 'system' },
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(creation.ok, true);
  assert.equal(creation.row.authority_tier, 'owner');
  assert.equal(creation.row.created_by_type, 'system');
  assert.equal(creation.event.to_status, 'open');

  const attemptedResolution = planWorkItemTransition({
    ...baseItem(),
    authority_tier: 'owner',
  }, {
    to_status: 'verified',
    expected_revision: 3,
    idempotency_key: 'verify:attempt-1',
    verification_state: 'passed',
    verification_evidence: { source_state: 'fixed' },
  }, {
    actor: { type: 'system', authority_tier: 'system' },
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(attemptedResolution.ok, false);
  assert.ok(attemptedResolution.errors.includes('insufficient_authority_tier'));
});

test('creation rejects a due date before the creation clock', () => {
  const creation = planWorkItemCreate(baseInput({
    due_at: '2026-07-23T12:00:00.000Z',
  }), {
    actor: { type: 'system', authority_tier: 'system' },
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(creation.ok, false);
  assert.ok(creation.errors.includes('due_at cannot be before creation time'));
});

test('claim requires an assignee and produces an immutable transition plan', () => {
  const item = baseItem({ status: 'open' });
  const missing = planWorkItemTransition(item, {
    to_status: 'claimed',
    expected_revision: 3,
    idempotency_key: 'claim:missing-assignee',
  }, {
    actor: { type: 'human', id: 'owner-1', authority_tier: 'owner' },
    flagSnapshot: ENABLED,
    now: NOW,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes('claim requires assignee_id'));

  const claimed = planWorkItemTransition(item, {
    to_status: 'claimed',
    expected_revision: 3,
    idempotency_key: 'claim:owner-1',
    assignee_type: 'human',
    assignee_id: 'owner-1',
  }, {
    actor: { type: 'human', id: 'owner-1', authority_tier: 'owner' },
    flagSnapshot: ENABLED,
    now: NOW,
  });

  assert.equal(claimed.ok, true);
  assert.deepEqual(claimed.patch, {
    status: 'claimed',
    reason_code: null,
    claimed_at: NOW,
    assignee_type: 'human',
    assignee_id: 'owner-1',
  });
  assert.equal(claimed.event.event_type, 'claimed');
  assert.equal(item.status, 'open');
  assert.equal(item.assignee_id, undefined);
});

test('verification requires evidence and optimistic revision match', () => {
  const actor = { type: 'human', id: 'owner-1', authority_tier: 'owner' };
  const noEvidence = planWorkItemTransition(baseItem(), {
    to_status: 'verified',
    expected_revision: 3,
    idempotency_key: 'verify:no-evidence',
    verification_state: 'passed',
  }, { actor, flagSnapshot: ENABLED, now: NOW });
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.errors.includes('passed verification requires evidence'));

  const stale = planWorkItemTransition(baseItem(), {
    to_status: 'verified',
    expected_revision: 2,
    idempotency_key: 'verify:stale',
    verification_state: 'passed',
    verification_evidence: { source_status: 'resolved' },
  }, { actor, flagSnapshot: ENABLED, now: NOW });
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.includes('revision_conflict'));

  const verified = planWorkItemTransition(baseItem(), {
    to_status: 'verified',
    expected_revision: 3,
    idempotency_key: 'verify:valid',
    verification_state: 'passed',
    verification_evidence: { source_status: 'resolved', checked_at: NOW },
  }, { actor, flagSnapshot: ENABLED, now: NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.patch.status, 'verified');
  assert.equal(verified.patch.verification_state, 'passed');
  assert.equal(verified.patch.verified_at, NOW);
  assert.equal(verified.patch.resolved_at, NOW);
  assert.equal(verified.event.event_type, 'verified');
  assert.match(verified.event.request_fingerprint, /^[a-f0-9]{64}$/);
});

test('terminal work can reopen only with a reason', () => {
  const actor = { type: 'human', id: 'owner-1', authority_tier: 'owner' };
  const item = baseItem({
    status: 'verified',
    verification_state: 'passed',
    verified_at: NOW,
    resolved_at: NOW,
  });
  const denied = planWorkItemTransition(item, {
    to_status: 'open',
    expected_revision: 3,
    idempotency_key: 'reopen:no-reason',
  }, { actor, flagSnapshot: ENABLED, now: NOW });
  assert.equal(denied.ok, false);
  assert.ok(denied.errors.includes('reason_code is required for dismiss, cancel, or reopen'));

  const reopened = planWorkItemTransition(item, {
    to_status: 'open',
    expected_revision: 3,
    idempotency_key: 'reopen:source-regressed',
    reason_code: 'source_regressed',
  }, { actor, flagSnapshot: ENABLED, now: NOW });
  assert.equal(reopened.ok, true);
  assert.equal(reopened.event.event_type, 'reopened');
  assert.equal(reopened.patch.resolved_at, null);
  assert.equal(reopened.patch.verification_state, 'pending');
});

test('idempotency is deterministic and distinguishes replay from key conflict', () => {
  const one = buildIdempotencyKey([TENANT_ID, 'attention_queue', 'row-7']);
  const two = buildIdempotencyKey([TENANT_ID, 'attention_queue', 'row-7']);
  assert.equal(one, two);
  assert.match(one, /^work:v1:[a-f0-9]{64}$/);

  const request = { to_status: 'verified', evidence: { b: 2, a: 1 } };
  const sameFingerprint = fingerprintRequest({ evidence: { a: 1, b: 2 }, to_status: 'verified' });
  assert.equal(
    classifyIdempotentReplay({ existingFingerprint: sameFingerprint, request }).decision,
    'replay'
  );
  assert.equal(
    classifyIdempotentReplay({
      existingFingerprint: sameFingerprint,
      request: { to_status: 'dismissed', evidence: { a: 1, b: 2 } },
    }).decision,
    'conflict'
  );
});
