'use strict';

/**
 * The admin controls for the 7-day workflow, exercised by calling the real
 * route handlers.
 *
 * WHY (2026-08-02)
 * The workflow contains steps only a human can clear — `founder_video_call`
 * (day 5) and `client_photo_upload` (day 6) — plus anything parked at
 * 'waiting' on a founder task. Until these routes existed there was no way to
 * mark any of them done, so a real onboarding would have run cleanly for four
 * days and then deadlocked on day 5 with no way forward short of hand-written
 * SQL. That is not a hypothetical: every step before day 5 is automated, so
 * the failure would have surfaced only once a paying client was already
 * halfway through.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// --- find a route handler on the mounted admin router ----------------------

function handlerFor(method, routePath) {
  const router = require('../api/routes/admin');
  const layer = router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method],
  );
  assert.ok(layer, `no ${method.toUpperCase()} ${routePath} route is registered`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1];
}

function res() {
  const r = {
    statusCode: 200, body: null,
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
}

/** Swap core/onboarding for a stub, run fn, restore. */
async function withStubbedEngine(stub, fn) {
  const p = require.resolve('../core/onboarding');
  const real = require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: stub };
  // The admin router lazily requires core/onboarding inside each handler, so
  // the stub is picked up without reloading the router.
  try { return await fn(); } finally {
    if (real) require.cache[p] = real; else delete require.cache[p];
  }
}

// --- tests -----------------------------------------------------------------

test('a founder step can be marked done', async () => {
  let called = null;
  await withStubbedEngine({
    completeStep: async (db, tenantId, stepId) => {
      called = { tenantId, stepId };
      return { step_name: 'founder_video_call', status: 'completed' };
    },
  }, async () => {
    const h = handlerFor('post', '/onboarding/step/:stepId/complete');
    const r = res();
    await h({ params: { stepId: 'step-9' }, body: { tenant_id: 't-1' } }, r);

    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.step, 'founder_video_call');
    assert.deepStrictEqual(called, { tenantId: 't-1', stepId: 'step-9' },
      'the handler must pass through the real ids, not invent them');
  });
});

test('completing a step without a tenant is rejected', async () => {
  const h = handlerFor('post', '/onboarding/step/:stepId/complete');
  const r = res();
  await h({ params: { stepId: 'step-9' }, body: {} }, r);
  // Without tenant_id, completeStep's .eq('tenant_id', ...) guard would be
  // skipped — one tenant could clear another's step.
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.body.error, /tenant_id/);
});

test('a skip must state why', async () => {
  const h = handlerFor('post', '/onboarding/step/:stepId/skip');
  const r = res();
  await h({ params: { stepId: 's' }, body: { tenant_id: 't-1' } }, r);
  // A skip with no reason is indistinguishable later from a step that was
  // silently dropped — the exact failure this engine exists to prevent.
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.body.error, /reason/);
});

test('a skip with a reason goes through and records it', async () => {
  let reason = null;
  await withStubbedEngine({
    skipStep: async (db, t, s, why) => { reason = why; return { step_name: 'configure_buffer', status: 'skipped' }; },
  }, async () => {
    const h = handlerFor('post', '/onboarding/step/:stepId/skip');
    const r = res();
    await h({ params: { stepId: 's' }, body: { tenant_id: 't-1', reason: 'client has no socials' } }, r);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.status, 'skipped');
    assert.strictEqual(reason, 'client has no socials');
  });
});

test('the workflow view names what is blocking and who owes it', async () => {
  await withStubbedEngine({
    getOnboardingStatus: async () => ({
      workflowId: 'wf-1', currentDay: 5, totalSteps: 17,
      completedCount: 14, pendingCount: 1, waitingCount: 1, failedCount: 1, blockedCount: 0,
      blocking: [
        { id: 's1', step_name: 'founder_video_call', description: 'Founder call',
          day: 5, status: 'pending', kind: 'founder', last_error: null },
        { id: 's2', step_name: 'configure_buffer', description: 'Buffer',
          day: 1, status: 'waiting', kind: 'automated', last_error: 'waiting on Patrick: connect socials' },
      ],
    }),
  }, async () => {
    const h = handlerFor('get', '/onboarding/workflow/:tenantId');
    const r = res();
    await h({ params: { tenantId: 't-1' } }, r);

    assert.strictEqual(r.body.workflow.currentDay, 5);
    assert.strictEqual(r.body.workflow.progress, '14/17');
    const founder = r.body.workflow.blocking.find((b) => b.step === 'founder_video_call');
    assert.strictEqual(founder.owedBy, 'founder', 'it must say who has to act');
    assert.ok(founder.id, 'and give the step id, or you cannot clear it');
    const buffer = r.body.workflow.blocking.find((b) => b.step === 'configure_buffer');
    assert.match(buffer.reason, /connect socials/, 'and say what they have to do');
  });
});

test('a tenant with no workflow reports that plainly, not as an error', async () => {
  await withStubbedEngine({ getOnboardingStatus: async () => null }, async () => {
    const h = handlerFor('get', '/onboarding/workflow/:tenantId');
    const r = res();
    await h({ params: { tenantId: 't-1' } }, r);
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.workflow, null);
    assert.match(r.body.message, /No active onboarding/);
  });
});

test('the timeline can be advanced on demand instead of waiting for 3am', async () => {
  await withStubbedEngine({
    advanceOnboarding: async () => ({ advanced: true, currentDay: 6 }),
  }, async () => {
    const h = handlerFor('post', '/onboarding/advance/:tenantId');
    const r = res();
    await h({ params: { tenantId: 't-1' } }, r);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.currentDay, 6);
  });
});

test('a blocked advance reports what is holding it, not a bare failure', async () => {
  await withStubbedEngine({
    advanceOnboarding: async () => ({
      advanced: false,
      message: 'Cannot advance — 1 step(s) unresolved for day 5',
      blockedBy: [{ step: 'founder_video_call', status: 'pending', kind: 'founder', error: null }],
    }),
  }, async () => {
    const h = handlerFor('post', '/onboarding/advance/:tenantId');
    const r = res();
    await h({ params: { tenantId: 't-1' } }, r);
    assert.strictEqual(r.statusCode, 200, 'a blocked timeline is information, not a server error');
    assert.strictEqual(r.body.advanced, false);
    assert.strictEqual(r.body.blockedBy[0].step, 'founder_video_call');
  });
});
