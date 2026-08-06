'use strict';

/**
 * The webhook speaks a newer Stripe than the code that reads it.
 *
 * FOUND 2026-08-05, from a Stripe email saying test-mode deliveries were
 * failing. The failing sandbox endpoint turned out to be noise; the real
 * finding was underneath it.
 *
 * Our live endpoint we_1TxViXJIrkogakNB1j1g5YJN is registered at API version
 * `2026-03-25.dahlia`. Webhook payloads arrive in the ENDPOINT's version — the
 * `apiVersion: '2024-06-20'` pin in integrations/stripe.js governs our own
 * outbound calls and has no effect on inbound events. Four fields the handlers
 * read had moved, and nothing threw: they simply read `undefined` and booked
 * nulls.
 *
 * The fixtures below are the REAL shapes, read off live objects
 * (in_1Tvm3HJIrkogakNBo2jutaxc and sub_1U0tO3JIrkogakNBDUcgtp7l) at both
 * versions on 2026-08-05, not shapes reconstructed from documentation. That
 * distinction is the whole point: the previous round of this work passed
 * against mocks that encoded the assumption being tested.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { fakeSupabase } = require('./helpers/fake-supabase');
const {
  invoiceSubscriptionId, invoiceSubscriptionMetadata, invoicePaymentRef,
  subscriptionPeriodEnd, toDateOnly,
} = require('../integrations/stripe-fields');

const CLIENT_TENANT = '00000000-0000-0000-0000-0000000000aa';

// ---------------------------------------------------------------------------
// Fixtures: the same live invoice, as each API version renders it.
// ---------------------------------------------------------------------------

/** in_1Tvm3H… read at 2026-03-25.dahlia — what the webhook actually delivers. */
const DAHLIA_INVOICE = Object.freeze({
  id: 'in_1Tvm3HJIrkogakNBo2jutaxc',
  customer: 'cus_UvdE5Hk2hsXFpH',
  amount_paid: 27600,
  // subscription / subscription_details / charge are ABSENT, not null.
  parent: {
    type: 'subscription_details',
    quote_details: null,
    subscription_details: {
      subscription: 'sub_1Tvm3HJIrkogakNBnLnn7FOs',
      metadata: { tier: 'growth' },
    },
  },
  lines: { data: [{ metadata: {}, description: 'Growth plan' }] },
});

/** The same invoice read at the pinned 2024-06-20 — what our own calls get. */
const LEGACY_INVOICE = Object.freeze({
  id: 'in_1Tvm3HJIrkogakNBo2jutaxc',
  customer: 'cus_UvdE5Hk2hsXFpH',
  amount_paid: 27600,
  subscription: 'sub_1Tvm3HJIrkogakNBnLnn7FOs',
  subscription_details: { metadata: { tier: 'growth' } },
  charge: 'ch_3Tvm60JIrkogakNB1ODQ65UQ',
  lines: { data: [{ metadata: {}, description: 'Growth plan' }] },
});

/** sub_1U0tO3… (Arrivals, trialing) at dahlia — period is on the ITEM. */
const DAHLIA_SUBSCRIPTION = Object.freeze({
  id: 'sub_1U0tO3JIrkogakNBDUcgtp7l',
  status: 'trialing',
  trial_end: 1787101971,
  items: { data: [{ current_period_end: 1787101971, current_period_start: 1784509971 }] },
});

/** An ACTIVE subscription at dahlia — no trial_end to fall back on. */
const DAHLIA_ACTIVE_SUBSCRIPTION = Object.freeze({
  id: 'sub_1Tvm3HJIrkogakNBnLnn7FOs',
  status: 'active',
  trial_end: null,
  items: { data: [{ current_period_end: 1787101971, current_period_start: 1784509971 }] },
});

const LEGACY_SUBSCRIPTION = Object.freeze({
  id: 'sub_1Tvm3HJIrkogakNBnLnn7FOs',
  status: 'active',
  trial_end: null,
  current_period_end: 1787101971,
});

// ---------------------------------------------------------------------------
// The fields themselves.
// ---------------------------------------------------------------------------

test('the subscription id survives the version the webhook actually uses', () => {
  assert.strictEqual(invoiceSubscriptionId(DAHLIA_INVOICE), 'sub_1Tvm3HJIrkogakNBnLnn7FOs');
  // The regression this replaces, stated as the assertion it failed:
  assert.strictEqual(DAHLIA_INVOICE.subscription, undefined,
    'fixture must reflect that the old path is genuinely absent, not null');
});

test('the same reader still works on the old shape our own calls return', () => {
  assert.strictEqual(invoiceSubscriptionId(LEGACY_INVOICE), 'sub_1Tvm3HJIrkogakNBnLnn7FOs');
});

test('an expanded subscription object yields its id, not the object', () => {
  const expanded = { parent: { subscription_details: { subscription: { id: 'sub_X', object: 'subscription' } } } };
  assert.strictEqual(invoiceSubscriptionId(expanded), 'sub_X');
});

test('a one-off invoice has no subscription and says so', () => {
  assert.strictEqual(invoiceSubscriptionId({ id: 'in_setup', customer: 'cus_1' }), null);
});

test('the tier still reaches the ledger description', () => {
  assert.strictEqual(invoiceSubscriptionMetadata(DAHLIA_INVOICE)?.tier, 'growth');
  assert.strictEqual(invoiceSubscriptionMetadata(LEGACY_INVOICE)?.tier, 'growth');
});

test('the renewal date is read off the item, where Stripe moved it', () => {
  assert.strictEqual(subscriptionPeriodEnd(DAHLIA_ACTIVE_SUBSCRIPTION), 1787101971);
  assert.strictEqual(subscriptionPeriodEnd(LEGACY_SUBSCRIPTION), 1787101971);
  assert.strictEqual(DAHLIA_ACTIVE_SUBSCRIPTION.current_period_end, undefined);
});

test('a multi-item subscription reports the LATEST item period, never an early one', () => {
  const multi = { items: { data: [
    { current_period_end: 1787101971 },
    { current_period_end: 1789780371 },
  ] } };
  assert.strictEqual(subscriptionPeriodEnd(multi), 1789780371,
    'reporting the first item would understate the renewal date');
});

test('a missing charge is reported as missing, not invented', () => {
  // At dahlia the charge id is genuinely unavailable on an unexpanded
  // invoice — `payments` is a list webhooks do not expand. Null is correct.
  assert.strictEqual(invoicePaymentRef(DAHLIA_INVOICE), null);
  assert.deepStrictEqual(invoicePaymentRef(LEGACY_INVOICE),
    { id: 'ch_3Tvm60JIrkogakNB1ODQ65UQ', type: 'charge' });
});

test('an expanded dahlia invoice surfaces the payment intent behind the money', () => {
  const expanded = { ...DAHLIA_INVOICE, payments: { data: [
    { payment: { payment_intent: 'pi_3Tvm60JIrkogakNB1ODQ65UQ', type: 'payment_intent' } },
  ] } };
  assert.deepStrictEqual(invoicePaymentRef(expanded),
    { id: 'pi_3Tvm60JIrkogakNB1ODQ65UQ', type: 'payment_intent' });
});

// ---------------------------------------------------------------------------
// The callers. These are the assertions that would have caught the live bug —
// the helper being right is worth nothing if the call sites still read the
// dead field.
// ---------------------------------------------------------------------------

test('finance-sync books a dahlia invoice WITH its subscription id and tier', async () => {
  const db = ledgerDb();
  const { recordStripeInvoicePaid } = require('../integrations/finance-sync');

  const out = await recordStripeInvoicePaid(db, {
    ...DAHLIA_INVOICE,
    currency: 'usd',
    status_transitions: { paid_at: Math.floor(Date.UTC(2026, 6, 21) / 1000) },
  });
  assert.strictEqual(out.status, 'created', `handler did not book: ${JSON.stringify(out)}`);

  const income = db.writes('finance_entries').map((w) => w.payload)
    .find((r) => r.entry_type === 'income');
  assert.ok(income, 'no income row was written');
  assert.strictEqual(income.metadata.stripe_subscription_id, 'sub_1Tvm3HJIrkogakNBnLnn7FOs',
    'the booked entry lost its subscription link — this is the live defect');
  assert.strictEqual(income.metadata.tier, 'growth',
    'the tier came from subscription metadata and must survive the move');
  assert.strictEqual(income.amount, 276);
  assert.match(income.description, /growth/,
    'the tier reaches the human-readable description too');
});

test('the legacy shape books identically — the fix is additive, not a swap', async () => {
  const db = ledgerDb();
  const { recordStripeInvoicePaid } = require('../integrations/finance-sync');
  const out = await recordStripeInvoicePaid(db, {
    ...LEGACY_INVOICE,
    charge: null, // keep the fee path out of this assertion
    currency: 'usd',
    status_transitions: { paid_at: Math.floor(Date.UTC(2026, 6, 21) / 1000) },
  });
  assert.strictEqual(out.status, 'created');
  const income = db.writes('finance_entries').map((w) => w.payload)
    .find((r) => r.entry_type === 'income');
  assert.strictEqual(income.metadata.stripe_subscription_id, 'sub_1Tvm3HJIrkogakNBnLnn7FOs');
  assert.strictEqual(income.metadata.tier, 'growth');
});

test('the reconciler dates a non-trialing subscription instead of giving up', () => {
  // reconcileCustomerState talks to Stripe, so exercise the shaping directly
  // through the same readers the module now uses.
  const first = toDateOnly(DAHLIA_ACTIVE_SUBSCRIPTION.trial_end)
    || toDateOnly(subscriptionPeriodEnd(DAHLIA_ACTIVE_SUBSCRIPTION))
    || 'unknown';
  assert.strictEqual(first, '2026-08-19');
  assert.notStrictEqual(first, 'unknown',
    "every active subscription reconciled as 'unknown' before this fix");
});

test("toDateOnly refuses garbage rather than producing 'Invalid Date'", () => {
  assert.strictEqual(toDateOnly(null), null);
  assert.strictEqual(toDateOnly(undefined), null);
  assert.strictEqual(toDateOnly(NaN), null);
  assert.strictEqual(toDateOnly(1787101971), '2026-08-19');
});

// ---------------------------------------------------------------------------

/**
 * A ledger the invoice can actually be booked into: customer resolves, the
 * period is open, and nothing is already recorded. Same shape the other
 * finance behavioural tests use, so a change to the write path fails here too.
 */
function ledgerDb() {
  return fakeSupabase({
    rpc: {
      set_audit_context: () => ({ data: null, error: null }),
      is_period_locked: () => ({ data: false, error: null }),
    },
    tables: {
      tenant_config: {
        select: () => ({ data: { tenant_id: CLIENT_TENANT }, error: null }),
        upsert: () => ({ data: null, error: null }),
      },
      tenants: { select: () => ({ data: [{ name: 'A Kut Above' }], error: null }) },
      attention_queue: { insert: () => ({ data: null, error: null }) },
      finance_entries: {
        select: (s) => (s.single === 'maybe' ? { data: null, error: null } : { data: [], error: null }),
        insert: () => ({ data: { id: 'fe_income' }, error: null }),
      },
    },
  });
}
