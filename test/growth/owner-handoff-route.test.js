'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_tests';

const FGA = '30566ed6-026a-45e1-9502-029e6219df31';
let currentSpec;

function fakeDb(spec) {
  return {
    from(table) {
      const state = { table, op: 'select', filters: {}, payload: null };
      const builder = {
        select() { return builder; },
        insert(payload) { state.op = 'insert'; state.payload = payload; return builder; },
        upsert(payload) { state.op = 'upsert'; state.payload = payload; return builder; },
        update(payload) { state.op = 'update'; state.payload = payload; return builder; },
        eq(key, value) { state.filters[key] = value; return builder; },
        in(key, value) { state.filters[key] = value; return builder; },
        like(key, value) { state.filters[key] = value; return builder; },
        is(key, value) { state.filters[key] = value; return builder; },
        order() { return builder; },
        limit() { return builder; },
        range() { return builder; },
        maybeSingle() { return builder; },
        single() { return builder; },
        then(resolve, reject) {
          spec.calls.push({ ...state, filters: { ...state.filters } });
          const handler = spec[table];
          const receipt = typeof handler === 'function'
            ? handler(state)
            : (handler || { data: [], error: null });
          return Promise.resolve(receipt).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

{
  const path = require.resolve('../../db/client');
  const real = require(path);
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports: { ...real, getServiceClient: () => fakeDb(currentSpec) },
  };
}

function handlerFor(method, routePath) {
  const router = require('../../api/routes/admin');
  const layer = router.stack.find((candidate) => (
    candidate.route
    && candidate.route.path === routePath
    && candidate.route.methods[method]
  ));
  assert.ok(layer, `missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

function response() {
  const value = {
    statusCode: 200,
    body: null,
    status(code) { value.statusCode = code; return value; },
    json(body) { value.body = body; return value; },
  };
  return value;
}

const lead = {
  id: 'lead-1',
  status: 'interested',
  lifecycle_stage: 'interested',
  lead_source: 'prospecting_agent',
  metadata: {},
  next_action_owner: 'owner',
  next_best_action: 'sales_call',
  human_handoff_reason: 'drip_reply',
  handoff_at: '2026-09-11T12:00:00Z',
};

function specWith(events) {
  const spec = {
    calls: [],
    leads: { data: lead, error: null },
    growth_events: (state) => {
      if (state.op === 'upsert') {
        return { data: { id: 'event-accepted', ...state.payload }, error: null };
      }
      return { data: events, error: null };
    },
    attention_queue: { data: [], error: null },
    activity_log: { data: {}, error: null },
  };
  return spec;
}

test('the real acceptance route records one FGA-scoped event and reconciles owner attention', async () => {
  currentSpec = specWith([
    { event_type: 'first_touch_provider_accepted', stage: 'provider_accepted', occurred_at: '2026-09-10T12:00:00Z' },
    { event_type: 'human_reply_received', stage: 'warm', occurred_at: '2026-09-11T11:55:00Z' },
  ]);
  const res = response();
  await handlerFor('post', '/pipeline/:leadId/handoff/accept')({
    params: { leadId: lead.id }, body: {}, user: { id: null, email: 'owner@example.test' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const written = currentSpec.calls.find((call) => call.table === 'growth_events' && call.op === 'upsert');
  assert.ok(written, 'append-only acceptance evidence must be written');
  assert.equal(written.payload.event_type, 'owner_accepted_sales_handoff');
  assert.equal(written.payload.stage, 'owner_accepted');
  assert.equal(written.payload.tenant_id, FGA);
  const attention = currentSpec.calls.find((call) => call.table === 'attention_queue' && call.op === 'update');
  assert.equal(attention.filters.tenant_id, FGA);
  assert.equal(attention.filters.entity_id, lead.id);
  assert.deepEqual(attention.filters.type, [
    'sales_reply_interested', 'sales_reply_question', 'sales_reply_review',
  ]);
  assert.equal(attention.filters.resolved_at, null);
  for (const call of currentSpec.calls.filter((row) => row.table !== 'activity_log')) {
    assert.equal(call.filters.tenant_id ?? call.payload?.tenant_id, FGA, `${call.table} must be FGA scoped`);
  }
});

test('the real acceptance route fails closed when an outbound reply receipt is missing', async () => {
  currentSpec = specWith([
    { event_type: 'first_touch_provider_accepted', stage: 'provider_accepted', occurred_at: '2026-09-10T12:00:00Z' },
  ]);
  const res = response();
  await handlerFor('post', '/pipeline/:leadId/handoff/accept')({
    params: { leadId: lead.id }, body: {}, user: {},
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'canonical_reply_required');
  assert.equal(currentSpec.calls.some((call) => call.op === 'upsert'), false);
  assert.equal(currentSpec.calls.some((call) => call.table === 'attention_queue'), false);
});

test('retrying an existing acceptance heals attention without duplicating the event', async () => {
  currentSpec = specWith([
    { event_type: 'owner_accepted_sales_handoff', stage: 'owner_accepted', occurred_at: '2026-09-11T12:05:00Z' },
  ]);
  const res = response();
  await handlerFor('post', '/pipeline/:leadId/handoff/accept')({
    params: { leadId: lead.id }, body: {}, user: {},
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.already_accepted, true);
  assert.equal(currentSpec.calls.some((call) => call.op === 'upsert'), false);
  assert.equal(currentSpec.calls.some((call) => call.table === 'attention_queue' && call.op === 'update'), true);
});

test('the real pipeline route refuses an outbound demo before acceptance', async () => {
  currentSpec = specWith([
    { event_type: 'first_touch_provider_accepted', stage: 'provider_accepted', occurred_at: '2026-09-10T12:00:00Z' },
  ]);
  const res = response();
  await handlerFor('patch', '/pipeline/:leadId')({
    params: { leadId: lead.id }, body: { status: 'demo_booked' }, user: {},
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'owner_acceptance_required');
  assert.equal(currentSpec.calls.some((call) => call.table === 'leads' && call.op === 'update'), false,
    'the lead must not change before the prerequisite is proven');
});

test('the real pipeline route records only demo evidence after acceptance', async () => {
  currentSpec = specWith([
    { event_type: 'first_touch_provider_accepted', stage: 'provider_accepted', occurred_at: '2026-09-10T12:00:00Z' },
    { event_type: 'owner_accepted_sales_handoff', stage: 'owner_accepted', occurred_at: '2026-09-11T12:05:00Z' },
  ]);
  const res = response();
  await handlerFor('patch', '/pipeline/:leadId')({
    params: { leadId: lead.id }, body: { status: 'demo_booked' }, user: {},
  }, res);

  assert.equal(res.statusCode, 200);
  const outcomeWrites = currentSpec.calls
    .filter((call) => call.table === 'growth_events' && call.op === 'upsert')
    .map((call) => call.payload.event_type);
  assert.deepEqual(outcomeWrites, ['demo_booked']);
});
