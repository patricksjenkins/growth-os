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

/**
 * Financial classification for a tenant — the single place that answers
 * "how does this tenant appear in FGA's financial reports?".
 *
 * Types (mutually exclusive, in precedence order):
 *   internal      — FGA's own tenant (the platform's books, never a customer)
 *   demo          — is_demo tenants (Apex Plumbing); never revenue
 *   complimentary — friends & family, deliberately unbilled
 *   paying        — isBillingActive() true → contributes to MRR
 *   inactive      — real customer record but not billing right now
 *
 * Config values are read defensively: some historical rows were double-JSON
 * encoded ('"growth"'), so string values get their quotes stripped.
 *
 * @param {object} tenant   tenants row: { id, name, slug, status, is_demo }
 * @param {function} cfg    (key) => tenant_config value for this tenant
 * @param {string} fgaTenantId
 * @param {number} [nowMs]
 */
function classifyTenant(tenant, cfg, fgaTenantId, nowMs = Date.now()) {
  const clean = (v) => (v == null ? v : String(v).replace(/^"|"$/g, ''));
  const tier = clean(cfg('tier')) || 'growth';
  const rateRaw = clean(cfg('monthly_rate'));
  const monthlyRate = rateRaw != null && rateRaw !== ''
    ? Number(rateRaw)
    : tier === 'scale' ? 399 : tier === 'complimentary' ? 0 : 249;
  const isComplimentary = clean(cfg('is_complimentary')) === 'true';
  const billingInput = {
    isComplimentary,
    monthlyRate,
    churnedAt: clean(cfg('churned_at')) || null,
    subscriptionStatus: clean(cfg('subscription_status')) || null,
    billingActiveFlag: clean(cfg('billing_active')) === 'true',
    trialEndsAt: clean(cfg('trial_ends_at')) || null,
    status: tenant.status,
  };
  const billingActive = isBillingActive(billingInput, nowMs);

  let type = 'inactive';
  if (tenant.id === fgaTenantId) type = 'internal';
  else if (tenant.is_demo) type = 'demo';
  else if (isComplimentary) type = 'complimentary';
  else if (billingActive) type = 'paying';

  const setupFee = Number(clean(cfg('setup_fee')) || 0) || 0;
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    type,
    tier,
    monthly_rate: Number.isFinite(monthlyRate) ? monthlyRate : 0,
    billing_active: billingActive,
    is_complimentary: isComplimentary,
    is_demo: !!tenant.is_demo,
    subscription_status: billingInput.subscriptionStatus,
    delivery_status: tenant.status,
    churned_at: billingInput.churnedAt,
    setup_fee: setupFee,
    setup_fee_paid: clean(cfg('setup_fee_paid')) === 'true',
  };
}

module.exports = { isBillingActive, classifyTenant, NON_BILLING_SUB_STATUSES };
