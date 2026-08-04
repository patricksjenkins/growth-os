/**
 * Growth OS — Stripe Integration Shell
 * Payment processing, subscriptions, and revenue tracking
 *
 * Requires: STRIPE_SECRET_KEY in environment
 * Install: npm install stripe
 */

const { createLogger } = require('../core/logger');
const { FGA_KNOWLEDGE } = require('../core/fga-knowledge');
const log = createLogger('stripe');

// Single source of truth for pricing is core/fga-knowledge.js. The live
// charge normally comes from the STRIPE_PRICE_SETUP price ID; these values
// only back the fallback path and demo mocks, and must never be hardcoded
// here again (this file once carried a setup fee from two pricing
// generations ago — guarded by test/pricing-single-source.test.js).
const SETUP_FEE_DOLLARS = FGA_KNOWLEDGE.pricing.setup_fee.amount;
const SETUP_FEE_CENTS = SETUP_FEE_DOLLARS * 100;

// The trial length we actually sell, and the only one a standard subscription
// may use. The live Payment Links carry the same 14, so a checkout customer
// and a hand-invoiced customer land on the same day-15 first charge.
const STANDARD_TRIAL_DAYS = 14;

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
 * Create the one-time setup fee charge (amount from core/fga-knowledge.js)
 * @param {string} customerId - Stripe customer ID
 * @returns {Object} Stripe payment intent or invoice item
 */
/**
 * @deprecated Reads STRIPE_PRICE_SETUP, which pointed at an ARCHIVED $1,000
 * price while the real setup fee is $199. Use sendSetupFeeInvoice, which
 * resolves the ACTIVE price and cross-checks it against published pricing.
 * Kept only because removing an export is a breaking change; it now refuses
 * to run rather than charge an unverified amount.
 */
async function createSetupFeeCharge(customerId, options = {}) {
  throw new Error(
    'createSetupFeeCharge is retired — it charges from STRIPE_PRICE_SETUP, which '
    + 'has pointed at an archived price with the wrong amount. Use '
    + 'sendSetupFeeInvoice() instead; it resolves the active price and verifies it.',
  );
  /* eslint-disable no-unreachable */
  // Demo-mode guard — skip real charges for demo tenants.
  if (options.tenant) {
    const { isDemoTenant, demoMockResponse } = require('./demo-guard');
    if (isDemoTenant(options.tenant)) {
      log.info(`[demo] Setup fee charge mocked for customer ${customerId}`);
      return demoMockResponse('stripe_setup_fee', {
        customerId, amount: SETUP_FEE_DOLLARS, status: 'paid',
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
        description: 'First Gen Automate Setup Fee',
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

    // Fallback when no STRIPE_PRICE_SETUP is configured: charge the
    // knowledge-base setup fee directly.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: SETUP_FEE_CENTS,
      currency: 'usd',
      customer: customerId,
      description: 'First Gen Automate Setup Fee',
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
/**
 * @deprecated Reads STRIPE_PRICE_GROWTH / STRIPE_PRICE_SCALE, which pointed at
 * archived prices with the wrong amounts, and applies no trial. Use
 * startTrialSubscription.
 */
async function createSubscription(customerId, tier, options = {}) {
  throw new Error(
    'createSubscription is retired — it reads archived STRIPE_PRICE_* env vars and '
    + 'applies no trial. Use startTrialSubscription(), which resolves the active '
    + 'price and honours the 14-day trial.',
  );
  /* eslint-disable no-unreachable */
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
 * Make sure Patrick knows a paid customer is waiting — on EVERY path.
 *
 * WHY (2026-08-03)
 * This lived inline, after the "onboarding already started" early return. So
 * if the workflow was created but the alert insert failed, the Stripe retry
 * saw a workflow, returned early, and never reached the alert again. The
 * customer had paid, nothing had been sent to them, and the one thing that
 * would have told anyone was the thing that failed.
 *
 * The workflow existing and the alert existing are separate facts. Checking
 * the first and inferring the second is what made the alert unrecoverable, so
 * this is now called on both paths and asserts its own fact.
 *
 * Never throws: an alert failure must not fail the webhook, or Stripe retries
 * and the payment booking runs again.
 */
async function ensurePaidAwaitingWelcomeAlert(supabase, tenantId, intake, session) {
  try {
    const { FGA_TENANT_ID } = require('../core/config');
    const { data: dupe } = await supabase
      .from('attention_queue').select('id')
      .eq('type', 'stripe_paid_awaiting_welcome')
      .eq('payload->>tenant_id', tenantId)
      .is('resolved_at', null)
      .maybeSingle();
    if (dupe) return { raised: false, reason: 'already_open' };

    const { error } = await supabase.from('attention_queue').insert({
      tenant_id: FGA_TENANT_ID,
      type: 'stripe_paid_awaiting_welcome',
      severity: 'red',
      title: `${intake.business_name || intake.email || 'A customer'} paid — send their welcome`,
      summary:
        'They have paid and their onboarding checklist is ready, but nothing has '
        + 'been sent to them yet. Open the Onboarding Center and send the welcome '
        + 'email — it carries the magic link they log in with.',
      entity_type: 'tenant',
      entity_id: tenantId,
      payload: {
        tenant_id: tenantId,
        email: intake.email || null,
        business_name: intake.business_name || null,
        session_id: session?.id || null,
      },
      produced_by: 'stripe-webhook',
    });
    if (error) throw error;
    return { raised: true };
  } catch (alertErr) {
    log.error(`Could not raise paid-awaiting-welcome alert: ${alertErr.message}`);
    return { raised: false, reason: alertErr.message };
  }
}

/**
 * Recompute the paid-customer alerts from what is actually true.
 *
 * WHY (2026-08-03)
 * ensurePaidAwaitingWelcomeAlert never throws — an alert failure must not fail
 * the webhook, or Stripe retries and re-books the payment. But the webhook
 * succeeding means Stripe does NOT retry, so a failed insert had no second
 * chance: the one moment that could have raised the alert had passed, and a
 * paid customer sat waiting with nothing telling anyone. The no-tenant
 * variant (paid at a Payment Link with no tenant metadata) failed the same
 * way.
 *
 * An alert is derived data. Derived data that can only be written at one
 * instant is data that can be lost; this recomputes it from the sources of
 * truth on a schedule (system-monitor, a few times a day):
 *
 *   1. A tenant whose active onboarding still has send_welcome_email pending,
 *      and whose config shows a Stripe identity → they paid and have not been
 *      welcomed. Ensure the alert.
 *   2. A paid Stripe checkout session from the last 14 days with no tenant_id
 *      in metadata → money with no account. Ensure the alert (open OR
 *      resolved counts as "exists" — resolved means Patrick already dealt
 *      with it, and re-raising would nag him about finished work).
 *
 * Never throws; returns a summary the monitor can log.
 */
async function reconcilePaidCustomerAlerts(supabase) {
  const out = { checked_tenants: 0, raised_tenant_alerts: 0, checked_sessions: 0, raised_no_tenant_alerts: 0, errors: [] };

  // --- 1. paid tenants still waiting for their welcome ---------------------
  try {
    const { data: pendingWelcomes } = await supabase
      .from('onboarding_steps')
      .select('tenant_id, workflow_id, status')
      .eq('step_name', 'send_welcome_email')
      .in('status', ['pending', 'failed', 'waiting']);

    for (const step of pendingWelcomes || []) {
      out.checked_tenants += 1;
      const { data: cfg } = await supabase
        .from('tenant_config').select('key, value')
        .eq('tenant_id', step.tenant_id)
        .in('key', ['setup_fee_paid_at', 'owner_email', 'business_name', 'is_complimentary']);
      const map = Object.fromEntries((cfg || []).map((c) => [c.key, c.value]));

      // PROOF OF PAYMENT comes from the workflow intake, and ONLY from there.
      //
      // The checkout webhook writes stripe_customer_id / stripe_session_id
      // into onboarding_workflows.intake_data, and it only fires on
      // checkout.session.completed — money in hand. That is evidence.
      //
      // tenant_config.stripe_customer_id is NOT: our own invoice step writes
      // it when it CREATES a customer in order to send them an invoice. At
      // that moment they have been asked to pay, not paid — counting it
      // raised a red "they paid — send their welcome" for a customer who
      // owed us money, which is the alert lying in the other direction.
      const { data: wf } = await supabase
        .from('onboarding_workflows')
        .select('intake_data')
        .eq('id', step.workflow_id)
        .maybeSingle();
      const intake = wf?.intake_data || {};

      // A staged friends-and-family tenant waiting for its welcome is normal,
      // not an emergency. PAYMENT evidence is one of:
      //   * the checkout webhook's intake ids (paid at a Payment Link), or
      //   * setup_fee_paid_at, written by invoice.paid when the Center's own
      //     setup invoice was paid.
      // A customer id alone is neither — we create those in order to ASK for
      // money, not because we received it.
      const paid = intake.stripe_customer_id || intake.stripe_session_id || map.setup_fee_paid_at;
      if (!paid) continue;
      if (map.is_complimentary === true || map.is_complimentary === 'true') continue;
      const stripeSession = intake.stripe_session_id || null;

      const r = await ensurePaidAwaitingWelcomeAlert(supabase, step.tenant_id, {
        email: map.owner_email || intake.email || null,
        business_name: map.business_name || intake.business_name || null,
      }, stripeSession ? { id: stripeSession } : null);
      if (r.raised) out.raised_tenant_alerts += 1;
    }
  } catch (err) {
    out.errors.push(`tenant sweep: ${err.message}`);
  }

  // --- 2. money with no account --------------------------------------------
  try {
    const { FGA_TENANT_ID } = require('../core/config');
    const since = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
    const sessions = await stripe.checkout.sessions.list({ limit: 100, created: { gte: since } });

    for (const s of sessions.data || []) {
      if (s.payment_status !== 'paid') continue;
      if (s.metadata?.tenant_id) continue;   // the tenant path covers these
      out.checked_sessions += 1;

      // Open OR resolved — resolved is Patrick having handled it.
      const { data: existing } = await supabase
        .from('attention_queue').select('id')
        .eq('type', 'stripe_payment_without_tenant')
        .eq('payload->>session_id', s.id)
        .limit(1);
      if (existing && existing.length) continue;

      const payerEmail = s.customer_email || s.customer_details?.email || null;
      const { error } = await supabase.from('attention_queue').insert({
        tenant_id: FGA_TENANT_ID,
        type: 'stripe_payment_without_tenant',
        severity: 'red',
        title: `${s.customer_details?.name || payerEmail || 'Someone'} paid and has no account`,
        summary:
          'A Stripe checkout completed with no tenant_id, so no account was created '
          + 'and no welcome email went out. They have paid and cannot log in. '
          + 'Onboard them manually with their email, then mark this done. '
          + '(Re-raised by the reconciler — the original alert was lost.)',
        entity_type: 'stripe_checkout_session',
        payload: {
          session_id: s.id,
          customer_id: s.customer,
          email: payerEmail,
          name: s.customer_details?.name || null,
          amount_usd: s.amount_total ? s.amount_total / 100 : null,
        },
        produced_by: 'stripe-reconciler',
      });
      if (!error) out.raised_no_tenant_alerts += 1;
      else out.errors.push(`session ${s.id}: ${error.message}`);
    }
  } catch (err) {
    out.errors.push(`session sweep: ${err.message}`);
  }

  return out;
}

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

      // A paid SETUP invoice is payment evidence for onboarding, not just a
      // finance entry. The reconciler correctly stopped treating a customer
      // id alone as proof of payment — which reopened this gap: a manually
      // staged client who pays the Center-generated invoice had no path back
      // into the paid-awaiting-welcome alert at all. Record the payment on
      // the tenant (the reconciler reads it) and raise the alert now if their
      // welcome is still pending.
      if (invoice.metadata?.fga_purpose === 'setup_fee') {
        try {
          const supabase = getServiceClient();
          const { data: cfgRow } = await supabase
            .from('tenant_config').select('tenant_id')
            .eq('key', 'stripe_customer_id')
            .eq('value', JSON.stringify(invoice.customer))
            .maybeSingle();
          // tenant_config.value is JSONB; strings may be stored either way.
          const { data: cfgRow2 } = cfgRow ? { data: null } : await supabase
            .from('tenant_config').select('tenant_id')
            .eq('key', 'stripe_customer_id')
            .eq('value', invoice.customer)
            .maybeSingle();
          const tenantId = cfgRow?.tenant_id || cfgRow2?.tenant_id || null;

          if (tenantId) {
            await supabase.from('tenant_config').upsert(
              { tenant_id: tenantId, key: 'setup_fee_paid_at', value: new Date().toISOString() },
              { onConflict: 'tenant_id,key' },
            );
            const { data: pendingWelcome } = await supabase
              .from('onboarding_steps').select('id')
              .eq('tenant_id', tenantId)
              .eq('step_name', 'send_welcome_email')
              .in('status', ['pending', 'failed', 'waiting'])
              .limit(1);
            if (pendingWelcome && pendingWelcome.length) {
              const { data: cfg } = await supabase
                .from('tenant_config').select('key, value')
                .eq('tenant_id', tenantId).in('key', ['owner_email', 'business_name']);
              const map = Object.fromEntries((cfg || []).map((c) => [c.key, c.value]));
              await ensurePaidAwaitingWelcomeAlert(supabase, tenantId, {
                email: map.owner_email || null,
                business_name: map.business_name || null,
              }, null);
            }
          }
        } catch (alertErr) {
          // Same contract as every alert here: never fail the webhook over it.
          log.error(`Could not link paid setup invoice to onboarding: ${alertErr.message}`);
        }
      }

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

      // Book the money FIRST. This handler previously did onboarding and
      // coupon work but never touched the ledger, so a setup fee paid through
      // a Payment Link produced a customer, an onboarding, and no revenue.
      // Subscription checkouts are skipped inside (invoice.paid books those).
      // A booking failure here must reach the inbox classifier, not be logged
      // and discarded — a swallowed error means Stripe never retries and the
      // revenue is lost silently, which is the whole class of bug being fixed.
      let checkoutBooking = null;
      try {
        checkoutBooking = await financeSync.recordStripeCheckoutPayment(getServiceClient(), session);
        if (checkoutBooking.status === 'recorded') {
          log.success(`Checkout revenue booked: $${checkoutBooking.amount}`);
        }
      } catch (err) {
        log.error(`Checkout revenue booking failed for ${session.id}: ${err.message}`);
        checkoutBooking = { status: 'error', error: err.message };
      }

      // Drip-campaign coupon redemption tracking — if this checkout used a
      // prospect's first-month-free promotion code, mark it redeemed and
      // surface a blue attention item. Non-fatal by design.
      try {
        const { trackCouponRedemption } = require('../core/drip-coupon');
        await trackCouponRedemption(getServiceClient(), session);
      } catch (couponErr) {
        log.warn(`Drip coupon redemption tracking failed: ${couponErr.message}`);
      }

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
        // SOMEBODY JUST PAID AND WE HAVE NOWHERE TO PUT THEM.
        //
        // The public Payment Links on /pricing carry no tenant_id — nothing
        // creates a tenant before checkout — so this is the branch a real
        // walk-up customer lands in. It used to be a single log.info: the
        // money booked, and the customer got no tenant, no welcome email, no
        // magic link, and no onboarding, while nothing anywhere said so.
        //
        // Raise it where Patrick will see it. He then onboards them by hand
        // with the runbook, which takes minutes — as long as he knows.
        const payerEmail = session.customer_email || session.customer_details?.email || null;
        const payerName = session.customer_details?.name || null;
        const amount = session.amount_total ? session.amount_total / 100 : null;
        log.error(
          `PAID BUT UNCLAIMED: checkout ${session.id} has no tenant_id — `
          + `${payerEmail || 'unknown email'} paid ${amount ?? '?'} and has no account`,
        );
        try {
          const { getServiceClient } = require('../db/client');
          const { FGA_TENANT_ID } = require('../core/config');
          const db = getServiceClient();
          // Idempotent: Stripe replays webhooks.
          const { data: dupe } = await db
            .from('attention_queue').select('id')
            .eq('type', 'stripe_payment_without_tenant')
            .eq('payload->>session_id', session.id)
            .is('resolved_at', null)
            .maybeSingle();
          if (!dupe) {
            await db.from('attention_queue').insert({
              tenant_id: FGA_TENANT_ID,
              type: 'stripe_payment_without_tenant',
              severity: 'red',
              title: `${payerName || payerEmail || 'Someone'} paid and has no account`,
              summary:
                `A Stripe checkout completed with no tenant_id, so no account was `
                + `created and no welcome email went out. They have paid and cannot `
                + `log in. Onboard them manually with their email, then mark this done.`,
              entity_type: 'stripe_checkout_session',
              payload: {
                session_id: session.id,
                customer_id: session.customer,
                email: payerEmail,
                name: payerName,
                amount_usd: amount,
              },
              produced_by: 'stripe-webhook',
            });
          }
        } catch (alertErr) {
          // Never let the alert break the webhook — Stripe would retry and
          // the payment booking above would run again.
          log.error(`Could not raise unclaimed-payment alert: ${alertErr.message}`);
        }
        return {
          booking: checkoutBooking,
          action: 'checkout_completed',
          sessionId: session.id,
          customerId: session.customer,
          onboarding_started: false,
          reason: 'no_tenant_id_in_metadata',
        };
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
          // ...but STILL make sure the alert exists.
          //
          // This early return used to skip it. If the first delivery created
          // the workflow and then failed to raise the alert, every retry took
          // this branch and the alert was never recreated — a paid customer
          // sitting in the Center with nothing telling Patrick they were
          // there. A retry is the natural moment to repair that, and the only
          // one we get.
          await ensurePaidAwaitingWelcomeAlert(supabase, tenantId, {
            email: session.customer_email || session.customer_details?.email || null,
            business_name: session.metadata?.business_name || null,
          }, session);
          return {
            booking: checkoutBooking,
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

        // Default-off canonical closed-won handoff. This path requires exact
        // source/client tenant cohorts plus explicit immutable source IDs in
        // Stripe metadata. It never guesses identity from email/name and never
        // blocks the deployed onboarding behavior while supervised.
        let closed_won_handoff = null;
        try {
          const {
            projectStripeClosedWonOnboarding,
          } = require('../core/operations/stripe-closed-won-onboarding');
          const projection = await projectStripeClosedWonOnboarding({
            client: supabase,
            session,
            workflow,
          });
          if (projection.mode === 'canonical') {
            closed_won_handoff = {
              handoff_id: projection.handoff_id,
              state: projection.state,
            };
          }
        } catch (handoffErr) {
          log.warn(
            `Canonical closed-won onboarding handoff failed closed: ${
              handoffErr.code || 'projection_error'
            }`
          );
          try {
            await supabase.from('attention_queue').insert({
              tenant_id: tenantId,
              type: 'closed_won_onboarding_handoff_failed',
              severity: 'amber',
              title: 'Closed-won onboarding handoff needs reconciliation',
              summary: 'The deployed onboarding workflow continued, but its canonical handoff was not acknowledged.',
              entity_type: 'onboarding_workflow',
              entity_id: workflow.id,
              payload: {},
              produced_by: 'stripe-webhook',
            });
          } catch (_) {
            // Preserve the existing Stripe onboarding path if the supervised
            // control-plane table is unavailable.
          }
        }

        // DO NOT send the welcome email here.
        //
        // This used to call sendWelcomeWizard, which emails the customer and
        // optionally texts them — with nobody clicking anything. That single
        // call made the whole "nothing reaches a customer without a click"
        // claim false, and it was the last automatic customer-facing send in
        // the system.
        //
        // A Stripe checkout now does exactly what the admin flow does: create
        // the tenant, seed the checklist, and put it in front of Patrick. He
        // sends the welcome from the Onboarding Center, where he can read it
        // first. Raised RED because the customer has paid and is waiting.
        const welcome_sent = false;
        await ensurePaidAwaitingWelcomeAlert(supabase, tenantId, intake, session);

        return {
          booking: checkoutBooking,
          action: 'checkout_completed',
          sessionId: session.id,
          tenantId,
          onboarding_started: true,
          workflow_id: workflow.id,
          welcome_sent,
          closed_won_handoff,
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

    case 'charge.refunded': {
      const charge = event.data.object;
      const r = await financeSync.recordStripeRefund(getServiceClient(), charge);
      return { action: 'refund_recorded', chargeId: charge.id, ...r };
    }

    case 'charge.dispute.created':
    case 'charge.dispute.updated': {
      const dispute = event.data.object;
      const r = await financeSync.recordStripeDispute(getServiceClient(), dispute);
      return { action: 'dispute_escalated', disputeId: dispute.id, ...r };
    }

    default:
      log.info(`Unhandled webhook event type: ${event.type}`);
      return { action: 'ignored', type: event.type };
  }
}

/**
 * Email the customer a Stripe-hosted invoice for the SETUP FEE.
 *
 * The setup fee alone, never setup + first month. FGA sells a 14-day trial:
 * the $199 is charged at signup and the recurring fee does not bill until day
 * 15 (CLAUDE.md). Putting the monthly on this invoice would collect it two
 * weeks before the trial it was promised inside of ends.
 *
 * The price is resolved live from the Setup product and cross-checked against
 * published pricing — see core/stripe-pricing.js for why price ids are not
 * configuration here.
 *
 * `custom` lets a deal be priced off-catalogue (923A is a custom build) by
 * passing an amount in dollars and a description.
 *
 * @returns {Promise<{invoice_id, hosted_url, amount_usd, status}>}
 */
async function sendSetupFeeInvoice({ customerId, custom = null, daysUntilDue = 7 }) {
  if (!customerId) throw new Error('customerId is required');

  let amountCents;
  let description;
  if (custom) {
    amountCents = Math.round(Number(custom.amount_usd) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      throw new Error('A custom invoice needs a positive amount_usd');
    }
    // A custom price is for a genuinely custom deal, not a typo. Anything an
    // order of magnitude off the published setup fee is far more likely to be
    // a slipped decimal than a real arrangement, and it would go out as a real
    // invoice to a real customer.
    const standard = FGA_KNOWLEDGE.pricing.setup_fee.amount * 100;
    if (amountCents > standard * 10) {
      throw new Error(
        `A custom setup fee of $${(amountCents / 100).toFixed(2)} is more than 10x the `
        + `standard $${standard / 100}. If that is deliberate, invoice it from Stripe directly.`,
      );
    }
    description = custom.description || 'First Gen Automate — setup';
  } else {
    const { resolvePrice } = require('../core/stripe-pricing');
    const price = await resolvePrice('setup');
    amountCents = price.unit_amount;
    description = price.productName;
  }

  // IDEMPOTENCY KEYS — the crash-between-send-and-write window.
  //
  // The invoice reaches the customer before its id is written to
  // tenant_config. If the process dies in between, or the database write
  // fails, the local guard stays empty and a retry creates a SECOND invoice
  // for the same $199.
  //
  // A deterministic key makes Stripe return the ORIGINAL object instead of
  // creating another. Stripe expires these after 24 hours, which is precisely
  // the window a crash-and-retry lives in; beyond that, core/stripe-reconcile
  // catches it by asking Stripe what the customer already has. The two cover
  // different timescales on purpose.
  const idem = (suffix) => ({ idempotencyKey: `fga-setup-v1-${customerId}-${suffix}` });

  // Create the invoice FIRST, then attach the line to it by id.
  //
  // Creating the item first and hoping the invoice picks it up does not work:
  // current API versions do not pull pending invoice items in by default, so
  // the invoice comes out EMPTY. A $0 invoice then auto-pays itself and the
  // customer receives a receipt for nothing. Verified against live test mode —
  // this exact bug produced a paid $0 invoice.
  const invoice = await stripe.invoices.create({
    customer: customerId,
    collection_method: 'send_invoice',
    days_until_due: daysUntilDue,
    auto_advance: false,
    description: 'Setup fee. Your monthly plan starts after the 14-day trial.',
    // MARK IT AS OURS, AND AS THE SETUP FEE.
    //
    // The line below is created with a raw `amount`, not a price id, so the
    // invoice carries NO reference to the Setup product. core/stripe-reconcile
    // recognises an already-billed setup fee by looking for that product — and
    // therefore could not see the invoices we create ourselves. It saw payment
    // link purchases and missed our own.
    //
    // That was hidden by the idempotency key, which replays the original
    // invoice for 24 hours and made a live test pass for the wrong reason.
    // After 24 hours the key expires and nothing would have stopped a second
    // $199. This metadata is what reconciliation matches on, and unlike the
    // product reference it works for custom-priced invoices too.
    metadata: { fga_purpose: 'setup_fee' },
  }, idem('invoice'));

  await stripe.invoiceItems.create({
    customer: customerId,
    invoice: invoice.id,          // explicit — do not rely on pickup
    amount: amountCents,
    currency: 'usd',
    description,
  }, idem('item'));

  // Keyed too, and not just for tidiness: with the create above replaying the
  // ORIGINAL invoice id on a retry, an unkeyed finalize would come back
  // "invoice already finalized" and turn a successful retry into an error.
  // NOTE THE EMPTY {}. Stripe's SDK signature for a method that takes an id is
  // (id, params, options). Passing the options object second makes it PARAMS,
  // and Stripe rejects the whole call with "Received unknown parameter:
  // idempotencyKey". Methods without an id — invoices.create, subscriptions.
  // create — are (params, options) and take it in the second position.
  const finalised = await stripe.invoices.finalizeInvoice(invoice.id, {}, idem('finalize'));

  // Trust Stripe's number, not ours. The amount we intended and the amount on
  // the invoice are different facts, and only one of them reaches the
  // customer.
  if (finalised.amount_due !== amountCents) {
    throw new Error(
      `Invoice ${finalised.id} totals $${(finalised.amount_due / 100).toFixed(2)} `
      + `but should be $${(amountCents / 100).toFixed(2)} — not sending it.`,
    );
  }

  const sent = await stripe.invoices.sendInvoice(finalised.id, {}, idem('send'));

  log.success(`Setup invoice ${sent.id} sent — $${(sent.amount_due / 100).toFixed(2)}`);
  return {
    invoice_id: sent.id,
    hosted_url: sent.hosted_invoice_url,
    amount_usd: sent.amount_due / 100,
    status: sent.status,
  };
}

/**
 * Start the subscription with the 14-day trial, so the first monthly charge
 * lands on day 15 rather than today.
 *
 * Separate from the setup invoice on purpose: the setup fee is due now, the
 * monthly is not.
 */
async function startTrialSubscription({
  customerId, tier = 'growth', trialDays = STANDARD_TRIAL_DAYS, allowNonStandardTrial = false,
}) {
  if (!customerId) throw new Error('customerId is required');

  // The trial we sell is FOURTEEN DAYS (CLAUDE.md) — not "somewhere between 1
  // and 90". The old range check let any of 90 different trials through
  // silently, so a caller passing the wrong number produced a subscription
  // that charged on the wrong day and looked entirely healthy doing it.
  //
  // A genuinely custom deal still needs a way through, so it has one — but it
  // has to be asked for by name, which means it appears in the diff.
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 90) {
    throw new Error(`trialDays must be between 1 and 90 — got ${trialDays}`);
  }
  if (trialDays !== STANDARD_TRIAL_DAYS && !allowNonStandardTrial) {
    throw new Error(
      `We sell a ${STANDARD_TRIAL_DAYS}-day trial — got ${trialDays}. `
      + 'If this deal really is different, pass allowNonStandardTrial: true.',
    );
  }
  const { resolvePrice } = require('../core/stripe-pricing');
  const price = await resolvePrice(tier === 'scale' ? 'scale' : 'growth');

  // A trialing subscription still needs a card on file for the day-15 charge.
  // In the manual flow the customer gets one when they pay the setup invoice,
  // so this step comes after that — and if it does not, say so in those words
  // rather than surfacing Stripe's raw "no attached payment source".
  const customer = await stripe.customers.retrieve(customerId);
  const methods = await stripe.paymentMethods.list({ customer: customerId, limit: 1 });
  const hasCard = Boolean(customer.invoice_settings?.default_payment_method
    || customer.default_source
    || (methods.data || []).length);

  if (!hasCard) {
    throw new Error(
      'No card on file for this customer yet. They get one when they pay the '
      + 'setup invoice — send that first, and start the subscription once it '
      + 'is paid. (Stripe cannot hold a trial with nothing to charge on day 15.)',
    );
  }

  // Keyed for the same reason as the invoice, with a worse failure to prevent:
  // a duplicate subscription bills the customer every month rather than once.
  // core/stripe-reconcile.js is the primary guard (it sees subscriptions
  // Stripe created from a payment link, which this key cannot); this covers
  // the narrow case of our own call succeeding and our own write failing.
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: price.id }],
    trial_period_days: trialDays,
    metadata: { tier, fga_trial_days: String(trialDays) },
  }, { idempotencyKey: `fga-sub-v1-${customerId}-${tier}` });

  const firstCharge = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString().slice(0, 10) : 'unknown';
  log.success(
    `Subscription ${sub.id} created — ${tier} $${(price.unit_amount / 100).toFixed(2)}/mo, `
    + `first charge ${firstCharge}`,
  );
  return {
    subscription_id: sub.id,
    tier,
    monthly_usd: price.unit_amount / 100,
    trial_days: trialDays,
    first_charge_date: firstCharge,
    status: sub.status,
  };
}

module.exports = {
  sendSetupFeeInvoice,
  startTrialSubscription,
  reconcilePaidCustomerAlerts,
  createCustomer,
  createSetupFeeCharge,
  createSubscription,
  cancelSubscription,
  getCustomerPortalUrl,
  getRevenueSummary,
  handleWebhook,
};
