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

/*
 * The workflow view returns EVERY step — it is a checklist Patrick works
 * through, not a queue handing him one thing. Its full shape (day grouping,
 * per-step warnings, who owes each one, what the customer has still not
 * filled in) needs a real database: the router captures getServiceClient at
 * module load, so a require-cache swap never reaches it. That shape is
 * asserted end to end in scripts/onboarding-dry-run.js against the live
 * database instead of being faked here.
 */
test('the workflow view is a GET and takes a tenant', () => {
  assert.ok(handlerFor('get', '/onboarding/workflow/:tenantId'));
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

/*
 * There is no "advance" route any more (2026-08-02). Onboarding does not
 * progress on a timeline — Patrick works the steps one at a time from the
 * Onboarding Center, and each one is a preview then a run.
 */
test('there is no route that advances a timeline', () => {
  const router = require('../api/routes/admin');
  const advance = router.stack.find(
    (l) => l.route && /onboarding\/advance/.test(l.route.path),
  );
  assert.strictEqual(advance, undefined,
    'nothing should be able to move an onboarding on its own');
});

test('previewing a step is a GET and running it is a POST', () => {
  // The separation IS the safety property: a GET can be issued by a link
  // preview, a browser prefetch, or a curious click. Only the POST sends.
  assert.ok(handlerFor('get', '/onboarding/step/:stepId/preview'));
  assert.ok(handlerFor('post', '/onboarding/step/:stepId/run'));
  const router = require('../api/routes/admin');
  const previewAsPost = router.stack.find(
    (l) => l.route && l.route.path === '/onboarding/step/:stepId/preview' && l.route.methods.post,
  );
  assert.strictEqual(previewAsPost, undefined, 'preview must never be a POST route');
});

/*
 * The run route's own outcome handling (completed / waiting / failed, and the
 * fact that a non-fatal outcome is a 200 rather than a 500) is covered in
 * test/onboarding-center.test.js against the real runStep. It cannot be
 * covered here: the router captures getServiceClient at module load, so a
 * require-cache swap after the fact never reaches it.
 */
