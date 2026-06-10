/**
 * AI Safety — graceful-degradation tests.
 * Proves that if the safety tables DON'T EXIST (migration 046 not applied) or
 * the DB errors, the safety layer degrades to a silent no-op and NEVER throws
 * into or blocks a provider call. This is the "deploy code before migration is
 * still safe" guarantee.
 */

'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const dbc = require('../../db/client');

// A client that mimics PostgREST when a table is missing: every terminal op
// resolves with an { error } (never rejects), exactly like supabase-js.
function brokenClient() {
  const err = { message: 'relation "ai_usage_events" does not exist', code: '42P01' };
  const builder = {
    insert() { return this; },
    update() { return this; },
    select() { return this; },
    eq() { return this; }, gte() { return this; }, lte() { return this; },
    in() { return this; }, or() { return this; }, order() { return this; }, limit() { return this; },
    single() { return Promise.resolve({ data: null, error: err }); },
    maybeSingle() { return Promise.resolve({ data: null, error: err }); },
    then(onF, onR) { return Promise.resolve({ data: null, count: null, error: err }).then(onF, onR); },
  };
  return { from: () => builder };
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('AI_')) delete process.env[k];
  dbc.getServiceClient = () => brokenClient();
});

const tracker = require('../../core/ai-safety/usage-tracker');
const switches = require('../../core/ai-safety/switches');
const guard = require('../../core/ai-safety/guard');
const idem = require('../../core/ai-safety/idempotency');
const { guardedEnqueue } = require('../../core/ai-safety/guarded-enqueue');

test('recordUsage never throws when tables are missing', async () => {
  const r = await tracker.recordUsage({ tenantId: 'T', agentName: 'outreach', model: 'claude-sonnet-4-6' });
  assert.equal(r.recorded, false); // could not write, but no throw
});

test('switches.evaluate degrades to no open switches on DB error', async () => {
  const d = await switches.evaluate({ provider: 'anthropic', agentName: 'outreach', isAutomated: true });
  assert.equal(d.blocked, false);
});

test('guard.beforeCall ALLOWS the call when the DB is broken (fail-open)', async () => {
  const decision = await guard.beforeCall({ provider: 'anthropic', agentName: 'outreach', isAutomated: true });
  assert.equal(decision.allow, true); // a provider call is never blocked by a guard error
});

test('guard.afterCall never throws on DB error', async () => {
  await assert.doesNotReject(() => guard.afterCall({ tenantId: 'T', agentName: 'outreach' }, { outcome: 'success' }));
});

test('evaluateThresholds never throws on DB error', async () => {
  process.env.AI_MONITOR_MODE_ENABLED = 'true';
  const breached = await guard.evaluateThresholds({ tenantId: 'T', agentName: 'outreach' });
  assert.ok(Array.isArray(breached)); // empty, no throw
});

test('detectOutreachDuplicate degrades to not-duplicate on DB error', async () => {
  const r = await idem.detectOutreachDuplicate({ tenantId: 'T', leadId: 'L' });
  assert.equal(r.duplicate, false);
});

test('guardedEnqueue reports failure (not throw) when agent_jobs insert errors', async () => {
  const res = await guardedEnqueue({ tenantId: 'T', agentName: 'outreach', items: [{ lead_id: 'a' }] });
  // ok:false is acceptable here — the point is it returns a value, never throws.
  assert.equal(typeof res.ok, 'boolean');
});
