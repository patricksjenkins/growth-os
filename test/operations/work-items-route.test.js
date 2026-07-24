'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const route = require('../../api/routes/work-items');
const {
  planWorkItemCreate,
  planWorkItemTransition,
} = require('../../core/operations/work-items');

const {
  buildCreateRpcArgs,
  buildTransitionRpcArgs,
  currentHumanActor,
  ownerCreateInputErrors,
  ownerTransitionInputErrors,
  parseListQuery,
  requireControlPlane,
  requireControlPlaneWrites,
  rpcErrorResponse,
  sortItems,
  validateRpcResult,
} = route._internal;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER_A = 'eeeeeeee-1111-4111-8111-111111111111';

function commandItem(overrides = {}) {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    tenant_id: TENANT_A,
    schema_version: 1,
    kind: 'decision',
    department: 'executive',
    title: 'Decision',
    summary: null,
    status: 'open',
    priority: 'normal',
    authority_tier: 'owner',
    assignee_type: 'unassigned',
    assignee_id: null,
    source_type: 'manual_owner',
    source_id: 'fixture',
    entity_type: null,
    entity_id: null,
    verification_state: 'not_required',
    reason_code: null,
    sla_started_at: '2026-07-24T12:00:00.000Z',
    due_at: null,
    claimed_at: null,
    started_at: null,
    submitted_for_verification_at: null,
    verified_at: null,
    resolved_at: null,
    created_at: '2026-07-24T12:00:00.000Z',
    updated_at: '2026-07-24T12:00:00.000Z',
    revision: 1,
    ...overrides,
  };
}

function commandEvent(overrides = {}) {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    tenant_id: TENANT_A,
    work_item_id: '10000000-0000-4000-8000-000000000001',
    schema_version: 1,
    event_type: 'created',
    from_status: null,
    to_status: 'open',
    actor_type: 'human',
    actor_id: USER_A,
    authority_tier: 'owner',
    reason_code: null,
    occurred_at: '2026-07-24T12:00:00.000Z',
    created_at: '2026-07-24T12:00:00.000Z',
    ...overrides,
  };
}

function withFlag(value, fn) {
  const key = 'FGA_OS_CONTROL_PLANE_API_ENABLED';
  const cohortKey = 'FGA_OS_CONTROL_PLANE_TENANT_ALLOWLIST';
  const previous = process.env[key];
  const previousCohort = process.env[cohortKey];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    process.env[cohortKey] = TENANT_A;
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    if (previousCohort === undefined) delete process.env[cohortKey];
    else process.env[cohortKey] = previousCohort;
  }
}

function withWriteFlag(value, cohort, fn) {
  const key = 'FGA_OS_DECISION_QUEUE_WRITES_ENABLED';
  const cohortKey = 'FGA_OS_DECISION_QUEUE_WRITE_TENANT_ALLOWLIST';
  const previous = process.env[key];
  const previousCohort = process.env[cohortKey];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    if (cohort === undefined) delete process.env[cohortKey];
    else process.env[cohortKey] = cohort;
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    if (previousCohort === undefined) delete process.env[cohortKey];
    else process.env[cohortKey] = previousCohort;
  }
}

test('list filters are allowlisted and limits are bounded', () => {
  assert.deepEqual(parseListQuery({
    kind: 'decision',
    status: 'open',
    priority: 'critical',
    department: 'Executive',
    limit: '1000',
  }), {
    valid: true,
    errors: [],
    value: {
      limit: 100,
      kind: 'decision',
      status: 'open',
      priority: 'critical',
      department: 'Executive',
      includeClosed: false,
    },
  });
  assert.deepEqual(
    parseListQuery({ kind: 'sql', status: 'anything', priority: 'urgent' }).errors,
    ['invalid_kind', 'invalid_status', 'invalid_priority']
  );
});

test('work items are deterministically ordered by priority, due date, then recency', () => {
  const sorted = sortItems([
    { id: 'normal', priority: 'normal', due_at: null, created_at: '2026-07-24T10:00:00Z' },
    { id: 'critical-later', priority: 'critical', due_at: '2026-07-26T10:00:00Z', created_at: '2026-07-24T10:00:00Z' },
    { id: 'critical-sooner', priority: 'critical', due_at: '2026-07-25T10:00:00Z', created_at: '2026-07-24T10:00:00Z' },
  ]);
  assert.deepEqual(sorted.map(item => item.id), [
    'critical-sooner',
    'critical-later',
    'normal',
  ]);
});

test('the entire route is indistinguishable from missing while the flag is off', () => {
  const result = { status: null, body: null, next: false };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  const req = {
    tenantId: TENANT_A,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: TENANT_A, role: 'client_owner' } },
  };
  withFlag(undefined, () => requireControlPlane(req, res, () => { result.next = true; }));
  assert.equal(result.status, 404);
  assert.equal(result.next, false);

  withFlag('true', () => requireControlPlane(req, res, () => { result.next = true; }));
  assert.equal(result.next, true);
});

test('current authoritative client-owner and tenant-owner roles are accepted, stale roles denied', () => {
  for (const role of ['client_owner', 'tenant_owner']) {
    let next = false;
    withFlag('true', () => requireControlPlane({
      tenantId: TENANT_A,
      userId: USER_A,
      user: { id: USER_A, app_metadata: { tenant_id: TENANT_A, role } },
    }, {
      status() { return this; },
      json() { return this; },
    }, () => { next = true; }));
    assert.equal(next, true);
  }

  let status = null;
  withFlag('true', () => requireControlPlane({
    tenantId: TENANT_A,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: TENANT_A, role: 'member' } },
  }, {
    status(code) { status = code; return this; },
    json() { return this; },
  }, () => {}));
  assert.equal(status, 403);
});

test('write surface needs a second flag and a narrower exact-tenant cohort', () => {
  const req = { tenantId: TENANT_A };
  const invoke = () => {
    const result = { status: null, next: false };
    requireControlPlaneWrites(req, {
      status(code) { result.status = code; return this; },
      json() { return this; },
    }, () => { result.next = true; });
    return result;
  };

  withWriteFlag(undefined, TENANT_A, () => {
    assert.deepEqual(invoke(), { status: 404, next: false });
  });
  withWriteFlag('true', '22222222-2222-4222-8222-222222222222', () => {
    assert.deepEqual(invoke(), { status: 404, next: false });
  });
  withWriteFlag('true', TENANT_A, () => {
    assert.deepEqual(invoke(), { status: null, next: true });
  });
});

test('RPC argument builders bind the authenticated tenant and planner fingerprint', () => {
  const actor = currentHumanActor({
    userId: USER_A,
    user: {
      id: 'ignored',
      app_metadata: { role: 'client_owner', tenant_id: TENANT_A },
    },
  });
  assert.deepEqual(actor, {
    type: 'human',
    id: USER_A,
    role: 'client_owner',
    tenantId: TENANT_A,
    authority_tier: 'owner',
  });

  const createPlan = planWorkItemCreate({
    tenant_id: TENANT_A,
    kind: 'decision',
    department: 'executive',
    title: 'Choose an exception response',
    source_type: 'test',
    source_id: 'decision-1',
    idempotency_key: 'test:create:decision-1',
  }, {
    actor,
    flagSnapshot: { controlPlaneApi: true, decisionQueueWrites: true },
    now: '2026-07-24T12:00:00.000Z',
  });
  assert.equal(createPlan.ok, true);
  const createArgs = buildCreateRpcArgs(createPlan);
  assert.equal(createArgs.p_tenant_id, TENANT_A);
  assert.equal(createArgs.p_actor_id, actor.id);
  assert.equal(createArgs.p_request_fingerprint, createPlan.event.request_fingerprint);
  assert.equal(Object.hasOwn(createArgs, 'p_production_action'), false);

  const transitionRequest = {
    to_status: 'claimed',
    expected_revision: 1,
    idempotency_key: 'test:claim:decision-1',
    assignee_type: 'human',
    assignee_id: actor.id,
  };
  const transitionPlan = planWorkItemTransition({
    id: '10000000-0000-4000-8000-000000000001',
    tenant_id: TENANT_A,
    status: 'open',
    authority_tier: 'owner',
    verification_state: 'pending',
    revision: 1,
  }, transitionRequest, {
    actor,
    flagSnapshot: { controlPlaneApi: true, decisionQueueWrites: true },
    now: '2026-07-24T12:01:00.000Z',
  });
  assert.equal(transitionPlan.ok, true);
  const transitionArgs = buildTransitionRpcArgs({
    tenantId: TENANT_A,
    workItemId: '10000000-0000-4000-8000-000000000001',
    plan: transitionPlan,
    request: transitionRequest,
  });
  assert.equal(transitionArgs.p_tenant_id, TENANT_A);
  assert.equal(transitionArgs.p_expected_revision, 1);
  assert.equal(transitionArgs.p_assignee_id, actor.id);
});

test('owner HTTP commands reject unvalidated relationships and assignments', () => {
  assert.deepEqual(ownerCreateInputErrors({
    source_type: 'ops_incident',
    entity_type: 'lead',
    entity_id: 'another-tenant-record',
    assignee_type: 'human',
    assignee_id: USER_A,
  }), [
    'source_type_must_be_manual_owner',
    'server_validated_relationship_required',
    'create_assignment_not_supported',
  ]);
  assert.deepEqual(ownerCreateInputErrors({
    source_type: 'manual_owner',
    assignee_type: 'unassigned',
  }), []);
  assert.deepEqual(ownerTransitionInputErrors({
    to_status: 'claimed',
    assignee_type: 'human',
    assignee_id: USER_A,
  }, { id: USER_A }), []);
  assert.deepEqual(ownerTransitionInputErrors({
    to_status: 'claimed',
    assignee_type: 'human',
    assignee_id: 'ffffffff-2222-4222-8222-222222222222',
  }, { id: USER_A }), ['owner_may_claim_only_for_current_user']);
});

test('RPC results are tenant-bound, complete, and projected to an explicit DTO', () => {
  const itemId = '10000000-0000-4000-8000-000000000001';
  const raw = {
    outcome: 'created',
    work_item: commandItem({
      action_protocol: { internal: true },
      verification_evidence: { internal: true },
      created_by_id: USER_A,
    }),
    event: commandEvent({
      request_fingerprint: 'must-not-be-returned',
      idempotency_key: 'must-not-be-returned',
    }),
  };
  const actor = { type: 'human', id: USER_A, authority_tier: 'owner' };
  const result = validateRpcResult({
    data: raw,
    tenantId: TENANT_A,
    operation: 'create',
    actor,
  });
  assert.equal(result.outcome, 'created');
  assert.equal(result.contract_version, 1);
  assert.equal(result.item.id, itemId);
  assert.equal(Object.hasOwn(result.item, 'action_protocol'), false);
  assert.equal(Object.hasOwn(result.item, 'created_by_id'), false);
  assert.equal(Object.hasOwn(result.event, 'request_fingerprint'), false);
  assert.equal(Object.hasOwn(result.event, 'idempotency_key'), false);

  assert.throws(() => validateRpcResult({
    data: { outcome: 'created', work_item: null, event: null },
    tenantId: TENANT_A,
    operation: 'create',
    actor,
  }), error => error.code === 'FGA_RPC_CONTRACT');
  assert.throws(() => validateRpcResult({
    data: {
      ...raw,
      work_item: { ...raw.work_item, tenant_id: '22222222-2222-4222-8222-222222222222' },
    },
    tenantId: TENANT_A,
    operation: 'create',
    actor,
  }), error => error.code === 'FGA_RPC_CONTRACT');
});

test('replay contract explicitly pairs the committed event with current item state', () => {
  const itemId = '10000000-0000-4000-8000-000000000001';
  const result = validateRpcResult({
    data: {
      outcome: 'replay',
      work_item: commandItem({
        status: 'in_progress',
        revision: 3,
      }),
      event: commandEvent({
        event_type: 'claimed',
        to_status: 'claimed',
      }),
    },
    tenantId: TENANT_A,
    workItemId: itemId,
    operation: 'transition',
    toStatus: 'claimed',
    actor: { type: 'human', id: USER_A, authority_tier: 'owner' },
  });
  assert.equal(result.replay_semantics, 'event_replayed_item_current');
  assert.equal(result.item.status, 'in_progress');
  assert.equal(result.event.to_status, 'claimed');
});

test('database command errors map to stable non-sensitive API codes', () => {
  assert.deepEqual(rpcErrorResponse({ code: '23505' }), {
    status: 409,
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.deepEqual(rpcErrorResponse({ code: '40001' }), {
    status: 409,
    code: 'REVISION_CONFLICT',
  });
  assert.deepEqual(rpcErrorResponse({ code: 'P0002' }), {
    status: 404,
    code: 'NOT_FOUND',
  });
  assert.deepEqual(rpcErrorResponse({ code: '42501' }), {
    status: 403,
    code: 'AUTHORITY_DENIED',
  });
  assert.deepEqual(rpcErrorResponse({ code: 'FGA_RPC_CONTRACT' }), {
    status: 502,
    code: 'INVALID_COMMAND_RESULT',
  });
  assert.deepEqual(rpcErrorResponse(new Error('provider detail')), {
    status: 500,
    code: 'WORK_ITEM_COMMAND_FAILED',
  });
});

test('HTTP read and write surfaces are both hidden by default', async () => {
  const envNames = [
    'FGA_OS_CONTROL_PLANE_API_ENABLED',
    'FGA_OS_CONTROL_PLANE_TENANT_ALLOWLIST',
    'FGA_OS_DECISION_QUEUE_WRITES_ENABLED',
    'FGA_OS_DECISION_QUEUE_WRITE_TENANT_ALLOWLIST',
  ];
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT_A;
    req.userId = 'eeeeeeee-1111-4111-8111-111111111111';
    req.user = {
      id: req.userId,
      app_metadata: { tenant_id: TENANT_A, role: 'client_owner' },
    };
    next();
  });
  app.use('/api/work-items', route);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const { port } = server.address();
    const listResponse = await fetch(`http://127.0.0.1:${port}/api/work-items`);
    const writeResponse = await fetch(`http://127.0.0.1:${port}/api/work-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(listResponse.status, 404);
    assert.equal(writeResponse.status, 404);
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('server mounts the work queue only below authenticated tenant middleware and tripwire', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'api', 'server.js'),
    'utf8'
  );
  const authMount = source.indexOf("app.use('/api', authMiddleware, tenantMiddleware);");
  const tripwire = source.indexOf("app.use('/api', require('./middleware/cross-tenant-tripwire'));");
  const workItems = source.indexOf("app.use('/api/work-items', require('./routes/work-items'));");
  assert.ok(authMount >= 0 && tripwire > authMount && workItems > tripwire);
});
