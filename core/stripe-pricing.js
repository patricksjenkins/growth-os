'use strict';

/**
 * Which Stripe price to charge — resolved live, never from a pinned id.
 *
 * WHY (2026-08-02)
 * The configured price IDs pointed at ARCHIVED prices carrying the wrong
 * amounts. In the test account, STRIPE_PRICE_SETUP resolved to a $1,000
 * one-time price; the real setup fee is $199. STRIPE_PRICE_GROWTH resolved to
 * $299/mo against a published $249. They resolved fine — they were simply an
 * older generation of price that had been superseded and archived.
 *
 * An invoice built from those would have asked the first client for $1,000,
 * and the subscription would have failed outright, because Stripe refuses an
 * archived price for a new subscription. Nothing would have caught it: the id
 * was present, the API call succeeded, the number was just wrong.
 *
 * So price ids are not configuration here. We hold the PRODUCT, ask Stripe for
 * its active price at send time, and cross-check the amount against the
 * published pricing in core/fga-knowledge.js. An archived price can never be
 * chosen because it is never selected, and a live price that has drifted from
 * what we publish stops the send instead of quietly billing it.
 *
 * The check runs at startup too (assertPricingHealthy), so a mismatch in the
 * LIVE account shows up in the logs on deploy rather than on an invoice.
 */

const { createLogger } = require('./logger');
const { FGA_KNOWLEDGE } = require('./fga-knowledge');
const log = createLogger('stripe-pricing');

/** What we publish. The amount Stripe charges has to agree with this. */
const EXPECTED = Object.freeze({
  setup:  { usd: FGA_KNOWLEDGE.pricing.setup_fee.amount,   recurring: false, label: 'Setup fee' },
  growth: { usd: FGA_KNOWLEDGE.pricing.growth_tier.amount, recurring: true,  label: 'Growth' },
  scale:  { usd: FGA_KNOWLEDGE.pricing.scale_tier.amount,  recurring: true,  label: 'Scale' },
});

/** Product ids, per environment. Products are stable; prices are not. */
const PRODUCT_ENV = Object.freeze({
  setup:  'STRIPE_PRODUCT_SETUP',
  growth: 'STRIPE_PRODUCT_GROWTH',
  scale:  'STRIPE_PRODUCT_SCALE',
});

/**
 * Names we fall back to when no product id is configured.
 *
 * These MUST be anchored to the FGA brand. The first version matched a bare
 * /setup/i, and the live catalogue contains "923A - Setup" ($500) alongside
 * "First Gen Automate — Setup" ($199) because 923A is a custom build with its
 * own products. The loose pattern matched both and Stripe returned the newer
 * one, so the boot check reported a $500 setup fee — and an invoice sent that
 * way would have billed a brand-new client using another client's custom
 * pricing.
 *
 * A client's own product must never be selectable as the standard one.
 */
const PRODUCT_NAMES = Object.freeze({
  setup:  /^first\s*gen\s*automate\b.*\bsetup\b/i,
  growth: /^first\s*gen\s*automate\b.*\bgrowth\b/i,
  scale:  /^first\s*gen\s*automate\b.*\bscale\b/i,
});

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return require('stripe')(key);
}

/** Find the product for a kind: configured id first, then by name. */
async function findProduct(stripe, kind) {
  const configured = process.env[PRODUCT_ENV[kind]];
  if (configured) {
    const p = await stripe.products.retrieve(configured);
    if (!p || p.deleted) throw new Error(`${PRODUCT_ENV[kind]} points at a product that no longer exists`);
    return p;
  }
  const list = await stripe.products.list({ active: true, limit: 100 });
  const matches = (list.data || []).filter((p) => PRODUCT_NAMES[kind].test(p.name || ''));

  if (!matches.length) {
    throw new Error(
      `No active Stripe product matching "${kind}". Set ${PRODUCT_ENV[kind]} to the product id.`,
    );
  }
  if (matches.length > 1) {
    // Same principle as two live prices on one product: which of these to
    // charge is a question only a human can answer, and guessing means
    // guessing what to bill someone.
    throw new Error(
      `${matches.length} active products match "${kind}" `
      + `(${matches.map((p) => `"${p.name}"`).join(', ')}). `
      + `Set ${PRODUCT_ENV[kind]} to the one you mean.`,
    );
  }
  return matches[0];
}

/**
 * The price to charge for a kind ('setup' | 'growth' | 'scale').
 *
 * @returns {Promise<{id, unit_amount, currency, recurring, product, productName}>}
 * @throws if there is no active price, several are ambiguous, or the amount
 *         disagrees with published pricing.
 */
async function resolvePrice(kind, { stripe = null, allowAmountMismatch = false } = {}) {
  const expected = EXPECTED[kind];
  if (!expected) throw new Error(`Unknown price kind: ${kind}`);
  const client = stripe || stripeClient();

  const product = await findProduct(client, kind);
  const prices = await client.prices.list({ product: product.id, active: true, limit: 100 });
  const active = (prices.data || []).filter((p) => p.active);

  if (!active.length) {
    throw new Error(`"${product.name}" has no active price. Un-archive one or create it in Stripe.`);
  }

  const shaped = active.filter((p) => Boolean(p.recurring) === expected.recurring);
  if (!shaped.length) {
    throw new Error(
      `"${product.name}" has no active ${expected.recurring ? 'recurring' : 'one-time'} price.`,
    );
  }
  if (shaped.length > 1) {
    // Two live prices for the same thing is a question only a human can
    // settle, and guessing means guessing what to charge someone.
    throw new Error(
      `"${product.name}" has ${shaped.length} active ${expected.recurring ? 'recurring' : 'one-time'} prices `
      + `(${shaped.map((p) => `${p.id} $${(p.unit_amount / 100).toFixed(2)}`).join(', ')}). `
      + `Archive the ones you are not using, or set ${PRODUCT_ENV[kind]} to a product with exactly one.`,
    );
  }

  const price = shaped[0];
  const usd = price.unit_amount / 100;
  if (usd !== expected.usd && !allowAmountMismatch) {
    throw new Error(
      `Stripe would charge $${usd.toFixed(2)} for ${expected.label}, but we publish $${expected.usd}. `
      + `Fix the price in Stripe, or the pricing in core/fga-knowledge.js — do not invoice until they agree.`,
    );
  }

  return {
    id: price.id,
    unit_amount: price.unit_amount,
    currency: price.currency,
    recurring: price.recurring || null,
    product: product.id,
    productName: product.name,
  };
}

/**
 * Check every price we can charge, without throwing.
 *
 * Called at startup so a mismatch in the LIVE account is visible on deploy
 * rather than discovered on a customer's invoice.
 *
 * @returns {Promise<{healthy:boolean, checked:Array, problems:string[]}>}
 */
async function checkPricing({ stripe = null } = {}) {
  const problems = [];
  const checked = [];

  // Only the key matters when we have to BUILD a client. An injected one
  // (tests, or a caller that already has a configured client) needs no env at
  // all — requiring it anyway made this report "unhealthy" for a reason that
  // had nothing to do with the prices.
  if (!stripe && !process.env.STRIPE_SECRET_KEY) {
    return { healthy: false, checked, problems: ['STRIPE_SECRET_KEY is not set — no pricing could be checked'] };
  }
  const client = stripe || stripeClient();

  for (const kind of Object.keys(EXPECTED)) {
    try {
      const p = await resolvePrice(kind, { stripe: client });
      checked.push({ kind, price: p.id, usd: p.unit_amount / 100, product: p.productName });
    } catch (err) {
      problems.push(`${kind}: ${err.message}`);
    }
  }
  return { healthy: problems.length === 0, checked, problems };
}

/** Startup check. Logs; never prevents boot. */
async function assertPricingHealthy() {
  try {
    const r = await checkPricing();
    if (r.healthy) {
      log.info(`Stripe pricing OK — ${r.checked.map((c) => `${c.kind} $${c.usd}`).join(', ')}`);
      return r;
    }
    // Loud, because the failure mode is billing someone the wrong amount.
    log.error(`STRIPE PRICING IS WRONG — do not invoice anyone until this is fixed:`);
    r.problems.forEach((p) => log.error(`  • ${p}`));
    return r;
  } catch (err) {
    log.error(`Stripe pricing check could not run: ${err.message}`);
    return { healthy: false, checked: [], problems: [err.message] };
  }
}

module.exports = {
  EXPECTED,
  PRODUCT_ENV,
  resolvePrice,
  checkPricing,
  assertPricingHealthy,
};
