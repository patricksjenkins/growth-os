/**
 * Growth OS — Stripe Integration Shell
 * Payment processing, subscriptions, and revenue tracking
 *
 * Requires: STRIPE_SECRET_KEY in environment
 * Install: npm install stripe
 */

const { createLogger } = require('../core/logger');
const log = createLogger('stripe');

// V1 hardening (2026-05-24): Stripe's Node SDK has built-in retry support
// via maxNetworkRetries — it honors Stripe's idempotency semantics
// automatically and retries on 408/429/5xx + network errors. 3 retries
// matches the same surface as our integrations/_retry.js helper used
// for Serper / Claude / Gemini / Buffer.
//
// timeout: 30s is generous for Stripe — most calls return under 1s but
// invoice.finalizeInvoice can occasionally take longer.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  maxNetworkRetries: 3,
  timeout: 30000,
});

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
async function createSetupFeeCharge(customerId, options = {}) {
  // Demo-mode guard — skip real charges for demo tenants.
  if (options.tenant) {
    const { isDemoTenant, demoMockResponse } = require('./demo-guard');
    if (isDemoTenant(options.tenant)) {
      log.info(`[demo] Setup fee charge mocked for customer ${customerId}`);
      return demoMockResponse('stripe_setup_fee', {
        customerId, amount: 2000, status: 'paid',
      });
    }
  }

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
async function createSubscription(customerId, tier, options = {}) {
  // Demo-mode guard — skip real subscription for demo tenants.
  if (options.tenant) {
    const { isDemoTenant, demoMockResponse } = require('./demo-guard');
    if (isDemoTenant(options.tenant)) {
      log.info(`[demo] Subscription create mocked for customer ${customerId} (${tier})`);
      return demoMockResponse('stripe_subscription', {
        customerId, tier, status: 'active',
      });
    }
  }

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

  // Lazy-require to avoid a circular dep loop (finance-sync uses logger
  // which lives outside integrations).
  const financeSync = require('./finance-sync');
  const { getServiceClient } = require('../db/client');

  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object;
      log.info(`Invoice ${invoice.id} paid — $${(invoice.amount_paid / 100).toFixed(2)} for customer ${invoice.customer}`);
      // Phase 1: idempotently record as finance_entries income.
      // finance-sync handles: tenant lookup, period-lock check,
      // duplicate detection, audit context, and orphan triage.
      const result = await financeSync.recordStripeInvoicePaid(
        getServiceClient(),
        invoice,
      );
      return {
        action: 'invoice_paid',
        invoiceId: invoice.id,
        amount: invoice.amount_paid / 100,
        sync: result,  // { status: 'created'|'duplicate'|'orphaned'|'period_locked'|'error', ... }
      };
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      log.warn(`Payment failed for invoice ${invoice.id}, customer ${invoice.customer}`);
      // Drop a red-severity item into the attention_queue so the
      // Action Ribbon surfaces it immediately.
      await financeSync.recordStripePaymentFailed(getServiceClient(), invoice);
      return { action: 'payment_failed', invoiceId: invoice.id, customerId: invoice.customer };
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      log.info(`Subscription ${subscription.id} deleted for customer ${subscription.customer}`);
      // Amber-severity attention_queue item — final churn disposition
      // is manual (Patrick reviews + clicks "Mark churned").
      await financeSync.recordStripeSubscriptionDeleted(getServiceClient(), subscription);
      return { action: 'subscription_deleted', subscriptionId: subscription.id };
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      log.info(`Subscription ${subscription.id} updated — status: ${subscription.status}`);
      // Blue-severity informational item; surfaces tier changes for verification.
      await financeSync.recordStripeSubscriptionUpdated(getServiceClient(), subscription);
      return { action: 'subscription_updated', subscriptionId: subscription.id, status: subscription.status };
    }

    case 'checkout.session.completed': {
      const session = event.data.object;
      log.info(`Checkout session ${session.id} completed for customer ${session.customer}`);

      // Fire Meta Conversions API Purchase event FIRST (before any
      // onboarding logic). Ad measurement must never be blocked by a
      // missing tenant_id or onboarding failure — this is fire-and-
      // forget by design, errors are logged inside the helper. The
      // event_id was set by the marketing-site PricingCard via
      // ?client_reference_id=<uuid> and matches the browser Pixel
      // event_id so Meta dedupes the pair.
      try {
        const { sendPurchaseEvent } = require('./meta-capi');
        const fbEventId = session.client_reference_id || null;
        const purchaseEmail = session.customer_email || session.customer_details?.email || null;
        const purchasePhone = session.customer_details?.phone || null;
        const purchaseValue = session.amount_total ? session.amount_total / 100 : null;
        if (fbEventId && purchaseValue) {
          // Non-blocking — don't await; webhook should ack to Stripe fast.
          // The retry helper inside sendPurchaseEvent keeps trying for ~15s.
          sendPurchaseEvent({
            eventId: fbEventId,
            value: purchaseValue,
            currency: (session.currency || 'usd').toUpperCase(),
            email: purchaseEmail,
            phone: purchasePhone,
            sourceUrl: 'https://firstgenautomate.com/pricing',
          }).catch((err) => log.warn(`Meta CAPI purchase fire failed: ${err.message}`));
        } else {
          log.info(
            `Skipping Meta CAPI Purchase for session ${session.id} — ` +
              `missing ${!fbEventId ? 'client_reference_id' : 'amount_total'}`,
          );
        }
      } catch (capiErr) {
        // Defensive: a require() failure or helper module bug should not
        // brick the rest of the webhook handler.
        log.error(`Meta CAPI integration threw: ${capiErr.message}`);
      }

      // If the checkout session carries a tenant_id in metadata, kick off
      // the 7-day onboarding workflow. The session must have been created
      // with metadata.tenant_id set by the checkout-creation endpoint.
      // Without a tenant_id we can't start onboarding — log and bail.
      const tenantId = session.metadata?.tenant_id;
      if (!tenantId) {
        log.info('checkout.session.completed has no tenant_id in metadata — onboarding not started');
        return { action: 'checkout_completed', sessionId: session.id, customerId: session.customer };
      }

      try {
        // Lazy requires to avoid circular deps with db/client and core/onboarding
        const { getServiceClient } = require('../db/client');
        const { startOnboarding, getOnboardingStatus } = require('../core/onboarding');
        const supabase = getServiceClient();

        // Idempotency: if onboarding already started for this tenant, don't
        // start it again (Stripe may replay the webhook).
        const existing = await getOnboardingStatus(supabase, tenantId);
        if (existing) {
          log.info(`Onboarding already active for tenant ${tenantId} — ignoring duplicate checkout event`);
          return {
            action: 'checkout_completed',
            sessionId: session.id,
            tenantId,
            onboarding_started: false,
            reason: 'already_started',
          };
        }

        // Build the intake context that email templates will use for rendering
        const intake = {
          stripe_customer_id: session.customer,
          stripe_session_id: session.id,
          email: session.customer_email || session.customer_details?.email || null,
          owner_name: session.customer_details?.name || null,
          business_name: session.metadata?.business_name || null,
          tier: session.metadata?.tier || null,
          amount_paid: session.amount_total ? session.amount_total / 100 : null,
          ...(session.metadata || {}),
        };

        const workflow = await startOnboarding(supabase, tenantId, intake);
        log.info(`Onboarding started for tenant ${tenantId} — workflow ${workflow.id}`);

        // Send the dual-platform welcome wizard email (and SMS if Twilio
        // platform creds are configured). This is the message that gives
        // the customer their magic-link login + App Store / web links
        // for the onboarding wizard. Non-fatal: log on failure so the
        // webhook always returns 200 and Stripe doesn't retry forever.
        let welcome_sent = false;
        try {
          if (intake.email) {
            const { sendWelcomeWizard } = require('../core/welcome-wizard');
            await sendWelcomeWizard(supabase, {
              tenantId,
              email: intake.email,
              ownerName: intake.owner_name,
              businessName: intake.business_name,
              phone: intake.phone,
            });
            welcome_sent = true;
          } else {
            log.warn(`Cannot send welcome wizard for tenant ${tenantId} — no email captured from Stripe session`);
          }
        } catch (welcomeErr) {
          log.error(`sendWelcomeWizard failed for tenant ${tenantId}: ${welcomeErr.message}`);
        }

        return {
          action: 'checkout_completed',
          sessionId: session.id,
          tenantId,
          onboarding_started: true,
          workflow_id: workflow.id,
          welcome_sent,
        };
      } catch (err) {
        log.error(`Failed to start onboarding for tenant ${tenantId}: ${err.message}`);
        return {
          action: 'checkout_completed_error',
          sessionId: session.id,
          tenantId,
          error: err.message,
        };
      }
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
