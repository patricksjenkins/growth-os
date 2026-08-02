'use strict';

/**
 * What Stripe would actually charge, versus what we publish.
 *
 * WHY (2026-08-02)
 * STRIPE_PRICE_SETUP pointed at an ARCHIVED $1,000 price. The real setup fee
 * is $199. STRIPE_PRICE_GROWTH pointed at an archived $299/mo against a
 * published $249. They resolved fine — they were simply a superseded
 * generation of price that had been archived and never removed from config.
 *
 * An invoice built from that id would have asked the first client for $1,000,
 * and nothing would have caught it: the id was present, the API call would
 * have succeeded, only the number was wrong.
 *
 * So price ids are not configuration. The product is; the active price is
 * resolved at send time and cross-checked against core/fga-knowledge.js.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { resolvePrice, checkPricing, EXPECTED } = require('../core/stripe-pricing');

/** A Stripe stand-in with one product and whichever prices a test needs. */
function fakeStripe(name, prices) {
  const product = { id: 'prod_x', name };
  return {
    products: {
      retrieve: async () => product,
      list: async () => ({ data: [product] }),
    },
    prices: { list: async () => ({ data: prices }) },
  };
}
const oneTime = (usd, active = true) => ({ id: `price_${usd}`, active, unit_amount: usd * 100, currency: 'usd', recurring: null });
const monthly = (usd, active = true) => ({ id: `price_${usd}m`, active, unit_amount: usd * 100, currency: 'usd', recurring: { interval: 'month' } });

test('the published price is what we expect to charge', () => {
  // If someone changes the pricing, this is where they find out the invoice
  // code cares.
  assert.strictEqual(EXPECTED.setup.usd, 199);
  assert.strictEqual(EXPECTED.growth.usd, 249);
  assert.strictEqual(EXPECTED.scale.usd, 399);
});

test('the exact bug: an archived-generation price with the wrong amount is refused', async () => {
  const stripe = fakeStripe('First Gen Automate — Setup', [oneTime(1000)]);
  await assert.rejects(
    () => resolvePrice('setup', { stripe }),
    /would charge \$1000\.00 for Setup fee, but we publish \$199/,
    'a $1,000 setup fee must never reach a customer',
  );
});

test('an archived price is never selected, even when it is the only one', async () => {
  const stripe = fakeStripe('First Gen Automate — Setup', [oneTime(199, false)]);
  await assert.rejects(() => resolvePrice('setup', { stripe }), /no active price/);
});

test('the active price wins over archived ones alongside it', async () => {
  // The real shape of the account: one active price, two archived.
  const stripe = fakeStripe('First Gen Automate — Setup', [
    oneTime(199, true), oneTime(1000, false), oneTime(2000, false),
  ]);
  const p = await resolvePrice('setup', { stripe });
  assert.strictEqual(p.unit_amount, 19900);
});

test('two live prices is refused rather than guessed', async () => {
  const stripe = fakeStripe('First Gen Automate — Growth', [monthly(249), monthly(249)]);
  await assert.rejects(
    () => resolvePrice('growth', { stripe }),
    /2 active recurring prices/,
    'guessing here means guessing what to charge someone',
  );
});

test('a one-time price cannot be used for a subscription tier', async () => {
  const stripe = fakeStripe('First Gen Automate — Growth', [oneTime(249)]);
  await assert.rejects(() => resolvePrice('growth', { stripe }), /no active recurring price/);
});

test('a recurring price cannot be used for the setup fee', async () => {
  const stripe = fakeStripe('First Gen Automate — Setup', [monthly(199)]);
  await assert.rejects(() => resolvePrice('setup', { stripe }), /no active one-time price/);
});

test('checkPricing reports unhealthy instead of throwing', async () => {
  const stripe = fakeStripe('First Gen Automate — Setup', [oneTime(1000)]);
  const r = await checkPricing({ stripe });
  // Startup must not crash over this; it has to say so loudly and keep serving.
  assert.strictEqual(r.healthy, false);
  assert.ok(r.problems.length > 0);
  assert.ok(r.problems.some((p) => /publish \$199/.test(p)));
});

test('a correct account reports healthy', async () => {
  // One product answering for all three kinds is fine for this check — what
  // matters is that correct amounts produce healthy:true.
  const stripe = {
    products: {
      retrieve: async () => ({ id: 'p', name: 'First Gen Automate' }),
      list: async () => ({ data: [
        { id: 'p1', name: 'First Gen Automate — Setup' },
        { id: 'p2', name: 'First Gen Automate — Growth' },
        { id: 'p3', name: 'First Gen Automate — Scale' },
      ] }),
    },
    prices: {
      list: async ({ product }) => ({ data: [
        product === 'p1' ? oneTime(199) : product === 'p2' ? monthly(249) : monthly(399),
      ] }),
    },
  };
  const r = await checkPricing({ stripe });
  assert.strictEqual(r.healthy, true, r.problems.join('; '));
  assert.strictEqual(r.checked.length, 3);
});
