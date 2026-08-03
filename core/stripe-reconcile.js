'use strict';

/**
 * What has this customer ALREADY been charged?
 *
 * WHY (2026-08-03)
 * The public pricing page sends people to Stripe Payment Links, and those
 * links already collect everything:
 *
 *   buy.stripe.com/...8IU00  →  $199 setup ONE-TIME + $249/mo Growth, 14-day trial
 *   buy.stripe.com/...8IU01  →  $199 setup ONE-TIME + $399/mo Scale,  14-day trial
 *
 * So a customer who pays through the website arrives already invoiced and
 * already subscribed. The onboarding checklist, however, still carries
 * `send_setup_invoice` and `start_subscription`, and their guards read
 * tenant_config.setup_invoice_id / stripe_subscription_id — keys only ever
 * written by OUR code. A Stripe-created invoice or subscription is invisible
 * to them.
 *
 * Clicking those two steps for a payment-link customer therefore:
 *   • invoices them a SECOND $199, and
 *   • creates a SECOND $249/mo subscription that bills every month, forever.
 *
 * Local flags cannot fix this, because the object they need to know about was
 * never created locally. The only thing that knows the truth is Stripe. So
 * before either money step runs we ask Stripe directly, and the answer covers
 * every route at once: payment links, Checkout, invoices Patrick raised by
 * hand in the dashboard, and a crash between our Stripe call and our own
 * database write.
 *
 * FAIL CLOSED. If we cannot get an answer out of Stripe, we do not charge.
 * "I could not check" and "they have not paid" are different facts, and only
 * one of them is safe to act on.
 */

const { createLogger } = require('./logger');
const { productIdFor } = require('./stripe-pricing');
const log = createLogger('stripe-reconcile');

/** Subscription states that mean "they already have one — do not make another". */
const LIVE_SUB_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

/** Invoice states that mean the money is collected or genuinely owed. */
const COUNTS_AS_BILLED = new Set(['paid', 'open']);

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return require('stripe')(key);
}

/** Every product id on an invoice, across its line items. */
function productsOnInvoice(invoice) {
  return (invoice.lines?.data || [])
    .map((l) => l.price?.product || l.plan?.product || l.pricing?.price_details?.product)
    .filter(Boolean);
}

/**
 * Has this customer already been billed the setup fee?
 *
 * Counts an OPEN invoice as well as a paid one: an unpaid invoice we already
 * sent is still an invoice they have, and sending a second one is exactly the
 * confusion this exists to prevent.
 *
 * @returns {Promise<{billed:boolean, evidence:Object|null}>}
 */
async function setupFeeAlreadyBilled(customerId, { stripe = null } = {}) {
  const client = stripe || stripeClient();
  const setupProduct = await productIdFor('setup', { stripe: client });

  const invoices = await client.invoices.list({ customer: customerId, limit: 100 });
  for (const inv of invoices.data || []) {
    if (!COUNTS_AS_BILLED.has(inv.status)) continue;

    // TWO WAYS AN INVOICE COUNTS, because there are two ways one gets made.
    //
    //  • the Setup PRODUCT is on a line — how a Payment Link purchase looks;
    //  • our own marker in metadata — how OUR invoices look, because
    //    sendSetupFeeInvoice attaches a raw amount rather than a price id and
    //    so leaves no product reference on the line at all.
    //
    // Checking only the product missed every invoice we sent ourselves. The
    // idempotency key hid it for 24 hours, which is long enough for a live
    // test to pass and short enough to have expired by the time a real
    // customer's second invoice went out.
    const byProduct = productsOnInvoice(inv).includes(setupProduct);
    const byMarker = inv.metadata?.fga_purpose === 'setup_fee';
    if (!byProduct && !byMarker) continue;

    return {
      billed: true,
      evidence: {
        source: 'stripe_invoice',
        invoice_id: inv.id,
        status: inv.status,
        amount_usd: (inv.amount_paid || inv.amount_due || 0) / 100,
        hosted_url: inv.hosted_invoice_url || null,
        created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      },
    };
  }

  // A Payment Link can also collect a one-time item through a PaymentIntent
  // that never becomes an invoice line. Checkout sessions carry the line items
  // that were actually bought, so ask them too.
  let sessions;
  try {
    sessions = await client.checkout.sessions.list({ customer: customerId, limit: 100 });
  } catch (err) {
    // Not being able to look is not the same as nothing being there.
    throw new Error(`Could not check this customer's Stripe checkouts: ${err.message}`);
  }
  for (const s of sessions.data || []) {
    if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') continue;
    let items;
    try {
      items = await client.checkout.sessions.listLineItems(s.id, { limit: 20 });
    } catch (_) { continue; }
    const hit = (items.data || []).find((i) => i.price?.product === setupProduct);
    if (hit) {
      return {
        billed: true,
        evidence: {
          source: 'stripe_checkout',
          session_id: s.id,
          amount_usd: (hit.amount_total ?? hit.price?.unit_amount ?? 0) / 100,
          created: s.created ? new Date(s.created * 1000).toISOString() : null,
        },
      };
    }
  }

  return { billed: false, evidence: null };
}

/**
 * Does this customer already have a live subscription to one of our tiers?
 *
 * Returns the existing one so the caller can ADOPT it — record its id and its
 * first charge date — rather than creating a second alongside it.
 *
 * @returns {Promise<{exists:boolean, subscription:Object|null}>}
 */
async function subscriptionAlreadyExists(customerId, { stripe = null } = {}) {
  const client = stripe || stripeClient();
  const tierProducts = new Set([
    await productIdFor('growth', { stripe: client }),
    await productIdFor('scale', { stripe: client }),
  ]);

  const subs = await client.subscriptions.list({
    customer: customerId, status: 'all', limit: 100,
  });

  for (const sub of subs.data || []) {
    if (!LIVE_SUB_STATUSES.has(sub.status)) continue;
    const products = (sub.items?.data || [])
      .map((i) => i.price?.product || i.plan?.product)
      .filter(Boolean);
    if (!products.some((p) => tierProducts.has(p))) continue;

    return {
      exists: true,
      subscription: {
        subscription_id: sub.id,
        status: sub.status,
        first_charge_date: sub.trial_end
          ? new Date(sub.trial_end * 1000).toISOString().slice(0, 10)
          : (sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString().slice(0, 10)
            : 'unknown'),
        monthly_usd: (sub.items?.data?.[0]?.price?.unit_amount || 0) / 100,
        created: sub.created ? new Date(sub.created * 1000).toISOString() : null,
      },
    };
  }
  return { exists: false, subscription: null };
}

/**
 * Everything the Onboarding Center needs to know before it offers to charge.
 *
 * Never throws for a caller that just wants to DISPLAY state — `ok:false` says
 * the picture is incomplete, and the money steps refuse on that alone.
 */
async function billingState(customerId, { stripe = null } = {}) {
  if (!customerId) {
    return { ok: true, setup: { billed: false, evidence: null }, subscription: { exists: false, subscription: null } };
  }
  try {
    const client = stripe || stripeClient();
    const [setup, subscription] = await Promise.all([
      setupFeeAlreadyBilled(customerId, { stripe: client }),
      subscriptionAlreadyExists(customerId, { stripe: client }),
    ]);
    return { ok: true, setup, subscription };
  } catch (err) {
    log.error(`Could not read billing state for ${customerId}: ${err.message}`);
    return { ok: false, error: err.message, setup: null, subscription: null };
  }
}

module.exports = {
  LIVE_SUB_STATUSES,
  COUNTS_AS_BILLED,
  setupFeeAlreadyBilled,
  subscriptionAlreadyExists,
  billingState,
};
