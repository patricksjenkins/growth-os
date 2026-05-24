/**
 * Growth OS — Shared helpers for the /api/admin/* route surface
 *
 * V1 hardening (2026-05-24): extracted from admin.js (was 2046 lines) so
 * the constants and pure helpers can be reused without dragging the
 * full router. Behavior is intentionally identical — moving these out
 * is a no-op for the running deployment, just a precondition for the
 * eventual per-domain split (overview / clients / pipeline / support /
 * marketing) tracked as V1.1 work.
 *
 * IMPORTANT: do not add stateful logic here. This module is only for
 * pure helpers + constants. DB calls live in the route handlers.
 */

// Tier pricing defaults — used by /overview when a tenant doesn't have
// a per-tenant rate override set in tenant_config.monthly_rate.
const TIER_PRICING = {
  growth: 249,
  scale: 399,
};

const SETUP_FEE_DEFAULT = 199;

/**
 * Treat the value as "set" if it's anything other than null/undefined/''.
 * Plain truthy fails for the legitimate 0 case (e.g. a demo tenant with
 * rate=0 would fall back to TIER_PRICING.growth and display $0 instead
 * of the tier default).
 */
function readNumericConfig(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build the per-tenant `monthly_rate` for the /overview list. Reads
 * tenant_config.monthly_rate when present, otherwise the tier default.
 *
 * @param {string|null} rateOverride - tenant_config.monthly_rate value
 * @param {string} tier - 'growth' | 'scale' | unknown
 */
function resolveMonthlyRate(rateOverride, tier) {
  const tierDefault = TIER_PRICING[tier] !== undefined
    ? TIER_PRICING[tier]
    : TIER_PRICING.growth;
  return readNumericConfig(rateOverride, tierDefault);
}

module.exports = {
  TIER_PRICING,
  SETUP_FEE_DEFAULT,
  readNumericConfig,
  resolveMonthlyRate,
};
