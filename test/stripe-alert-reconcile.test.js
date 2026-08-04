'use strict';

/**
 * A lost paid-customer alert must come back on its own.
 *
 * WHY (2026-08-03)
 * ensurePaidAwaitingWelcomeAlert deliberately never throws — an alert failure
 * must not fail the webhook, or Stripe retries and re-books the payment. But
 * a webhook that SUCCEEDS is one Stripe never retries, so a failed alert
 * insert had exactly one chance, at exactly the moment the database was
 * misbehaving. A paid customer could sit waiting for their welcome with
 * nothing anywhere saying so. The no-tenant variant (paid at a Payment Link,
 * no tenant metadata) lost its alert the same way.
 *
 * reconcilePaidCustomerAlerts recomputes both from source of truth on the
 * system-monitor schedule. Alerts are derived data; derived data with a
 * single write moment is data that can be lost.
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_tests';

const { reconcilePaidCustomerAlerts } = require('../integrations/stripe');

function fakeDb(seed = {}) {
  const tables = {
    onboarding_steps: seed.onboarding_steps || [],
    tenant_config: seed.tenant_config || [],
    attention_queue: seed.attention_queue || [],
  };
  function make(name) {
    if (!tables[name]) tables[name] = [];
    const filters = [];
    const matching = () => tables[name].filter((r) => filters.every((f) => f(r)));
    const api = {
      select: () => api, order: () => api,
      limit(n) { const r = matching().slice(0, n); return Promise.resolve({ data: r, error: null }); },
      eq(c, v) {
        // The alert dedupe filters on payload->>tenant_id / session_id.
        if (c.startsWith('payload->>')) {
          const k = c.slice('payload->>'.length);
          filters.push((r) => String(r.payload?.[k]) === String(v));
        } else filters.push((r) => r[c] === v);
        return api;
      },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      is(c, v) { filters.push((r) => r[c] === v || (v === null && r[c] == null)); return api; },
      insert(p) { tables[name].push(...(Array.isArray(p) ? p : [p])); return Promise.resolve({ error: null }); },
      maybeSingle() { const r = matching(); return Promise.resolve({ data: r[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: matching(), error: null }).then(res, rej); },
    };
    return api;
  }
  return { from: make, _tables: tables };
}

const paidTenantSeed = () => ({
  onboarding_steps: [
    { tenant_id: 't-paid', workflow_id: 'wf1', step_name: 'send_welcome_email', status: 'pending' },
  ],
  tenant_config: [
    { tenant_id: 't-paid', key: 'stripe_customer_id', value: 'cus_1' },
    { tenant_id: 't-paid', key: 'owner_email', value: 'paid@customer.test' },
    { tenant_id: 't-paid', key: 'business_name', value: 'Paid Co' },
  ],
});

/** The Stripe client inside integrations/stripe is module-level; give the
 *  session sweep nothing to find unless a test wants it. */
function stubSessions(sessions) {
  const stripeInt = require('../integrations/stripe');
  // reconcile uses the module's own `stripe` client — reach it via a small
  // seam: sessions.list is the only call, and the placeholder key means any
  // real call would throw anyway. Patch through the SDK instance.
  const Stripe = require('stripe');
  // Instead of touching the internal client, monkey-patch the prototype the
  // instance uses for this one method, restoring afterwards.
  const proto = Object.getPrototypeOf(new Stripe('sk_test_x').checkout.sessions);
  const saved = proto.list;
  proto.list = async () => ({ data: sessions });
  return () => { proto.list = saved; };
}

test('a paid tenant with a pending welcome and NO alert gets the alert re-raised', async () => {
  const db = fakeDb(paidTenantSeed());
  const restore = stubSessions([]);
  try {
    const out = await reconcilePaidCustomerAlerts(db);
    assert.strictEqual(out.raised_tenant_alerts, 1, 'the lost alert must come back');
    const alert = db._tables.attention_queue.find((a) => a.type === 'stripe_paid_awaiting_welcome');
    assert.ok(alert, 'and exist in the queue');
    assert.strictEqual(alert.payload.tenant_id, 't-paid');
  } finally { restore(); }
});

test('an alert that already exists is not duplicated', async () => {
  const seed = paidTenantSeed();
  seed.attention_queue = [{
    type: 'stripe_paid_awaiting_welcome', resolved_at: null,
    payload: { tenant_id: 't-paid' },
  }];
  const db = fakeDb(seed);
  const restore = stubSessions([]);
  try {
    const out = await reconcilePaidCustomerAlerts(db);
    assert.strictEqual(out.raised_tenant_alerts, 0, 'one alert per fact, not one per sweep');
  } finally { restore(); }
});

test('an unpaid (staged, no Stripe identity) tenant raises nothing', async () => {
  const db = fakeDb({
    onboarding_steps: [{ tenant_id: 't-staged', step_name: 'send_welcome_email', status: 'pending' }],
    tenant_config: [{ tenant_id: 't-staged', key: 'owner_email', value: 's@t.test' }],
  });
  const restore = stubSessions([]);
  try {
    const out = await reconcilePaidCustomerAlerts(db);
    assert.strictEqual(out.raised_tenant_alerts, 0,
      'a friends-and-family tenant waiting for its welcome is normal, not an emergency');
  } finally { restore(); }
});

test('a paid session with no tenant gets its lost alert re-raised', async () => {
  const db = fakeDb({});
  const restore = stubSessions([{
    id: 'cs_lost', payment_status: 'paid', metadata: {},
    customer: 'cus_9', customer_email: 'orphan@pay.test',
    customer_details: { name: 'Orphan Payer' }, amount_total: 44800,
  }]);
  try {
    const out = await reconcilePaidCustomerAlerts(db);
    assert.strictEqual(out.raised_no_tenant_alerts, 1);
    const alert = db._tables.attention_queue.find((a) => a.type === 'stripe_payment_without_tenant');
    assert.ok(alert);
    assert.strictEqual(alert.payload.session_id, 'cs_lost');
  } finally { restore(); }
});

test('a RESOLVED no-tenant alert is not re-raised — Patrick already handled it', async () => {
  const db = fakeDb({
    attention_queue: [{
      type: 'stripe_payment_without_tenant', resolved_at: '2026-08-01T00:00:00Z',
      payload: { session_id: 'cs_done' },
    }],
  });
  const restore = stubSessions([{
    id: 'cs_done', payment_status: 'paid', metadata: {}, customer: 'cus_9',
  }]);
  try {
    const out = await reconcilePaidCustomerAlerts(db);
    assert.strictEqual(out.raised_no_tenant_alerts, 0,
      're-raising finished work trains Patrick to ignore red alerts');
  } finally { restore(); }
});

test('the reconciler never throws — a broken sweep reports, the other sweep still runs', async () => {
  const db = {
    from() { throw new Error('database exploded'); },
  };
  const restore = stubSessions([]);
  try {
    const out = await reconcilePaidCustomerAlerts(db);
    assert.ok(out.errors.length > 0, 'the failure must be reported, not swallowed');
  } finally { restore(); }
});
