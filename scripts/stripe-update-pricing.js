/**
 * Growth OS — Stripe Pricing Update
 *
 * Idempotent script that brings FGA's Stripe products + prices into
 * sync with the current pricing model:
 *   • Setup:  $1,000 one-time
 *   • Growth: $299/mo recurring
 *   • Scale:  $499/mo recurring
 *
 * Behavior per product (matched by name substring):
 *   1. Look up the product in Stripe.
 *   2. If a price with the target amount + recurrence already exists
 *      and is active, do nothing.
 *   3. Otherwise, create the target price.
 *   4. Archive every other active price on that product so the new
 *      price is the unambiguous default.
 *
 * Prints the resulting STRIPE_PRICE_SETUP / STRIPE_PRICE_GROWTH /
 * STRIPE_PRICE_SCALE env values at the end. Patrick pastes those
 * into Railway.
 *
 * Defaults to running against Stripe TEST mode (the secret key in
 * .env is sk_test_… in sandbox). To run against live mode, use
 * STRIPE_SECRET_KEY=sk_live_… in env when invoking.
 *
 * Usage:
 *   node scripts/stripe-update-pricing.js              # dry-run
 *   node scripts/stripe-update-pricing.js --apply      # actually update
 */

require('dotenv').config({ override: true });
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY is required. Check .env or pass via env.');
  process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Target spec — what we want each product to have as its active price
const TARGETS = [
  {
    nameContains: 'Setup',
    targetAmountCents: 100000, // $1,000
    recurring: null,           // one-time
    envName: 'STRIPE_PRICE_SETUP',
  },
  {
    nameContains: 'Growth',
    targetAmountCents: 29900,  // $299
    recurring: { interval: 'month', interval_count: 1 },
    envName: 'STRIPE_PRICE_GROWTH',
  },
  {
    nameContains: 'Scale',
    targetAmountCents: 49900,  // $499
    recurring: { interval: 'month', interval_count: 1 },
    envName: 'STRIPE_PRICE_SCALE',
  },
];

function parseArgs() {
  return { apply: process.argv.includes('--apply') };
}

function fmt(cents) {
  return '$' + (cents / 100).toFixed(2);
}

async function findProductByName(name) {
  // Stripe doesn't have substring search, so list active products and filter
  const products = [];
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    products.push(p);
  }
  const match = products.find((p) => (p.name || '').toLowerCase().includes(name.toLowerCase()));
  return match || null;
}

async function listPricesForProduct(productId) {
  const prices = [];
  for await (const p of stripe.prices.list({ product: productId, active: true, limit: 100 })) {
    prices.push(p);
  }
  return prices;
}

function recurringMatches(p, target) {
  if (target.recurring === null) return !p.recurring;
  if (!p.recurring) return false;
  return p.recurring.interval === target.recurring.interval
      && (p.recurring.interval_count || 1) === (target.recurring.interval_count || 1);
}

async function processTarget(target, args) {
  console.log(`\n=== ${target.nameContains} (target ${fmt(target.targetAmountCents)}${target.recurring ? '/' + target.recurring.interval : ' one-time'}) ===`);

  const product = await findProductByName(target.nameContains);
  if (!product) {
    console.log(`  ✗ No product found matching "${target.nameContains}". Skipping.`);
    return null;
  }
  console.log(`  Product: ${product.name} (${product.id})`);

  const prices = await listPricesForProduct(product.id);
  console.log(`  Active prices: ${prices.length}`);
  prices.forEach((p) => {
    const tag = p.unit_amount === target.targetAmountCents && recurringMatches(p, target) ? '  ← TARGET' : '';
    console.log(`    - ${p.id} ${fmt(p.unit_amount)}${p.recurring ? '/' + p.recurring.interval : ' one-time'}${tag}`);
  });

  // Is a matching active price already there?
  const existingTarget = prices.find(
    (p) => p.unit_amount === target.targetAmountCents && recurringMatches(p, target),
  );

  let targetPrice;
  if (existingTarget) {
    console.log(`  ✓ Target price already exists: ${existingTarget.id}`);
    targetPrice = existingTarget;
  } else {
    if (!args.apply) {
      console.log(`  → DRY RUN: would create new ${fmt(target.targetAmountCents)} price`);
      return null;
    }
    const createParams = {
      product: product.id,
      currency: 'usd',
      unit_amount: target.targetAmountCents,
    };
    if (target.recurring) createParams.recurring = target.recurring;
    targetPrice = await stripe.prices.create(createParams);
    console.log(`  ✓ Created new price: ${targetPrice.id}`);
  }

  // Archive any other active prices on this product
  const stale = prices.filter((p) => p.id !== targetPrice.id);
  if (stale.length) {
    if (!args.apply) {
      console.log(`  → DRY RUN: would archive ${stale.length} stale price(s)`);
    } else {
      for (const p of stale) {
        await stripe.prices.update(p.id, { active: false });
        console.log(`  ✓ Archived stale price: ${p.id} (${fmt(p.unit_amount)})`);
      }
    }
  }

  return { envName: target.envName, priceId: targetPrice.id };
}

async function main() {
  const args = parseArgs();
  const accountType = process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST';
  console.log(`Mode: ${args.apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Stripe environment: ${accountType}`);

  const results = [];
  for (const target of TARGETS) {
    const r = await processTarget(target, args);
    if (r) results.push(r);
  }

  console.log('\n=== Result ===');
  if (!results.length) {
    console.log('No changes needed (or dry-run only — pass --apply).');
    return;
  }
  console.log('Set these on Railway (Variables tab → add or update):\n');
  for (const r of results) {
    console.log(`  ${r.envName}=${r.priceId}`);
  }
  console.log('\nAfter setting on Railway, redeploy or wait for auto-restart.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  if (err.raw) console.error('Stripe error:', err.raw);
  process.exit(1);
});
