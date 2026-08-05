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
  assert.ok(!steps.includes('send_payment_link'),
    'and no monthly checkout either — there is no monthly to check out');
});

test('a waived ($0) setup fee still gets the single checkout — subscription only', () => {
  const steps = names(resolveWorkflowSteps(['lead_capture'], {
    billing: { isComplimentary: false, cadence: 'monthly', setupFee: 0 },
  }));
  assert.ok(steps.includes('send_payment_link'), 'the monthly still needs its checkout');
  assert.ok(!steps.includes('send_setup_invoice'));
  assert.ok(!steps.includes('start_subscription'));
});

test('a standard paying client gets ONE payment step — the combined checkout', () => {
  // Patrick, 2026-08-05: "why would the setup fee and subscription not be in
  // the same email?" They are the same email now — one Stripe Checkout with
  // both line items and the trial, exactly like the public Payment Links.
  const steps = names(resolveWorkflowSteps(['lead_capture'], {
    billing: { isComplimentary: false, cadence: 'monthly' },
  }));
  assert.ok(steps.includes('send_payment_link'));
  assert.ok(!steps.includes('send_setup_invoice'),
    'the checkout carries the fee — a separate invoice would double-bill');
  assert.ok(!steps.includes('start_subscription'),
    'the checkout starts the subscription — a separate step would double-subscribe');
});

test('no billing info at all behaves like a standard client', () => {
  const steps = names(resolveWorkflowSteps(['lead_capture']));
  assert.ok(steps.includes('send_payment_link'));
  assert.ok(!steps.includes('send_setup_invoice'));
  assert.ok(!steps.includes('start_subscription'));
});

test('a custom monthly rate falls back to invoice + refusing subscription step', () => {
  // No Stripe price exists for a custom rate, so no checkout can carry it.
  const steps = names(resolveWorkflowSteps(['lead_capture'], {
    billing: { isComplimentary: false, cadence: 'monthly', tier: 'growth', monthlyRate: 175 },
  }));
  assert.ok(!steps.includes('send_payment_link'));
  assert.ok(steps.includes('send_setup_invoice'), 'the fee is still owed, by invoice');
  assert.ok(steps.includes('start_subscription'),
    'and the subscription step exists to REFUSE with dashboard instructions');
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

/*
 * THE SINGLE-CHECKOUT HANDLER — one email carrying one Stripe Checkout with
 * the setup fee, the subscription, and the trial.
 */

function withCheckoutStub({ subscriptionExists = false, setupBilled = false } = {}, fn) {
  const stripeInt = require('../integrations/stripe');
  const reconcile = require('../core/stripe-reconcile');
  const emailMod = require('../integrations/email');
  const saved = {
    createOnboardingCheckout: stripeInt.createOnboardingCheckout,
    getCheckoutSession: stripeInt.getCheckoutSession,
    billingState: reconcile.billingState,
    sendTemplateEmail: emailMod.sendTemplateEmail,
  };
  const calls = { checkouts: [], emails: [] };

  reconcile.billingState = async () => ({
    ok: true,
    setup: { billed: setupBilled, evidence: setupBilled ? { source: 'stripe_checkout' } : null },
    subscription: subscriptionExists
      ? { exists: true, subscription: { subscription_id: 'sub_live', status: 'trialing', first_charge_date: '2026-08-19', monthly_usd: 249 } }
      : { exists: false, subscription: null },
  });
  stripeInt.createOnboardingCheckout = async (args) => {
    calls.checkouts.push(args);
    return { session_id: 'cs_new', url: 'https://checkout.stripe.com/pay/cs_new', setup_usd: args.skipSetupFee ? 0 : (args.customSetupUsd ?? 199), monthly_usd: 249, trial_days: 14 };
  };
  stripeInt.getCheckoutSession = async (id) => ({ id, status: 'open' });
  emailMod.sendTemplateEmail = async (to, template, vars) => {
    calls.emails.push({ to, template, vars });
    return { status: 'sent', id: 'em_1' };
  };

  return Promise.resolve(fn(calls)).finally(() => {
    Object.assign(stripeInt, {
      createOnboardingCheckout: saved.createOnboardingCheckout,
      getCheckoutSession: saved.getCheckoutSession,
    });
    reconcile.billingState = saved.billingState;
    emailMod.sendTemplateEmail = saved.sendTemplateEmail;
  });
}

const paymentStep = { step_name: 'send_payment_link', day: 0, id: 'step-pl-1' };
const runPayment = (db) => onboarding._internals._executeStepHandler(db, 't1', paymentStep);

test('the payment link email carries the checkout URL and both amounts', async () => {
  const db = fakeDb({
    owner_email: 'owner@new.test', owner_name: 'Jane', business_name: 'New Co', tier: 'growth',
  });
  await withCheckoutStub({}, async (calls) => {
    await runPayment(db);
    assert.strictEqual(calls.checkouts.length, 1, 'one checkout session');
    assert.strictEqual(calls.emails.length, 1, 'one email');
    assert.strictEqual(calls.emails[0].to, 'owner@new.test');
    assert.strictEqual(calls.emails[0].template, 'payment-link');
    assert.strictEqual(calls.emails[0].vars.pay_link, 'https://checkout.stripe.com/pay/cs_new');
    assert.match(calls.emails[0].vars.setup_line, /\$199/);
    assert.strictEqual(calls.emails[0].vars.tier_price, '249');
  });
});

test('a customer who is already subscribed gets NOTHING — settled, not resent', async () => {
  const db = fakeDb({ owner_email: 'o@t.test', stripe_customer_id: 'cus_1', tier: 'growth' });
  await withCheckoutStub({ subscriptionExists: true }, async (calls) => {
    await assert.rejects(() => runPayment(db), /already have a subscription/i);
    assert.strictEqual(calls.checkouts.length, 0);
    assert.strictEqual(calls.emails.length, 0);
  });
});

test('a crash after session creation reuses the SAME session on retry', async () => {
  // Two live checkouts can BOTH be paid — the stored session is the guard.
  const db = fakeDb({
    owner_email: 'o@t.test', tier: 'growth',
    checkout_session_id: 'cs_stored', checkout_session_url: 'https://checkout.stripe.com/pay/cs_stored',
  });
  await withCheckoutStub({}, async (calls) => {
    await runPayment(db);
    assert.strictEqual(calls.checkouts.length, 0, 'no rival session may be minted');
    assert.strictEqual(calls.emails[0].vars.pay_link, 'https://checkout.stripe.com/pay/cs_stored');
  });
});

test('a complimentary client is refused by the payment-link handler too', async () => {
  const db = fakeDb({ owner_email: 'o@t.test', is_complimentary: true });
  await withCheckoutStub({}, async (calls) => {
    await assert.rejects(() => runPayment(db), /COMPLIMENTARY/);
    assert.strictEqual(calls.emails.length, 0);
  });
});

test('an already-paid setup fee is dropped from the checkout, not recharged', async () => {
  const db = fakeDb({ owner_email: 'o@t.test', stripe_customer_id: 'cus_1', tier: 'growth' });
  await withCheckoutStub({ setupBilled: true }, async (calls) => {
    await runPayment(db);
    assert.strictEqual(calls.checkouts[0].skipSetupFee, true,
      'they paid the fee already — the checkout must carry only the subscription');
    assert.match(calls.emails[0].vars.setup_line, /already paid/i);
  });
});
