'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the tenant claim while supporting a no-break shadow period.
 *
 * app_metadata is server-written and authoritative. user_metadata is retained
 * only as a temporary compatibility fallback while active users are audited
 * and backfilled. Enforcement removes that fallback completely.
 */
function resolveTenantClaim(user, { enforce = false } = {}) {
  const authoritative = normalizeString(user?.app_metadata?.tenant_id);
  const legacy = normalizeString(user?.user_metadata?.tenant_id);
  const authoritativeValid = Boolean(authoritative && UUID.test(authoritative));
  const conflict = Boolean(authoritative && legacy && authoritative !== legacy);

  if (enforce) {
    return {
      allowed: authoritativeValid && !conflict,
      tenantId: authoritativeValid && !conflict ? authoritative : null,
      source: authoritativeValid ? 'app_metadata' : 'missing',
      conflict,
      legacyFallback: false,
      reason: conflict
        ? 'tenant_claim_conflict'
        : (authoritativeValid ? 'authoritative' : 'missing_authoritative_tenant'),
    };
  }

  const selected = authoritativeValid ? authoritative : legacy;
  return {
    allowed: Boolean(selected),
    tenantId: selected || null,
    source: authoritativeValid ? 'app_metadata' : (legacy ? 'user_metadata' : 'missing'),
    conflict,
    legacyFallback: !authoritativeValid && Boolean(legacy),
    reason: conflict
      ? 'tenant_claim_conflict_shadow'
      : (authoritativeValid ? 'authoritative' : (legacy ? 'legacy_fallback' : 'missing_tenant')),
  };
}

function resolveRoleClaim(user, { enforce = false } = {}) {
  const authoritative = normalizeString(user?.app_metadata?.role);
  const legacy = normalizeString(user?.user_metadata?.role);
  const conflict = Boolean(authoritative && legacy && authoritative !== legacy);
  const role = enforce ? authoritative : (authoritative || legacy);

  return {
    allowed: Boolean(role) && (!enforce || !conflict),
    role: role || null,
    source: authoritative ? 'app_metadata' : (legacy ? 'user_metadata' : 'missing'),
    conflict,
    legacyFallback: !authoritative && Boolean(legacy) && !enforce,
  };
}

module.exports = { resolveTenantClaim, resolveRoleClaim, UUID };
