/**
 * Finance Sync — bridges Stripe (and future Mercury) events to finance_entries.
 *
 * Authored: 2026-05-23 — Phase 1 Step 3 of the BI & Financial Sync plan
 * (see ~/Desktop/FGA/dashboards/bi-sync-strategy.html §5 deliverable 2).
 *
 * Why this module exists separately from integrations/stripe.js:
 *   - Keeps Stripe-specific code in integrations/stripe.js
 *   - Keeps Mercury-specific code (Phase 4) in integrations/mercury.js
 *   - Both write into the same ledger via the helpers here, which:
 *     1. Resolve the right tenant from a Stripe customer id (or Mercury account)
 *     2. Set the Postgres session GUC vars so the audit trigger captures
 *        "stripe-webhook" or "mercury-feed" as the actor
 *     3. Honor period locks (no ingesting into a locked month)
 *     4. Handle idempotency (refuse duplicates by stripe_invoice_id)
 *     5. Drop unmatched events into the attention_queue for manual triage
 *
 * The session GUC vars (app.actor_id, app.actor_label) are read by the
 * finance_entries_audit_trigger in migration 023 — they're what make the
 * audit log show "who wrote this entry" rather than just "service role".
 */

const { createLogger } = require('../core/logger');
const { FGA_TENANT_ID } = require('../core/config');
const log = createLogger('finance-sync');

// ──────────────────────────────────────────────────────────────────────────
// 1. Tenant resolution from Stripe identifiers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Look up the tenant that owns a given Stripe customer id.
 * tenant_config stores this as a row with key='stripe_customer_id'.
 *
 * @returns {Promise<string|null>} tenant_id UUID or null if no match
 */
/**
 * Persist billing-state flags onto a tenant so the MRR ledger recognizes the
 * subscription independent of delivery/go-live status. Values are stored as
 * strings to match the `=== 'true'` readers across the codebase.
 * Non-fatal: a config write failure must never brick a webhook ack.
 */
async function writeTenantBillingState(supabase, tenantId, kv) {
  if (!tenantId) return;
  const rows = Object.entries(kv)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ tenant_id: tenantId, key, value: String(value) }));
  if (!rows.length) return;
  const { error } = await supabase
    .from('tenant_config')
    .upsert(rows, { onConflict: 'tenant_id,key' });
  if (error) log.warn(`writeTenantBillingState(${tenantId}) failed: ${error.message}`);
}

async function findTenantByStripeCustomer(supabase, stripeCustomerId) {
  if (!stripeCustomerId) return null;
  const { data, error } = await supabase
    .from('tenant_config')
    .select('tenant_id')
    .eq('key', 'stripe_customer_id')
    .eq('value', stripeCustomerId)
    .maybeSingle();
  if (error) {
    log.warn(`Tenant lookup failed for ${stripeCustomerId}: ${error.message}`);
    return null;
  }
  return data?.tenant_id || null;
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Audit context for triggers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Set the session GUC variables that finance_entries_audit_trigger reads.
 * Returns a function that resets them — call it after the write to avoid
 * leaking the actor identity onto unrelated queries.
 *
 * @param {string} actorLabel — e.g. 'stripe-webhook' | 'mercury-feed' | 'bookkeeping-agent'
 * @param {string} [actorId]   — optional UUID (Stripe webhooks have no auth user)
 */
async function setAuditContext(supabase, actorLabel, actorId = null) {
  // V1 hardening (2026-05-24): switched from raw-SQL exec_sql() with string
  // interpolation to a parameterized SECURITY DEFINER RPC (migration 035).
  // The old pattern interpolated actorLabel + actorId straight into a SQL
  // string before passing it to the privileged exec_sql function — a latent
  // injection vector for any caller of this helper that doesn't fully
  // control the actorLabel input.
  const { error } = await supabase.rpc('set_audit_context', {
    p_actor_id: actorId,
    p_actor_label: actorLabel || null,
  });
  if (error) log.warn(`setAuditContext: ${error.message}`);
  return async function resetAuditContext() {
    await supabase.rpc('set_audit_context', { p_actor_id: null, p_actor_label: null });
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Period lock check
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns true if writes to (tenant_id, year, month) are blocked because
 * the period is closed. Stripe webhook ingestion respects this so a late
 * invoice.paid event can't reopen a CPA-signed period.
 */
async function isPeriodLocked(supabase, tenantId, dateStr) {
  const d = new Date(dateStr);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const { data, error } = await supabase.rpc('is_period_locked', {
    p_tenant_id: tenantId,
    p_year: year,
    p_month: month,
  });
  if (error) {
    log.warn(`is_period_locked failed: ${error.message}`);
    return false;  // fail-open — better to let the write through and audit-log it
  }
  return Boolean(data);
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Stripe → finance_entries income ingestion
// ──────────────────────────────────────────────────────────────────────────

/**
 * Idempotently record a Stripe invoice.paid event as a finance_entries
 * income row. Returns:
 *   { status: 'created', entry_id }            — new row written
 *   { status: 'duplicate', entry_id }          — already exists for this invoice
 *   { status: 'orphaned' }                     — no tenant matches this customer; queued for manual triage
 *   { status: 'period_locked' }                — period is closed; queued for manual triage
 *   { status: 'error', error }
 */
async function recordStripeInvoicePaid(supabase, invoice) {
  if (!invoice || !invoice.id || !invoice.customer || !invoice.amount_paid) {
    return { status: 'error', error: 'invalid invoice payload' };
  }

  // 1. Idempotency check by stripe_invoice_id
  const { data: existing } = await supabase
    .from('finance_entries')
    .select('id')
    .filter('metadata->>stripe_invoice_id', 'eq', invoice.id)
    .maybeSingle();
  if (existing) {
    log.info(`invoice ${invoice.id} already recorded as finance_entries.${existing.id}`);
    return { status: 'duplicate', entry_id: existing.id };
  }

  // 2. Resolve tenant
  const tenantId = await findTenantByStripeCustomer(supabase, invoice.customer);
  if (!tenantId) {
    log.warn(`No tenant linked to Stripe customer ${invoice.customer} — queueing for triage`);
    await supabase.from('attention_queue').insert({
      tenant_id: process.env.FGA_TENANT_ID,  // route to FGA platform-owner queue
      type: 'reconciliation_stripe_orphan',
      severity: 'amber',
      title: `Orphan Stripe payment — $${(invoice.amount_paid / 100).toFixed(2)}`,
      summary: `Stripe invoice ${invoice.id} from customer ${invoice.customer} has no matching tenant_config row. Either the customer hasn't been linked yet, or the invoice is for a non-tenant payment.`,
      entity_type: 'stripe_invoice',
      payload: {
        stripe_invoice_id: invoice.id,
        stripe_customer_id: invoice.customer,
        amount: invoice.amount_paid / 100,
        currency: invoice.currency,
        paid_at: new Date(invoice.status_transitions?.paid_at * 1000 || Date.now()).toISOString(),
      },
      produced_by: 'stripe-webhook',
    });
    return { status: 'orphaned' };
  }

  // 3. Period lock check
  const paidAtIso = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
    : new Date().toISOString();
  if (await isPeriodLocked(supabase, tenantId, paidAtIso)) {
    log.warn(`Period locked for tenant ${tenantId} on ${paidAtIso} — queueing invoice ${invoice.id}`);
    await supabase.from('attention_queue').insert({
      tenant_id: tenantId,
      type: 'reconciliation_period_locked',
      severity: 'red',
      title: `Stripe payment to locked period — $${(invoice.amount_paid / 100).toFixed(2)}`,
      summary: `Stripe invoice ${invoice.id} paid in a month that's already closed. Decide whether to reopen the month or book to the current period.`,
      entity_type: 'stripe_invoice',
      payload: { stripe_invoice_id: invoice.id, paid_at: paidAtIso, amount: invoice.amount_paid / 100 },
      produced_by: 'stripe-webhook',
    });
    return { status: 'period_locked' };
  }

  // 4. Set audit context + insert
  const reset = await setAuditContext(supabase, 'stripe-webhook');
  try {
    // Try to extract subscription tier from invoice metadata or line items
    const tier =
      invoice.subscription_details?.metadata?.tier ||
      invoice.lines?.data?.[0]?.metadata?.tier ||
      null;
    const isSetupFee =
      invoice.lines?.data?.[0]?.description?.toLowerCase().includes('setup') ||
      invoice.metadata?.is_setup_fee === 'true';

    const category = isSetupFee ? 'setup_fee' : 'subscription';

    /*
     * BOOK TO FGA'S LEDGER, ATTRIBUTE TO THE CLIENT.
     *
     * This previously inserted with `tenant_id: tenantId` — the CLIENT's
     * tenant. That is a customer-identity field being used as a book-of-record
     * field, and the two are not the same thing: when 923A pays First Gen
     * Automate, the revenue belongs on FGA's books with 923A named as the
     * customer. Booking it into 923A's ledger both overstates the client's
     * income and hides FGA's, because Reports & Insights reads only
     * FGA_TENANT_ID (api/routes/admin.js). Every webhook-booked dollar was
     * therefore invisible in the P&L by construction.
     *
     * Book of record = FGA. Customer attribution = the client tenant, carried
     * in the description and metadata so per-client revenue stays reportable.
     */
    const bookTenantId = FGA_TENANT_ID;
    const { data: clientRow } = await supabase
      .from('tenants').select('name').eq('id', tenantId).limit(1);
    const clientName = clientRow?.[0]?.name || 'unknown client';
    const description = isSetupFee
      ? `Stripe setup fee — ${clientName}`
      : tier
      ? `Stripe subscription — ${clientName} (${tier})`
      : `Stripe subscription — ${clientName}`;

    const { data: inserted, error: insErr } = await supabase
      .from('finance_entries')
      .insert({
        tenant_id: bookTenantId,
        entry_type: 'income',
        category,
        amount: invoice.amount_paid / 100,
        description,
        date: paidAtIso.slice(0, 10),
        recurring: !isSetupFee,
        metadata: {
          stripe_invoice_id: invoice.id,
          stripe_customer_id: invoice.customer,
          stripe_subscription_id: invoice.subscription || null,
          stripe_charge_id: invoice.charge || null,
          tier: tier || null,
          source: 'stripe-webhook',
          // Customer attribution — the client this revenue came FROM, kept
          // distinct from tenant_id (the book of record, always FGA). This is
          // what per-client revenue reporting reads.
          customer_tenant_id: tenantId,
          customer_name: clientName,
          basis: 'gross',
        },
      })
      .select()
      .single();

    if (insErr) {
      log.error(`finance_entries insert failed for invoice ${invoice.id}: ${insErr.message}`);
      return { status: 'error', error: insErr.message };
    }

    log.success(`Recorded invoice ${invoice.id} → finance_entries.${inserted.id} ($${(invoice.amount_paid / 100).toFixed(2)})`);

    // A paid RECURRING invoice means the subscription is billing — flag the
    // tenant so MRR recognizes it regardless of go-live/onboarding status. A
    // setup-fee invoice does not imply a live subscription, so skip it there.
    if (!isSetupFee) {
      await writeTenantBillingState(supabase, tenantId, {
        billing_active: 'true',
        subscription_status: 'active',
      });
      // first_charged_at is set once, on the first recurring charge, and never
      // overwritten (so it stays the conversion date, not the latest invoice).
      const { data: fcExisting } = await supabase
        .from('tenant_config')
        .select('value')
        .eq('tenant_id', tenantId)
        .eq('key', 'first_charged_at')
        .maybeSingle();
      if (!fcExisting) {
        await writeTenantBillingState(supabase, tenantId, { first_charged_at: paidAtIso });
      }
    }

    // Gross model: book Stripe's processing fee as a deductible expense so the
    // ledger shows gross revenue + a Payment Processing line that nets to the
    // amount actually paid out. The fee lives on the charge's balance
    // transaction, not the invoice, so retrieve it. Non-fatal + idempotent.
    if (invoice.charge) {
      try {
        const stripeClient = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const charge = await stripeClient.charges.retrieve(invoice.charge, {
          expand: ['balance_transaction'],
        });
        const feeCents = charge?.balance_transaction?.fee || 0;
        if (feeCents > 0) {
          const { data: feeExisting } = await supabase
            .from('finance_entries')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('entry_type', 'expense')
            .filter('metadata->>stripe_fee_for_charge', 'eq', invoice.charge)
            .maybeSingle();
          if (!feeExisting) {
            await supabase.from('finance_entries').insert({
              tenant_id: tenantId,
              entry_type: 'expense',
              amount: feeCents / 100,
              date: paidAtIso.slice(0, 10),
              category: 'Payment Processing',
              recurring: false,
              description: `Stripe processing fee — ${description}`,
              metadata: {
                source: 'stripe-webhook',
                kind: 'stripe_fee',
                stripe_fee_for_charge: invoice.charge,
                stripe_invoice_id: invoice.id,
                gross: invoice.amount_paid / 100,
              },
            });
          }
        }
      } catch (feeErr) {
        log.warn(`Stripe fee expense booking failed for invoice ${invoice.id}: ${feeErr.message}`);
      }
    }
    return { status: 'created', entry_id: inserted.id };
  } finally {
    await reset();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Stripe → attention_queue producers for non-income events
// ──────────────────────────────────────────────────────────────────────────

/**
 * Stripe invoice.payment_failed → attention_queue (red severity).
 * The Action Ribbon surfaces these immediately so Patrick can intervene.
 */
async function recordStripePaymentFailed(supabase, invoice) {
  const tenantId =
    (await findTenantByStripeCustomer(supabase, invoice.customer)) ||
    process.env.FGA_TENANT_ID;
  return supabase.from('attention_queue').insert({
    tenant_id: tenantId,
    type: 'payment_failed',
    severity: 'red',
    title: `Payment failed — $${(invoice.amount_due / 100).toFixed(2)}`,
    summary: `Stripe couldn't charge ${invoice.customer_email || invoice.customer} for invoice ${invoice.id}. Dunning sequence will retry; manual intervention may be needed if all retries fail.`,
    entity_type: 'stripe_invoice',
    entity_id: null,
    payload: {
      stripe_invoice_id: invoice.id,
      stripe_customer_id: invoice.customer,
      amount: invoice.amount_due / 100,
      attempt: invoice.attempt_count || 1,
      next_payment_attempt: invoice.next_payment_attempt
        ? new Date(invoice.next_payment_attempt * 1000).toISOString()
        : null,
    },
    quick_actions: [
      { label: 'Open in Stripe', verb: 'GET', url: `https://dashboard.stripe.com/invoices/${invoice.id}` },
    ],
    produced_by: 'stripe-webhook',
  });
}

/**
 * Stripe customer.subscription.deleted → attention_queue (amber).
 * Marks the tenant as candidate-for-churn; final disposition is manual.
 */
async function recordStripeSubscriptionDeleted(supabase, subscription) {
  const matchedTenantId = await findTenantByStripeCustomer(supabase, subscription.customer);
  const tenantId = matchedTenantId || process.env.FGA_TENANT_ID;
  // Subscription ended at Stripe → stop counting it toward MRR. Final churn
  // disposition (tenants.status='churned') stays manual via the quick action.
  // Only touch a real matched tenant, never the FGA fallback.
  if (matchedTenantId) {
    await writeTenantBillingState(supabase, matchedTenantId, {
      subscription_status: 'canceled',
      billing_active: 'false',
    });
  }
  return supabase.from('attention_queue').insert({
    tenant_id: tenantId,
    type: 'subscription_deleted',
    severity: 'amber',
    title: 'Subscription canceled',
    summary: `Subscription ${subscription.id} canceled at Stripe. Tenant will need to be transitioned to churned status; data export window starts now.`,
    entity_type: 'stripe_subscription',
    payload: {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer,
      canceled_at: subscription.canceled_at
        ? new Date(subscription.canceled_at * 1000).toISOString()
        : new Date().toISOString(),
      cancellation_reason: subscription.cancellation_details?.reason || null,
    },
    quick_actions: [
      { label: 'Mark churned', verb: 'PATCH', path: `/api/admin/clients/${tenantId}/status`, body: { status: 'churned' } },
    ],
    produced_by: 'stripe-webhook',
  });
}

/**
 * Stripe customer.subscription.updated → attention_queue (blue) on tier change.
 */
async function recordStripeSubscriptionUpdated(supabase, subscription) {
  const tenantId =
    (await findTenantByStripeCustomer(supabase, subscription.customer)) ||
    process.env.FGA_TENANT_ID;

  // Detect tier change by comparing metadata
  const newTier = subscription.metadata?.tier || null;
  const status = subscription.status;

  // Keep the tenant's billing axis in sync with Stripe's subscription status
  // so MRR reflects reality (active/past_due bill; canceled/unpaid don't).
  // Only write when we matched a real tenant — never onto the FGA fallback.
  if (await findTenantByStripeCustomer(supabase, subscription.customer)) {
    await writeTenantBillingState(supabase, tenantId, {
      subscription_status: status,
      billing_active: status === 'active' || status === 'past_due' ? 'true' : 'false',
    });
  }

  return supabase.from('attention_queue').insert({
    tenant_id: tenantId,
    type: 'subscription_updated',
    severity: 'blue',
    title: `Subscription updated (status: ${status})`,
    summary: `Stripe subscription ${subscription.id} changed — status: ${status}${newTier ? `, tier: ${newTier}` : ''}. Verify tenant_config.monthly_rate matches.`,
    entity_type: 'stripe_subscription',
    payload: {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer,
      status,
      tier: newTier,
    },
    produced_by: 'stripe-webhook',
  });
}


/**
 * A one-time payment completed through Stripe Checkout.
 *
 * Codex audit 2026-07-26: checkout.session.completed ran onboarding and coupon
 * tracking but never touched finance_entries — only invoice.paid booked money.
 * A setup fee paid through a Payment Link or Checkout therefore produced a new
 * customer, a started onboarding, and NO revenue on the books.
 *
 * Subscription checkouts are skipped here on purpose: Stripe also emits
 * invoice.paid for those, and booking both would double-count. The unique
 * index on stripe_invoice_id backstops it, but not double-writing is cleaner.
 */
async function recordStripeCheckoutPayment(supabase, session) {
  if (session.mode === 'subscription') {
    return { status: 'skipped', reason: 'subscription checkout books via invoice.paid' };
  }
  const amount = (session.amount_total || 0) / 100;
  if (amount <= 0) return { status: 'skipped', reason: 'zero amount' };

  const tenantId = session.customer
    ? await findTenantByStripeCustomer(supabase, session.customer)
    : null;
  const { data: clientRow } = tenantId
    ? await supabase.from('tenants').select('name').eq('id', tenantId).limit(1)
    : { data: null };
  const clientName = clientRow?.[0]?.name
    || session.customer_details?.name
    || session.customer_details?.email
    || 'unknown customer';

  // Idempotency: the checkout session id is the natural key here (there is no
  // invoice for a one-off payment).
  const { data: dup } = await supabase.from('finance_entries')
    .select('id').eq('tenant_id', FGA_TENANT_ID)
    .filter('metadata->>stripe_checkout_session_id', 'eq', session.id).limit(1);
  if (dup && dup.length) return { status: 'duplicate', entryId: dup[0].id };

  const reset = await setAuditContext(supabase, 'stripe-webhook');
  try {
    const { data: inserted, error } = await supabase.from('finance_entries').insert({
      tenant_id: FGA_TENANT_ID,          // book of record is always FGA
      entry_type: 'income',
      category: 'setup_fee',
      amount,
      description: `Stripe checkout payment — ${clientName}`,
      date: new Date((session.created || Date.now() / 1000) * 1000).toISOString().slice(0, 10),
      recurring: false,
      metadata: {
        stripe_checkout_session_id: session.id,
        stripe_customer_id: session.customer || null,
        stripe_payment_intent: session.payment_intent || null,
        customer_tenant_id: tenantId,
        customer_name: clientName,
        source: 'stripe-webhook',
        basis: 'gross',
      },
    }).select().single();
    if (error) return { status: 'error', error: error.message };
    log.success(`Checkout ${session.id} booked $${amount.toFixed(2)} (${clientName})`);
    return { status: 'recorded', entryId: inserted.id, amount };
  } finally {
    if (reset) await reset();
  }
}

/**
 * A refund reverses revenue. Booked as a NEGATIVE income row rather than an
 * expense so the P&L top line reflects what was actually kept — a refund is
 * not a cost of doing business, it is revenue that never was.
 */
async function recordStripeRefund(supabase, charge) {
  const refunded = (charge.amount_refunded || 0) / 100;
  if (refunded <= 0) return { status: 'skipped', reason: 'no refunded amount' };

  const { data: dup } = await supabase.from('finance_entries')
    .select('id').eq('tenant_id', FGA_TENANT_ID)
    .filter('metadata->>stripe_refund_for_charge', 'eq', charge.id).limit(1);
  if (dup && dup.length) return { status: 'duplicate', entryId: dup[0].id };

  const tenantId = charge.customer ? await findTenantByStripeCustomer(supabase, charge.customer) : null;
  const { data: clientRow } = tenantId
    ? await supabase.from('tenants').select('name').eq('id', tenantId).limit(1)
    : { data: null };
  const clientName = clientRow?.[0]?.name || charge.billing_details?.name || 'unknown customer';

  const reset = await setAuditContext(supabase, 'stripe-webhook');
  try {
    const { data: inserted, error } = await supabase.from('finance_entries').insert({
      tenant_id: FGA_TENANT_ID,
      entry_type: 'income',
      category: 'refund',
      amount: -Math.abs(refunded),
      description: `Stripe refund — ${clientName}`,
      date: new Date().toISOString().slice(0, 10),
      recurring: false,
      metadata: {
        stripe_refund_for_charge: charge.id,
        stripe_customer_id: charge.customer || null,
        customer_tenant_id: tenantId,
        customer_name: clientName,
        source: 'stripe-webhook',
        basis: 'gross',
      },
    }).select().single();
    if (error) return { status: 'error', error: error.message };
    log.warn(`Refund booked: -$${refunded.toFixed(2)} (${clientName})`);
    return { status: 'recorded', entryId: inserted.id, amount: -refunded };
  } finally {
    if (reset) await reset();
  }
}

/**
 * A dispute is money at risk plus a deadline. It is NOT booked as a ledger
 * entry (the funds may be returned), but it is always escalated — a chargeback
 * the owner learns about after the response window has closed is a loss that
 * was preventable.
 */
async function recordStripeDispute(supabase, dispute) {
  const amount = (dispute.amount || 0) / 100;
  const dueBy = dispute.evidence_details?.due_by
    ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
    : null;
  const { data: existing } = await supabase.from('attention_queue')
    .select('id').eq('tenant_id', FGA_TENANT_ID)
    .filter('payload->>stripe_dispute_id', 'eq', dispute.id)
    .is('resolved_at', null).limit(1);
  if (existing && existing.length) return { status: 'duplicate' };

  await supabase.from('attention_queue').insert({
    tenant_id: FGA_TENANT_ID,
    type: 'stripe_dispute',
    severity: 'red',
    title: `Chargeback disputed — $${amount.toFixed(2)}`,
    summary: `A customer disputed a $${amount.toFixed(2)} charge (reason: ${dispute.reason || 'unknown'}).`
      + (dueBy ? ` Evidence is due by ${dueBy.slice(0, 10)}.` : '')
      + ' Funds are withheld until this resolves.',
    entity_type: 'stripe_dispute',
    payload: {
      stripe_dispute_id: dispute.id, stripe_charge_id: dispute.charge,
      amount, reason: dispute.reason || null, due_by: dueBy, status: dispute.status,
    },
    quick_actions: [{ label: 'Open Finance', href: '/admin/finance' }],
    produced_by: 'stripe-webhook',
  });
  log.error(`DISPUTE $${amount.toFixed(2)} — ${dispute.reason || 'unknown reason'}`);
  return { status: 'escalated', amount };
}

module.exports = {
  findTenantByStripeCustomer,
  setAuditContext,
  isPeriodLocked,
  recordStripeInvoicePaid,
  recordStripePaymentFailed,
  recordStripeSubscriptionDeleted,
  recordStripeSubscriptionUpdated,
  recordStripeCheckoutPayment,
  recordStripeRefund,
  recordStripeDispute,
};
