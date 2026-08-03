'use strict';

/**
 * Never bill a customer twice for something Stripe already billed them for.
 *
 * FOUND 2026-08-03, by reading what the live Payment Links actually contain:
 *
 *   buy.stripe.com/...8IU00 → $199 setup ONE-TIME + $249/mo Growth, 14-day trial
 *   buy.stripe.com/...8IU01 → $199 setup ONE-TIME + $399/mo Scale,  14-day trial
 *
 * Those are the links on the public pricing page. Anyone who buys through the
 * website therefore arrives ALREADY invoiced for the setup fee and ALREADY
 * subscribed. But the onboarding checklist still carries `send_setup_invoice`
 * and `start_subscription`, and their guards read tenant_config keys that only
 * our own code ever writes — so for a payment-link customer both guards are
 * empty and both steps look ready to click.
 *
 * Clicking them charges a second $199 and creates a second monthly
 * subscription. The second one bills every month, indefinitely, and nothing in
 * the product would say so.
 *
 * These tests use the real shape of a payment-link purchase.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  setupFeeAlreadyBilled, subscriptionAlreadyExists, billingState,
} = require('../core/stripe-reconcile');

const SETUP = 'prod_setup';
const GROWTH = 'prod_growth';
const SCALE = 'prod_scale';

/**
 * A Stripe stand-in. `opts` describes what this customer already has.
 * Products answer by both retrieve and list so the test is independent of
 * whether STRIPE_PRODUCT_* happens to be set in the environment.
 */
function fakeStripe({ invoices = [], sessions = [], sessionItems = {}, subscriptions = [] } = {}) {
  const products = [
    { id: SETUP, name: 'First Gen Automate — Setup' },
    { id: GROWTH, name: 'First Gen Automate — Growth' },
    { id: SCALE, name: 'First Gen Automate — Scale' },
  ];
  return {
    products: {
      retrieve: async (id) => products.find((p) => p.id === id) || null,
      list: async () => ({ data: products }),
    },
    invoices: { list: async () => ({ data: invoices }) },
    checkout: {
      sessions: {
        list: async () => ({ data: sessions }),
        listLineItems: async (id) => ({ data: sessionItems[id] || [] }),
      },
    },
    subscriptions: { list: async () => ({ data: subscriptions }) },
  };
}

/** What Stripe records after someone buys through a Payment Link. */
function paymentLinkPurchase(tier = GROWTH) {
  return {
    sessions: [{ id: 'cs_1', payment_status: 'paid', created: 1750000000 }],
    sessionItems: {
      cs_1: [
        { price: { product: SETUP, unit_amount: 19900 }, amount_total: 19900 },
        { price: { product: tier, unit_amount: 24900 }, amount_total: 0 },
      ],
    },
    subscriptions: [{
      id: 'sub_live', status: 'trialing', created: 1750000000,
      trial_end: 1751209600,
      items: { data: [{ price: { product: tier, unit_amount: 24900 } }] },
    }],
  };
}

// --- the setup fee ---------------------------------------------------------

test('a payment-link customer is seen as already billed the setup fee', async () => {
  const stripe = fakeStripe(paymentLinkPurchase());
  const r = await setupFeeAlreadyBilled('cus_1', { stripe });
  assert.strictEqual(r.billed, true, 'they paid $199 at checkout — invoicing again charges them twice');
  assert.strictEqual(r.evidence.source, 'stripe_checkout');
  assert.strictEqual(r.evidence.amount_usd, 199);
});

test('an invoice we already sent counts, even unpaid', async () => {
  // An open invoice is still an invoice they have. Sending a second one is
  // exactly the confusion this exists to prevent.
  const stripe = fakeStripe({
    invoices: [{
      id: 'in_1', status: 'open', amount_due: 19900, created: 1750000000,
      lines: { data: [{ price: { product: SETUP } }] },
    }],
  });
  const r = await setupFeeAlreadyBilled('cus_1', { stripe });
  assert.strictEqual(r.billed, true);
  assert.strictEqual(r.evidence.invoice_id, 'in_1');
});

test('an invoice WE sent counts, even with no product on the line', async () => {
  /*
   * FOUND BY THE LIVE DRY RUN, 2026-08-03.
   *
   * sendSetupFeeInvoice attaches a raw `amount`, not a price id, so the
   * invoices we create carry no reference to the Setup product. Matching on
   * the product alone therefore saw Payment Link purchases and missed every
   * invoice we had sent ourselves.
   *
   * The live test passed anyway — the idempotency key replayed the original
   * invoice, so no second one appeared and the count check was satisfied for
   * entirely the wrong reason. Keys expire after 24 hours. A real customer
   * invoiced on Monday and clicked again on Wednesday would have been billed
   * twice.
   *
   * Hence the metadata marker, which also covers custom-priced deals that
   * would never carry the standard product either.
   */
  const stripe = fakeStripe({
    invoices: [{
      id: 'in_ours', status: 'open', amount_due: 19900, created: 1750000000,
      metadata: { fga_purpose: 'setup_fee' },
      lines: { data: [{ description: 'First Gen Automate — Setup' }] }, // no price, no product
    }],
  });
  const r = await setupFeeAlreadyBilled('cus_1', { stripe });
  assert.strictEqual(r.billed, true, 'our own invoice must be recognised');
  assert.strictEqual(r.evidence.invoice_id, 'in_ours');
});

test('a custom-priced setup invoice is recognised too', async () => {
  // 923A is a custom build at a different amount and would never carry the
  // standard product. The marker is what makes it visible.
  const stripe = fakeStripe({
    invoices: [{
      id: 'in_custom', status: 'paid', amount_paid: 50000,
      metadata: { fga_purpose: 'setup_fee' },
      lines: { data: [{ description: '923A - Setup' }] },
    }],
  });
  const r = await setupFeeAlreadyBilled('cus_923a', { stripe });
  assert.strictEqual(r.billed, true);
  assert.strictEqual(r.evidence.amount_usd, 500);
});

test('an unrelated invoice of ours is not read as the setup fee', async () => {
  const stripe = fakeStripe({
    invoices: [{
      id: 'in_other', status: 'paid', amount_paid: 24900,
      metadata: { fga_purpose: 'something_else' },
      lines: { data: [{ description: 'Monthly' }] },
    }],
  });
  const r = await setupFeeAlreadyBilled('cus_1', { stripe });
  assert.strictEqual(r.billed, false, 'the marker has to mean the setup fee specifically');
});

test('a void or draft invoice does NOT count', async () => {
  const stripe = fakeStripe({
    invoices: [{
      id: 'in_void', status: 'void', amount_due: 19900,
      lines: { data: [{ price: { product: SETUP } }] },
    }],
  });
  const r = await setupFeeAlreadyBilled('cus_1', { stripe });
  assert.strictEqual(r.billed, false, 'a voided invoice was withdrawn — they still owe it');
});

test('another product\'s invoice is not mistaken for the setup fee', async () => {
  const stripe = fakeStripe({
    invoices: [{
      id: 'in_mo', status: 'paid', amount_paid: 24900,
      lines: { data: [{ price: { product: GROWTH } }] },
    }],
  });
  const r = await setupFeeAlreadyBilled('cus_1', { stripe });
  assert.strictEqual(r.billed, false, 'a monthly charge is not the setup fee');
});

test('a customer who has bought nothing is billable', async () => {
  const r = await setupFeeAlreadyBilled('cus_new', { stripe: fakeStripe() });
  assert.strictEqual(r.billed, false);
  assert.strictEqual(r.evidence, null);
});

// --- the subscription (the expensive one) ----------------------------------

test('a payment-link customer already has a subscription', async () => {
  const stripe = fakeStripe(paymentLinkPurchase());
  const r = await subscriptionAlreadyExists('cus_1', { stripe });
  assert.strictEqual(r.exists, true, 'starting another bills them twice a MONTH');
  assert.strictEqual(r.subscription.subscription_id, 'sub_live');
  assert.strictEqual(r.subscription.status, 'trialing');
  assert.strictEqual(r.subscription.monthly_usd, 249);
  // Adoptable: the caller records this rather than creating another.
  assert.match(r.subscription.first_charge_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('a scale customer is recognised too', async () => {
  const stripe = fakeStripe(paymentLinkPurchase(SCALE));
  const r = await subscriptionAlreadyExists('cus_1', { stripe });
  assert.strictEqual(r.exists, true);
});

test('a cancelled subscription does not block a new one', async () => {
  const stripe = fakeStripe({
    subscriptions: [{
      id: 'sub_old', status: 'canceled',
      items: { data: [{ price: { product: GROWTH } }] },
    }],
  });
  const r = await subscriptionAlreadyExists('cus_1', { stripe });
  assert.strictEqual(r.exists, false, 'a customer who cancelled and came back needs a new one');
});

test('another tenant\'s custom product is not treated as one of our tiers', async () => {
  const stripe = fakeStripe({
    subscriptions: [{
      id: 'sub_923a', status: 'active',
      items: { data: [{ price: { product: 'prod_923a_monthly', unit_amount: 49900 } }] },
    }],
  });
  const r = await subscriptionAlreadyExists('cus_1', { stripe });
  assert.strictEqual(r.exists, false);
});

// --- fail closed -----------------------------------------------------------

test('when Stripe cannot be read, the answer is "I do not know" — not "no"', async () => {
  // "I could not check" and "they have not paid" are different facts and only
  // one of them is safe to charge on. billingState says so with ok:false, and
  // the money steps refuse on that alone.
  const broken = {
    products: { retrieve: async () => { throw new Error('network down'); },
      list: async () => { throw new Error('network down'); } },
    invoices: { list: async () => ({ data: [] }) },
    checkout: { sessions: { list: async () => ({ data: [] }), listLineItems: async () => ({ data: [] }) } },
    subscriptions: { list: async () => ({ data: [] }) },
  };
  const r = await billingState('cus_1', { stripe: broken });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.setup, null, 'it must not report "not billed" when it could not look');
});

test('a customer with no Stripe record at all is safe to bill', async () => {
  const r = await billingState(null, { stripe: fakeStripe() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.setup.billed, false);
  assert.strictEqual(r.subscription.exists, false);
});

test('billingState answers both questions for a payment-link customer', async () => {
  const r = await billingState('cus_1', { stripe: fakeStripe(paymentLinkPurchase()) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.setup.billed, true);
  assert.strictEqual(r.subscription.exists, true);
});
