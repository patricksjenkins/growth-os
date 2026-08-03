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

/*
 * The live catalogue contains other clients' products.
 *
 * 923A is a custom build with its own "923A - Setup" at $500, sitting
 * alongside "First Gen Automate — Setup" at $199. The first version of the
 * name fallback matched a bare /setup/i, so it matched both and Stripe
 * returned the newer one. The boot check duly reported a $500 setup fee.
 *
 * The amount cross-check caught it, which is the only reason it surfaced as a
 * warning rather than as an invoice. But had 923A's setup happened to BE $199,
 * the check would have passed and a new client would have been billed against
 * another client's product.
 */
function liveCatalogue() {
  const products = [
    { id: 'prod_aka',       name: 'A Kut Above' },
    { id: 'prod_923a_mo',   name: '923A Coins - Monthly' },
    { id: 'prod_923a_setup',name: '923A - Setup' },
    { id: 'prod_fga_scale', name: 'First Gen Automate — Scale' },
    { id: 'prod_fga_setup', name: 'First Gen Automate — Setup' },
    { id: 'prod_fga_growth',name: 'First Gen Automate — Growth' },
  ];
  const prices = {
    prod_aka:        [{ id: 'p_aka',   active: true, unit_amount: 27600, currency: 'usd', recurring: { interval: 'year' } }],
    prod_923a_mo:    [{ id: 'p_923m',  active: true, unit_amount: 49900, currency: 'usd', recurring: { interval: 'month' } }],
    prod_923a_setup: [{ id: 'p_923s',  active: true, unit_amount: 50000, currency: 'usd', recurring: null }],
    prod_fga_scale:  [{ id: 'p_scale', active: true, unit_amount: 39900, currency: 'usd', recurring: { interval: 'month' } }],
    prod_fga_setup:  [{ id: 'p_setup', active: true, unit_amount: 19900, currency: 'usd', recurring: null }],
    prod_fga_growth: [{ id: 'p_grow',  active: true, unit_amount: 24900, currency: 'usd', recurring: { interval: 'month' } }],
  };
  return {
    products: {
      retrieve: async (id) => products.find((p) => p.id === id),
      // Newest first, which is how 923A's setup won.
      list: async () => ({ data: products }),
    },
    prices: { list: async ({ product }) => ({ data: prices[product] || [] }) },
  };
}

test('another client\'s product is never selected as the standard one', async () => {
  const stripe = liveCatalogue();
  const p = await resolvePrice('setup', { stripe });
  assert.strictEqual(p.unit_amount, 19900, 'must be the $199 FGA setup fee');
  assert.strictEqual(p.productName, 'First Gen Automate — Setup');
  assert.notStrictEqual(p.product, 'prod_923a_setup',
    "923A's custom $500 setup must never be billed to a standard client");
});

test('the whole live catalogue resolves correctly', async () => {
  const r = await checkPricing({ stripe: liveCatalogue() });
  assert.strictEqual(r.healthy, true, r.problems.join('; '));
  const byKind = Object.fromEntries(r.checked.map((c) => [c.kind, c.usd]));
  assert.deepStrictEqual(byKind, { setup: 199, growth: 249, scale: 399 });
  // And every one came from an FGA-branded product.
  assert.ok(r.checked.every((c) => /^First Gen Automate/.test(c.product)),
    'every charge must come from an FGA product, never a client-specific one');
});

test('two FGA products of the same kind is refused, not guessed', async () => {
  const stripe = {
    products: {
      retrieve: async () => null,
      list: async () => ({ data: [
        { id: 'a', name: 'First Gen Automate — Setup' },
        { id: 'b', name: 'First Gen Automate Setup (old)' },
      ] }),
    },
    prices: { list: async () => ({ data: [oneTime(199)] }) },
  };
  await assert.rejects(() => resolvePrice('setup', { stripe }), /2 active products match/);
});
