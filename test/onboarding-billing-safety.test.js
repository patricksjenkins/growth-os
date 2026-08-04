'use strict';

/**
 * The money steps must match the deal.
 *
 * FOUND BY REVIEW, 2026-08-03. Every workflow received send_setup_invoice and
 * start_subscription regardless of the billing model:
 *
 *   • a COMPLIMENTARY client had two live buttons that would bill a real $199
 *     invoice and a real $249/month subscription to someone who owes nothing;
 *   • an ANNUAL client (AKA pays $276/yr) could be given a MONTHLY
 *     subscription on top of their annual arrangement;
 *   • a CUSTOM client fell through `tier === 'scale' ? scale : growth` and
 *     would be subscribed at the Growth price regardless of their deal;
 *   • the custom setup_fee Patrick typed on the form was stored in config and
 *     never read — the invoice always billed the standard $199.
 *
 * Two layers, both tested: seeding omits steps that do not apply, and the
 * handlers refuse anyway, because a handler that can bill someone must not
 * trust that it was seeded correctly.
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_tests';

const onboarding = require('../core/onboarding');
const { resolveWorkflowSteps } = onboarding;

const names = (steps) => steps.map((s) => s.stepName);

// --- seeding ---------------------------------------------------------------

test('a complimentary client gets NO money steps', () => {
  const steps = names(resolveWorkflowSteps(['lead_capture'], {
    billing: { isComplimentary: true, cadence: 'monthly' },
  }));
  assert.ok(!steps.includes('send_setup_invoice'),
    'a comped client must never see an invoice button');
  assert.ok(!steps.includes('start_subscription'),
    'or a subscription button — clicking it bills $249/mo to someone who owes nothing');
});

test('an annual client gets the invoice but never a monthly subscription', () => {
  const steps = names(resolveWorkflowSteps(['lead_capture'], {
    billing: { isComplimentary: false, cadence: 'annual' },
  }));
  assert.ok(steps.includes('send_setup_invoice'), 'the setup fee is still owed');
  assert.ok(!steps.includes('start_subscription'),
    'a monthly subscription on top of an annual deal is a double-charge');
});

test('a waived ($0) setup fee removes the invoice step', () => {
  const steps = names(resolveWorkflowSteps(['lead_capture'], {
    billing: { isComplimentary: false, cadence: 'monthly', setupFee: 0 },
  }));
  assert.ok(!steps.includes('send_setup_invoice'), 'there is nothing to invoice');
  assert.ok(steps.includes('start_subscription'), 'but the monthly still applies');
});

test('a standard paying client gets both money steps', () => {
  const steps = names(resolveWorkflowSteps(['lead_capture'], {
    billing: { isComplimentary: false, cadence: 'monthly' },
  }));
  assert.ok(steps.includes('send_setup_invoice'));
  assert.ok(steps.includes('start_subscription'));
});

test('no billing info at all behaves like a standard client', () => {
  // The Stripe-checkout path passes no billing block; those customers are
  // standard monthly and the reconcile layer guards the double-charge.
  const steps = names(resolveWorkflowSteps(['lead_capture']));
  assert.ok(steps.includes('send_setup_invoice'));
  assert.ok(steps.includes('start_subscription'));
});

// --- the handlers refuse even if seeding was wrong -------------------------

function fakeDb(configPairs) {
  const tables = {
    tenant_config: Object.entries(configPairs).map(([key, value]) => ({ tenant_id: 't1', key, value })),
    onboarding_workflows: [{ tenant_id: 't1', status: 'active', intake_data: {} }],
  };
  function make(name) {
    const filters = [];
    let patch = null;
    if (!tables[name]) tables[name] = [];
    const matching = () => tables[name].filter((r) => filters.every((f) => f(r)));
    function run() {
      if (patch) { const hit = matching(); hit.forEach((r) => Object.assign(r, patch)); return { data: hit, error: null }; }
      return { data: matching(), error: null };
    }
    const api = {
      select: () => api, order: () => api, limit: () => api,
      eq(c, v) { filters.push((r) => r[c] === v); return api; },
      in(c, v) { filters.push((r) => v.includes(r[c])); return api; },
      update(p) { patch = p; return api; },
      upsert(p) { for (const row of (Array.isArray(p) ? p : [p])) tables[name].push(row); return api; },
      insert(p) { tables[name].push(...(Array.isArray(p) ? p : [p])); return api; },
      single() { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data[0] || null, error: r.error }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return { from: make, _tables: tables };
}

const runHandler = (db, stepName) =>
  onboarding._internals._executeStepHandler(db, 't1', { step_name: stepName, day: 0 });

/** Record everything that would reach Stripe; nothing real is called. */
function withStripeStub(fn) {
  const stripeInt = require('../integrations/stripe');
  const saved = {
    sendSetupFeeInvoice: stripeInt.sendSetupFeeInvoice,
    startTrialSubscription: stripeInt.startTrialSubscription,
    createCustomer: stripeInt.createCustomer,
  };
  const reconcile = require('../core/stripe-reconcile');
  const savedRec = {
    setupFeeAlreadyBilled: reconcile.setupFeeAlreadyBilled,
    subscriptionAlreadyExists: reconcile.subscriptionAlreadyExists,
  };
  reconcile.setupFeeAlreadyBilled = async () => ({ billed: false, evidence: null });
  reconcile.subscriptionAlreadyExists = async () => ({ exists: false, subscription: null });

  const charged = [];
  stripeInt.createCustomer = async () => ({ id: 'cus_1' });
  stripeInt.sendSetupFeeInvoice = async (args) => {
    charged.push({ kind: 'invoice', custom: args.custom });
    return { invoice_id: 'in_1', hosted_url: 'https://x', amount_usd: args.custom?.amount_usd ?? 199, status: 'open' };
  };
  stripeInt.startTrialSubscription = async (args) => {
    charged.push({ kind: 'subscription', tier: args.tier });
    return { subscription_id: 'sub_1', monthly_usd: 249, first_charge_date: '2026-08-17' };
  };

  return Promise.resolve(fn(charged)).finally(() => {
    Object.assign(stripeInt, saved);
    Object.assign(reconcile, savedRec);
  });
}

test('the invoice handler refuses a complimentary client outright', async () => {
  const db = fakeDb({ owner_email: 'x@y.test', is_complimentary: true });
  await withStripeStub(async (charged) => {
    await assert.rejects(() => runHandler(db, 'send_setup_invoice'), /COMPLIMENTARY/);
    assert.deepStrictEqual(charged, [], 'nothing may reach Stripe');
  });
});

test('the invoice handler refuses a $0 setup fee', async () => {
  const db = fakeDb({ owner_email: 'x@y.test', setup_fee: '0' });
  await withStripeStub(async (charged) => {
    await assert.rejects(() => runHandler(db, 'send_setup_invoice'), /\$0/);
    assert.deepStrictEqual(charged, []);
  });
});

test('a custom setup fee is what actually gets invoiced', async () => {
  // The 923A shape: setup_fee stored as 500. The old handler ignored it and
  // billed the standard $199 through resolvePrice.
  const db = fakeDb({
    owner_email: 'x@y.test', business_name: 'Custom Co', setup_fee: '500',
    stripe_customer_id: 'cus_1',
  });
  await withStripeStub(async (charged) => {
    await runHandler(db, 'send_setup_invoice');
    assert.strictEqual(charged.length, 1);
    assert.strictEqual(charged[0].custom?.amount_usd, 500,
      'the deal Patrick typed in must be the amount on the invoice');
  });
});

test('a standard setup fee goes through the catalogue path, not custom', async () => {
  const db = fakeDb({ owner_email: 'x@y.test', setup_fee: '199', stripe_customer_id: 'cus_1' });
  await withStripeStub(async (charged) => {
    await runHandler(db, 'send_setup_invoice');
    assert.strictEqual(charged[0].custom, null,
      'standard pricing must resolve from Stripe, where the amount cross-check lives');
  });
});

test('the subscription handler refuses complimentary and annual clients', async () => {
  for (const cfg of [
    { stripe_customer_id: 'cus_1', is_complimentary: true },
    { stripe_customer_id: 'cus_1', billing_cadence: 'annual' },
  ]) {
    const db = fakeDb(cfg);
    await withStripeStub(async (charged) => {
      await assert.rejects(() => runHandler(db, 'start_subscription'),
        cfg.is_complimentary ? /COMPLIMENTARY/ : /ANNUALLY/);
      assert.deepStrictEqual(charged, [], 'no subscription may be created');
    });
  }
});

test('a custom monthly rate refuses rather than billing the Growth price', async () => {
  const db = fakeDb({ stripe_customer_id: 'cus_1', tier: 'custom', monthly_rate: '175' });
  await withStripeStub(async (charged) => {
    await assert.rejects(() => runHandler(db, 'start_subscription'), /\$175.*\$249|no Stripe price/is);
    assert.deepStrictEqual(charged, [],
      'subscribing a $175 deal at $249 bills the wrong amount every month, forever');
  });
});

test('a standard-rate client still gets their subscription', async () => {
  const db = fakeDb({ stripe_customer_id: 'cus_1', tier: 'growth', monthly_rate: '249' });
  await withStripeStub(async (charged) => {
    await runHandler(db, 'start_subscription');
    assert.deepStrictEqual(charged, [{ kind: 'subscription', tier: 'growth' }]);
  });
});
