/**
 * Growth OS — Stripe Integration Shell
 * Payment processing, subscriptions, and revenue tracking
 *
 * Requires: STRIPE_SECRET_KEY in environment
 * Install: npm install stripe
 */

const { createLogger } = require('../core/logger');
const log = createLogger('stripe');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ---------------------------------------------------------------------------
// Customer Management
// ---------------------------------------------------------------------------

/**
 * Create a new Stripe customer
 * @param {string} email - Customer email
 * @param {string} name - Customer/business name
 * @param {Object} metadata - Extra metadata (tenantId, tier, etc.)
 * @returns {Object} Stripe customer object
 */
async function createCustomer(email, name, metadata = {}) {
  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata,
    });
    log.info(`Created Stripe customer ${customer.id} for ${email}`);
    return customer;
  } catch (err) {
    log.error(`Failed to create customer: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Charges & Subscriptions
// ---------------------------------------------------------------------------

/**
 * Create a one-time $2,000 setup fee charge
 * @param {string} customerId - Stripe customer ID
 * @returns {Object} Stripe payment intent or invoice item
 */
async function createSetupFeeCharge(customerId) {
  try {
    const priceId = process.env.STRIPE_PRICE_SETUP;

    // If a setup price ID exists, use an invoice item + immediate invoice
    if (priceId) {
      await stripe.invoiceItems.create({
        customer: customerId,
        price: priceId,
        description: 'Growth OS Setup Fee',
      });
      const invoice = await stripe.invoices.create({
        customer: customerId,
        auto_advance: true, // auto-finalize and attempt payment
        collection_method: 'charge_automatically',
        metadata: { type: 'setup_fee' },
      });
      const finalizedInvoice = await stripe.invoices.finalizeInvoice(invoice.id);
      log.info(`Created setup fee invoice ${finalizedInvoice.id} for customer ${customerId}`);
      return finalizedInvoice;
    }

    // Fallback: create a payment intent directly for $2,000
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 200000, // $2,000 in cents
      currency: 'usd',
      customer: customerId,
      description: 'Growth OS Setup Fee',
      metadata: { type: 'setup_fee' },
    });
    log.info(`Created setup fee payment intent ${paymentIntent.id} for customer ${customerId}`);
    return paymentIntent;
  } catch (err) {
    log.error(`Failed to create setup fee: ${err.message}`);
    throw err;
  }
}

/**
 * Create a recurring subscription
 * @param {string} customerId - Stripe customer ID
 * @param {'growth'|'scale'} tier - Subscription tier
 * @returns {Object} Stripe subscription object
 */
async function createSubscription(customerId, tier) {
  const priceMap = {
    growth: process.env.STRIPE_PRICE_GROWTH,
    scale: process.env.STRIPE_PRICE_SCALE,
  };

  const priceId = priceMap[tier.toLowerCase()];
  if (!priceId) {
    throw new Error(`Unknown tier "${tier}". Must be "growth" or "scale".`);
  }

  try {
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: { tier: tier.toLowerCase() },
    });
    log.info(`Created ${tier} subscription ${subscription.id} for customer ${customerId}`);
    return subscription;
  } catch (err) {
    log.error(`Failed to create subscription: ${err.message}`);
    throw err;
  }
}

/**
 * Cancel a subscription with 30-day notice (cancel at period end)
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Object} Updated subscription
 */
async function cancelSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
      metadata: { cancel_requested_at: new Date().toISOString() },
    });
    log.info(`Subscription ${subscriptionId} set to cancel at period end: ${new Date(subscription.current_period_end * 1000).toISOString()}`);
    return subscription;
  } catch (err) {
    log.error(`Failed to cancel subscription: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Billing Portal
// ---------------------------------------------------------------------------

/**
 * Generate a Stripe customer billing portal URL
 * @param {string} customerId - Stripe customer ID
 * @param {string} returnUrl - URL to return to after portal session
 * @returns {string} Portal session URL
 */
async function getCustomerPortalUrl(customerId, returnUrl = process.env.API_URL) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return session.url;
  } catch (err) {
    log.error(`Failed to create portal session: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Revenue Summary
// ---------------------------------------------------------------------------

/**
 * Fetch MRR, total customers, and revenue breakdown by tier
 * @returns {Object} Revenue summary
 */
async function getRevenueSummary() {
  try {
    // Fetch all active subscriptions
    const subscriptions = [];
    let hasMore = true;
    let startingAfter = undefined;

    while (hasMore) {
      const params = { status: 'active', limit: 100, expand: ['data.customer'] };
      if (startingAfter) params.starting_after = startingAfter;
      const batch = await stripe.subscriptions.list(params);
      subscriptions.push(...batch.data);
      hasMore = batch.has_more;
      if (batch.data.length > 0) {
        startingAfter = batch.data[batch.data.length - 1].id;
      }
    }

    // Calculate MRR and tier breakdown
    let mrr = 0;
    const tiers = { growth: { count: 0, mrr: 0 }, scale: { count: 0, mrr: 0 } };

    for (const sub of subscriptions) {
      const monthlyAmount = sub.items.data.reduce((sum, item) => {
        const unitAmount = item.price.unit_amount || 0;
        const interval = item.price.recurring?.interval;
        if (interval === 'month') return sum + unitAmount;
        if (interval === 'year') return sum + Math.round(unitAmount / 12);
        return sum + unitAmount;
      }, 0);

      mrr += monthlyAmount;
      const tier = sub.metadata?.tier || 'growth';
      if (tiers[tier]) {
        tiers[tier].count += 1;
        tiers[tier].mrr += monthlyAmount;
      }
    }

    // Fetch total customer count
    const customers = await stripe.customers.list({ limit: 1 });
    const totalCustomers = customers.total_count || subscriptions.length;

    return {
      mrr: mrr / 100, // convert cents to dollars
      mrrFormatted: `$${(mrr / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      totalCustomers,
      activeSubscriptions: subscriptions.length,
      tiers: {
        growth: {
          count: tiers.growth.count,
          mrr: tiers.growth.mrr / 100,
        },
        scale: {
          count: tiers.scale.count,
          mrr: tiers.scale.mrr / 100,
        },
      },
    };
  } catch (err) {
    log.error(`Failed to fetch revenue summary: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Webhook Handler
// ---------------------------------------------------------------------------

/**
 * Handle incoming Stripe webhook events
 * @param {Buffer|string} payload - Raw request body
 * @param {string} signature - Stripe-Signature header
 * @returns {Object} Processed event result
 */
async function handleWebhook(payload, signature) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    log.error(`Webhook signature verification failed: ${err.message}`);
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  log.info(`Received webhook: ${event.type} (${event.id})`);

  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object;
      log.info(`Invoice ${invoice.id} paid — $${(invoice.amount_paid / 100).toFixed(2)} for customer ${invoice.customer}`);
      // TODO: Record payment in finance_entries, update tenant billing status
      return { action: 'invoice_paid', invoiceId: invoice.id, amount: invoice.amount_paid / 100 };
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      log.warn(`Payment failed for invoice ${invoice.id}, customer ${invoice.customer}`);
      // TODO: Send dunning email, create account alert, update health score
      return { action: 'payment_failed', invoiceId: invoice.id, customerId: invoice.customer };
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      log.info(`Subscription ${subscription.id} deleted for customer ${subscription.customer}`);
      // TODO: Transition account to churned, trigger offboarding workflow
      return { action: 'subscription_deleted', subscriptionId: subscription.id };
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      log.info(`Subscription ${subscription.id} updated — status: ${subscription.status}`);
      // TODO: Handle tier changes, status transitions
      return { action: 'subscription_updated', subscriptionId: subscription.id, status: subscription.status };
    }

    case 'checkout.session.completed': {
      const session = event.data.object;
      log.info(`Checkout session ${session.id} completed for customer ${session.customer}`);
      // TODO: Provision tenant if new, activate subscription
      return { action: 'checkout_completed', sessionId: session.id, customerId: session.customer };
    }

    default:
      log.info(`Unhandled webhook event type: ${event.type}`);
      return { action: 'ignored', type: event.type };
  }
}

module.exports = {
  createCustomer,
  createSetupFeeCharge,
  createSubscription,
  cancelSubscription,
  getCustomerPortalUrl,
  getRevenueSummary,
  handleWebhook,
};
