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

// --- no ambient credentials ------------------------------------------------
//
// The route handlers open with getServiceClient(), which THROWS when
// SUPABASE_URL / SUPABASE_SERVICE_KEY are absent. With the engine stubbed that
// client is never used, so on this machine — where .env exists — the throw
// never happened and the tests passed. In CI there is no .env, every handler
// 500'd before reaching the code under test, and three of these went red.
//
// A unit test asserting what a route does must not depend on whether the
// developer running it happens to have production credentials sitting in the
// working directory. Stub the client rather than require the secret.
// The router destructures getServiceClient AT LOAD TIME, so the stub must be
// in place before the first require of the router — and it must DELEGATE,
// because a later require.cache swap can never reach the already-bound
// function. (The first version of the provisioning test learned this the hard
// way: it swapped the cache, the route kept the old throwing client, 500'd
// before the code under test, and the test passed vacuously — surviving the
// exact mutation it existed to catch.)
let currentDbClient = {
  from() { throw new Error('these tests must not touch the database'); },
};
{
  const p = require.resolve('../db/client');
  const real = require.cache[p] ? require.cache[p].exports : null;
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: {
      ...(real || {}),
      // Deliberately not a working client by default: nothing here should
      // touch the database, and a test that starts to will fail loudly rather
      // than quietly reaching for real credentials. Tests that need a fake
      // assign to currentDbClient for their duration.
      getServiceClient: () => currentDbClient,
    },
  };
}

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

/*
 * PROVISIONING SENDS NOTHING — the P0 that survived two review rounds.
 *
 * POST /onboard-tenant had a send_welcome flag defaulting true and called
 * sendWelcomeWizard directly: email plus potentially SMS, before the Center's
 * welcome step was ever previewed or clicked. "Only the Center's run route
 * sends" was false at the very first screen of the flow.
 *
 * Exercised by calling the real route with every send path instrumented.
 */
test('POST /onboard-tenant sends NOTHING — not even with send_welcome:true', async () => {
  const emailMod = require('../integrations/email');
  const wizardPath = require.resolve('../core/welcome-wizard');
  const savedWizard = require.cache[wizardPath];

  let wizardCalls = 0;
  let emailSends = 0;
  require.cache[wizardPath] = {
    id: wizardPath, filename: wizardPath, loaded: true,
    exports: {
      sendWelcomeWizard: async () => { wizardCalls += 1; return { delivered: true }; },
      sendWelcomeFromCenter: async () => { wizardCalls += 1; return { delivered: true }; },
      WELCOME_LINK_SENTINEL: 'x',
    },
  };
  const savedSends = {};
  for (const k of Object.keys(emailMod)) {
    if (typeof emailMod[k] === 'function' && /^send/i.test(k)) {
      savedSends[k] = emailMod[k];
      emailMod[k] = async () => { emailSends += 1; return { status: 'counted' }; };
    }
  }

  // The route needs a db; a minimal fake that accepts every write. Installed
  // via the delegating stub above — a cache swap would never reach the
  // already-destructured getServiceClient inside the router.
  const tables = {};
  const fake = {
    from(name) {
      if (!tables[name]) tables[name] = [];
      const api = {
        select: () => api, order: () => api, limit: () => api,
        eq() { return api; }, in() { return api; },
        insert(p) {
          const rows = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `${name}-${tables[name].length + i}`, ...r }));
          tables[name].push(...rows);
          return {
            ...api,
            select: () => ({ single: async () => ({ data: rows[0], error: null }) }),
          };
        },
        upsert() { return Promise.resolve({ error: null }); },
        update() { return api; },
        single: async () => ({ data: tables[name][0] || null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); },
      };
      return api;
    },
  };
  const savedClient = currentDbClient;
  currentDbClient = fake;

  try {
    const handler = handlerFor('post', '/onboard-tenant');
    const r = res();
    await handler({
      user: { email: 'patrick@test' },
      body: {
        email: 'newclient@test.invalid', owner_name: 'New Client',
        business_name: 'Client Co', tier: 'growth',
        products: ['lead_capture'],
        send_welcome: true,   // the old default — must now be ignored
      },
      headers: {},
    }, r);

    // The route must SUCCEED for the no-send assertions to mean anything —
    // a 500 before the old send site would pass them vacuously, which is
    // exactly how the first version of this test survived its own mutation.
    assert.strictEqual(r.statusCode, 200, r.body && r.body.error);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.staged_only, true, 'the response must say it staged only');
    assert.ok(!('welcome_sent' in r.body), 'welcome_sent is retired — nothing was sent to report on');

    assert.strictEqual(wizardCalls, 0,
      'provisioning called the welcome sender — the send-on-create path is back');
    assert.strictEqual(emailSends, 0, 'no email of any kind may leave provisioning');
  } finally {
    if (savedWizard) require.cache[wizardPath] = savedWizard; else delete require.cache[wizardPath];
    currentDbClient = savedClient;
    Object.assign(emailMod, savedSends);
  }
});
