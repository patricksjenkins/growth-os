'use strict';

/**
 * Version-tolerant readers for the Stripe fields we depend on.
 *
 * WHY THIS EXISTS (2026-08-05)
 * Our live webhook endpoint (we_1TxViXJIrkogakNB1j1g5YJN) is registered at
 * API version `2026-03-25.dahlia`. Webhook payloads are delivered in the
 * ENDPOINT's version, not the version our SDK client pins — so pinning
 * `apiVersion: '2024-06-20'` in integrations/stripe.js protects our own
 * outbound calls and does nothing at all for inbound events.
 *
 * Stripe moved four fields we read. Verified against the real live objects,
 * not from documentation:
 *
 *   invoice.subscription          → invoice.parent.subscription_details.subscription
 *   invoice.subscription_details  → invoice.parent.subscription_details
 *   invoice.charge                → gone (see chargeOrPaymentRef below)
 *   subscription.current_period_end → subscription.items.data[0].current_period_end
 *
 * On the current live invoice in_1Tvm3HJIrkogakNBo2jutaxc, read at dahlia,
 * all four of the old paths are `undefined`. Nothing throws — the fields just
 * silently become null, which is the failure mode that gets noticed a month
 * later in a report rather than at the moment it breaks.
 *
 * Every reader here checks the NEW shape first and falls back to the old one,
 * so the same code is correct whether the object arrived from a pinned call
 * (old shape) or a webhook (new shape). That is deliberate: pinning would
 * work until the next version bump, and this does not.
 */

/** The subscription this invoice belongs to, or null for a one-off. */
function invoiceSubscriptionId(invoice = {}) {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  const id = fromParent || invoice.subscription || null;
  // Expanded objects arrive as the object, not the id string.
  if (id && typeof id === 'object') return id.id || null;
  return id || null;
}

/** Metadata carried on the subscription that generated this invoice. */
function invoiceSubscriptionMetadata(invoice = {}) {
  return invoice.parent?.subscription_details?.metadata
    || invoice.subscription_details?.metadata
    || null;
}

/**
 * A reference to the money movement behind a paid invoice.
 *
 * `invoice.charge` no longer exists at dahlia and there is NO unexpanded
 * replacement on the invoice object — the payment lives under
 * `invoice.payments`, which is a list that webhooks do not expand. So on a
 * modern webhook this is genuinely unavailable, and returning null is the
 * honest answer rather than a value invented from a stale field name.
 *
 * @returns {{id: string, type: 'charge'|'payment_intent'}|null}
 */
function invoicePaymentRef(invoice = {}) {
  if (invoice.charge) {
    const id = typeof invoice.charge === 'object' ? invoice.charge.id : invoice.charge;
    if (id) return { id, type: 'charge' };
  }
  if (invoice.payment_intent) {
    const id = typeof invoice.payment_intent === 'object'
      ? invoice.payment_intent.id : invoice.payment_intent;
    if (id) return { id, type: 'payment_intent' };
  }
  const pay = invoice.payments?.data?.[0]?.payment;
  if (pay?.charge) return { id: pay.charge, type: 'charge' };
  if (pay?.payment_intent) return { id: pay.payment_intent, type: 'payment_intent' };
  return null;
}

/**
 * End of the current billing period, as a unix timestamp.
 *
 * Moved to the subscription ITEM at 2025-03-31.basil, because a subscription
 * with items on different cadences has no single period. We bill one item per
 * subscription, so the first item's period is the subscription's period — but
 * take the latest across items so a multi-item subscription never reports a
 * renewal date earlier than one of its items.
 */
function subscriptionPeriodEnd(subscription = {}) {
  if (subscription.current_period_end) return subscription.current_period_end;
  const ends = (subscription.items?.data || [])
    .map((i) => i.current_period_end)
    .filter((n) => typeof n === 'number');
  return ends.length ? Math.max(...ends) : null;
}

/** Same move as above, for the period start. */
function subscriptionPeriodStart(subscription = {}) {
  if (subscription.current_period_start) return subscription.current_period_start;
  const starts = (subscription.items?.data || [])
    .map((i) => i.current_period_start)
    .filter((n) => typeof n === 'number');
  return starts.length ? Math.min(...starts) : null;
}

/** Unix seconds → 'YYYY-MM-DD', or null. Shared by the callers below. */
function toDateOnly(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

module.exports = {
  invoiceSubscriptionId,
  invoiceSubscriptionMetadata,
  invoicePaymentRef,
  subscriptionPeriodEnd,
  subscriptionPeriodStart,
  toDateOnly,
};
