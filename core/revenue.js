/**
 * Growth OS — Revenue recognition helpers
 *
 * The single source of truth for "does this tenant contribute MRR?"
 *
 * The key idea: BILLING status and DELIVERY (go-live) status are two
 * independent axes. A customer whose free trial has converted — or whose
 * Stripe subscription is active — is paying us every month, whether or not
 * their branded app/site is live yet. Onboarding delays are a delivery/health
 * problem, NOT a revenue problem. So MRR must key off billing, never off the
 * operational `tenants.status` (which only flips to 'active' at go-live).
 *
 * Complimentary (friends & family) and churned/canceled tenants never count.
 */

// Stripe subscription statuses that mean "not billing us" — a subscription in
// any of these states should be excluded from MRR even if a stale billing flag
// lingers.
const NON_BILLING_SUB_STATUSES = new Set([
  'canceled',
  'incomplete_expired',
  'unpaid',
]);

/**
 * @param {object} t
 * @param {boolean} t.isComplimentary  tenant_config.is_complimentary === 'true'
 * @param {number}  t.monthlyRate      tenant_config.monthly_rate (monthly-equivalent $)
 * @param {string|null} [t.churnedAt]  tenant_config.churned_at (ISO) if churned
 * @param {string|null} [t.subscriptionStatus] tenant_config.subscription_status (Stripe)
 * @param {boolean} [t.billingActiveFlag] tenant_config.billing_active === 'true'
 * @param {string|null} [t.trialEndsAt] tenant_config.trial_ends_at (ISO)
 * @param {string} [t.status]          tenants.status (operational/delivery lifecycle)
 * @param {number} [nowMs]             clock injection for tests
 * @returns {boolean} true if the tenant contributes to MRR right now
 */
function isBillingActive(t, nowMs = Date.now()) {
  if (!t) return false;
  if (t.isComplimentary) return false;
  if (!(Number(t.monthlyRate) > 0)) return false;
  if (t.churnedAt) return false;

  const sub = t.subscriptionStatus || null;
  if (sub && NON_BILLING_SUB_STATUSES.has(sub)) return false;

  // A subscription still in its free trial is NOT billing yet — unless the
  // trial window has already elapsed (conversion), in which case it is.
  if (sub === 'trialing') {
    return t.trialEndsAt ? new Date(t.trialEndsAt).getTime() <= nowMs : false;
  }

  // Explicit "we are charging this customer" flag (set by the Stripe webhook,
  // or manually for out-of-band subscriptions like admin-onboarded tenants).
  if (t.billingActiveFlag === true) return true;

  // Live Stripe subscription.
  if (sub === 'active' || sub === 'past_due') return true;

  // Trial converted (day-15 in FGA's model) even if we never saw a webhook.
  if (t.trialEndsAt && new Date(t.trialEndsAt).getTime() <= nowMs) return true;

  // Operationally live customer with no other billing signal — go-live implies
  // billing has started (preserves the pre-decoupling behavior for live
  // tenants that predate the billing flags).
  if (t.status === 'active') return true;

  return false;
}

module.exports = { isBillingActive, NON_BILLING_SUB_STATUSES };
