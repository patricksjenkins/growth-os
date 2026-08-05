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

// integrations/stripe.js constructs its client at module load; the manual-link
// tests stub every call, but the module must be loadable without real keys.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_tests';

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

test('a module-insert failure takes the tenant with it — no orphan blocking retry', async () => {
  // The duplicate check is by EMAIL. A tenant row left behind by a failed
  // staging therefore 409s every retry for that person — an orphan nobody can
  // onboard past without hand-written SQL.
  const tables = {};
  const deletes = [];
  const fake = {
    from(name) {
      if (!tables[name]) tables[name] = [];
      const api = {
        select: () => api, order: () => api, limit: () => api,
        eq() { return api; }, in() { return api; },
        insert(p) {
          if (name === 'tenant_modules') {
            return { then: (res) => Promise.resolve({ error: { message: 'deadlock detected' } }).then(res) };
          }
          const rows = (Array.isArray(p) ? p : [p]).map((r, i) => ({ id: `${name}-${tables[name].length + i}`, ...r }));
          tables[name].push(...rows);
          return { ...api, select: () => ({ single: async () => ({ data: rows[0], error: null }) }) };
        },
        upsert() { return Promise.resolve({ error: null }); },
        update() { return api; },
        delete() {
          return { eq: (col, val) => { deletes.push({ table: name, col, val }); return Promise.resolve({ error: null }); } };
        },
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
        email: 'orphan@test.invalid', owner_name: 'O', business_name: 'Orphan Co',
        tier: 'growth', products: ['lead_capture'],
      },
      headers: {},
    }, r);

    assert.strictEqual(r.statusCode, 500);
    assert.match(r.body.error, /rolled back/i, 'the error must say the retry is clean');
    assert.ok(deletes.some((d) => d.table === 'tenants'),
      'the half-created tenant row must be deleted, or every retry 409s on the email');
  } finally {
    currentDbClient = savedClient;
  }
});

/*
 * MODULES ARE ADDED OVER TIME (Patrick, 2026-08-04). A new client starts with
 * Lead Capture + Website and buys more later — PATCH /clients/:tenantId is
 * the upgrade path, and it gets the same discipline as provisioning.
 */

function clientPatchFake() {
  const tables = { tenant_modules: [], tenant_config: [], tenants: [], attention_queue: [] };
  const fake = {
    _tables: tables,
    from(name) {
      if (!tables[name]) tables[name] = [];
      const filters = [];
      const matching = () => tables[name].filter((r) => filters.every((f) => f(r)));
      const api = {
        select() { return api; }, order: () => api, limit: () => api,
        eq(c, v) { filters.push((r) => r[c] === v); return api; },
        in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
        update(p) {
          const hit = matching(); hit.forEach((r) => Object.assign(r, p));
          return { ...api, select: () => ({ then: (res) => Promise.resolve({ data: hit, error: null }).then(res) }) };
        },
        insert(p) { tables[name].push(...(Array.isArray(p) ? p : [p])); return Promise.resolve({ error: null }); },
        upsert(p) {
          for (const row of (Array.isArray(p) ? p : [p])) {
            const hit = tables[name].find((r) => r.tenant_id === row.tenant_id && r.key === row.key);
            if (hit) Object.assign(hit, row); else tables[name].push(row);
          }
          return Promise.resolve({ error: null });
        },
        maybeSingle: async () => ({ data: matching()[0] || null, error: null }),
        then(res, rej) { return Promise.resolve({ data: matching(), error: null }).then(res, rej); },
      };
      return api;
    },
  };
  return fake;
}

async function patchClient(fake, body) {
  const savedClient = currentDbClient;
  currentDbClient = fake;
  try {
    const h = handlerFor('patch', '/clients/:tenantId');
    const r = res();
    await h({ params: { tenantId: 't-live' }, body, headers: {} }, r);
    return r;
  } finally {
    currentDbClient = savedClient;
  }
}

test('adding a product later enables EVERY key it needs', async () => {
  // "Content Approval & Scheduling" is approval_queue + publishing. Adding
  // one key is how 923A generated content that never published.
  const fake = clientPatchFake();
  const r = await patchClient(fake, { add_products: ['content_approval'] });
  assert.strictEqual(r.statusCode, 200, r.body && r.body.error);
  const enabled = fake._tables.tenant_modules.filter((m) => m.enabled).map((m) => m.module);
  assert.ok(enabled.includes('approval_queue'), 'half a product is not the product');
  assert.ok(enabled.includes('publishing'));
  assert.ok(r.body.newly_enabled_modules.length >= 2);
});

test('an unknown module key is rejected — the 923A ghost-row guard', async () => {
  const fake = clientPatchFake();
  const r = await patchClient(fake, { modules: ['ai_voice_receptionist'] });
  assert.strictEqual(r.statusCode, 500);
  assert.match(r.body.error, /ai_voice_receptionist|unknown|invalid/i);
  assert.strictEqual(fake._tables.tenant_modules.length, 0, 'nothing may be written');
});

test('enabling a module mid-life raises a setup-needed alert', async () => {
  // No wizard is coming for a module added after onboarding. Silent enabled-
  // but-unconfigured is the exact 923A publishing failure.
  const fake = clientPatchFake();
  const r = await patchClient(fake, { add_products: ['content_engine'] });
  assert.strictEqual(r.statusCode, 200);
  const alert = fake._tables.attention_queue.find((a) => a.type === 'module_enabled_needs_setup');
  assert.ok(alert, 'Patrick has to know the new module needs hand setup');
  assert.match(alert.summary, /content_engine/);
});

test('re-sending an already-enabled module raises no duplicate alert', async () => {
  const fake = clientPatchFake();
  fake._tables.tenant_modules.push({ tenant_id: 't-live', module: 'lead_capture', enabled: true });
  const r = await patchClient(fake, { modules: [{ name: 'lead_capture', enabled: true }] });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(fake._tables.attention_queue.length, 0,
    'toggling what is already on is not a new module');
});

/*
 * THE MANUAL PATH (Patrick, 2026-08-05): "I don't trust our setup yet and
 * this is a major step." He creates the subscription in the Stripe dashboard
 * himself and pastes the id; the route verifies it AGAINST STRIPE and brings
 * the checklist up to date. Nothing here may charge anyone.
 */

function linkFake({ steps = [], config = [], takenBy = null } = {}) {
  const tables = {
    tenants: [{ id: 't-live', name: 'Arrivals', owner_email: 'pkelly@arrivals.test' }],
    tenant_config: [
      ...(takenBy ? [{ tenant_id: takenBy, key: 'stripe_subscription_id', value: 'sub_taken' }] : []),
      ...config,
    ],
    onboarding_steps: steps,
  };
  const fake = {
    _tables: tables,
    from(name) {
      if (!tables[name]) tables[name] = [];
      const filters = [];
      let patch = null;
      const matching = () => tables[name].filter((r) => filters.every((f) => f(r)));
      const run = () => {
        const hit = matching();
        if (patch) hit.forEach((r) => Object.assign(r, patch));
        return { data: hit, error: null };
      };
      const api = {
        select() { return api; }, order: () => api, limit: () => api,
        eq(c, v) { filters.push((r) => r[c] === v); return api; },
        in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
        // Real builders are lazy: .update() returns the builder, filters chain
        // after it, and nothing applies until awaited.
        update(p) { patch = p; return api; },
        upsert(p) {
          for (const row of (Array.isArray(p) ? p : [p])) {
            const hit = tables[name].find((r) => r.tenant_id === row.tenant_id && r.key === row.key);
            if (hit) Object.assign(hit, row); else tables[name].push(row);
          }
          return Promise.resolve({ error: null });
        },
        insert(p) { tables[name].push(...(Array.isArray(p) ? p : [p])); return Promise.resolve({ error: null }); },
        maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: null }; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return api;
    },
    config() { return Object.fromEntries(tables.tenant_config.filter((r) => r.tenant_id === 't-live').map((r) => [r.key, r.value])); },
  };
  return fake;
}

function withLinkStubs({ sub, customerEmail = 'pkelly@arrivals.test', feeBilled = true }, fn) {
  const stripeInt = require('../integrations/stripe');
  const reconcile = require('../core/stripe-reconcile');
  const saved = {
    getSubscription: stripeInt.getSubscription,
    getCustomer: stripeInt.getCustomer,
    setupFeeAlreadyBilled: reconcile.setupFeeAlreadyBilled,
  };
  stripeInt.getSubscription = async (id) => {
    if (!sub) throw new Error(`No such subscription: '${id}'`);
    return sub;
  };
  stripeInt.getCustomer = async () => ({ id: 'cus_manual', email: customerEmail });
  reconcile.setupFeeAlreadyBilled = async () => ({ billed: feeBilled, evidence: feeBilled ? {} : null });
  return Promise.resolve(fn()).finally(() => {
    Object.assign(stripeInt, { getSubscription: saved.getSubscription, getCustomer: saved.getCustomer });
    reconcile.setupFeeAlreadyBilled = saved.setupFeeAlreadyBilled;
  });
}

const LIVE_SUB = {
  id: 'sub_manual1', status: 'trialing', customer: 'cus_manual',
  trial_end: Math.floor(new Date('2026-08-19').getTime() / 1000),
  items: { data: [{ price: { unit_amount: 42500 } }] },
};

async function postLink(fake, body) {
  const savedClient = currentDbClient;
  currentDbClient = fake;
  try {
    const h = handlerFor('post', '/clients/:tenantId/link-stripe-subscription');
    const r = res();
    await h({ params: { tenantId: 't-live' }, body, headers: {} }, r);
    return r;
  } finally { currentDbClient = savedClient; }
}

test('a dashboard-built subscription links: verified, recorded, checklist caught up', async () => {
  const fake = linkFake({
    steps: [
      { id: 's1', tenant_id: 't-live', workflow_id: 'wf1', step_name: 'send_payment_link', status: 'pending' },
      { id: 's2', tenant_id: 't-live', workflow_id: 'wf1', step_name: 'go_live', status: 'pending' },
    ],
  });
  await withLinkStubs({ sub: LIVE_SUB }, async () => {
    const r = await postLink(fake, { subscription_id: 'sub_manual1' });
    assert.strictEqual(r.statusCode, 200, r.body && r.body.error);
    assert.strictEqual(r.body.subscription.monthly_usd, 425, 'the CUSTOM rate from Stripe, not a tier price');
    assert.strictEqual(fake.config().stripe_subscription_id, 'sub_manual1');
    assert.strictEqual(fake.config().stripe_customer_id, 'cus_manual');
    assert.strictEqual(fake.config().subscription_source, 'manual_dashboard');
    assert.ok(fake.config().setup_fee_paid_at, 'the paid fee found on Stripe is recorded');
    const money = fake._tables.onboarding_steps.find((s) => s.id === 's1');
    assert.strictEqual(money.status, 'completed', 'the money step is ticked');
    const other = fake._tables.onboarding_steps.find((s) => s.id === 's2');
    assert.strictEqual(other.status, 'pending', 'and ONLY the money step');
  });
});

test('a canceled subscription refuses — a dead sub is not a live client', async () => {
  const fake = linkFake({});
  await withLinkStubs({ sub: { ...LIVE_SUB, status: 'canceled' } }, async () => {
    const r = await postLink(fake, { subscription_id: 'sub_manual1' });
    assert.strictEqual(r.statusCode, 400);
    assert.match(r.body.error, /canceled/);
    assert.strictEqual(fake.config().stripe_subscription_id, undefined, 'nothing recorded');
  });
});

test('an id Stripe does not know refuses with the live-vs-sandbox hint', async () => {
  const fake = linkFake({});
  await withLinkStubs({ sub: null }, async () => {
    const r = await postLink(fake, { subscription_id: 'sub_doesnotexist' });
    assert.strictEqual(r.statusCode, 404);
    assert.match(r.body.error, /LIVE mode/i);
  });
});

test('garbage input never reaches Stripe', async () => {
  const fake = linkFake({});
  let called = false;
  const stripeInt = require('../integrations/stripe');
  const saved = stripeInt.getSubscription;
  stripeInt.getSubscription = async () => { called = true; return LIVE_SUB; };
  try {
    const r = await postLink(fake, { subscription_id: 'in_notasub' });
    assert.strictEqual(r.statusCode, 400);
    assert.strictEqual(called, false);
  } finally { stripeInt.getSubscription = saved; }
});

test('a subscription already linked to ANOTHER client refuses', async () => {
  const fake = linkFake({ takenBy: 't-other' });
  await withLinkStubs({ sub: { ...LIVE_SUB, id: 'sub_taken' } }, async () => {
    const r = await postLink(fake, { subscription_id: 'sub_taken' });
    assert.strictEqual(r.statusCode, 409);
    assert.match(r.body.error, /different client/i);
  });
});

test('an email mismatch links but WARNS — right ID, wrong customer is the likely mistake', async () => {
  const fake = linkFake({
    steps: [{ id: 's1', tenant_id: 't-live', workflow_id: 'wf1', step_name: 'send_payment_link', status: 'pending' }],
  });
  await withLinkStubs({ sub: LIVE_SUB, customerEmail: 'somebody@else.test', feeBilled: false }, async () => {
    const r = await postLink(fake, { subscription_id: 'sub_manual1' });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.body.warnings.some((w) => /does not match/i.test(w)), 'the mismatch must be said out loud');
    assert.ok(r.body.warnings.some((w) => /setup fee/i.test(w)), 'and so must the missing fee');
    assert.strictEqual(fake.config().setup_fee_paid_at, undefined, 'no fee evidence invented');
  });
});
