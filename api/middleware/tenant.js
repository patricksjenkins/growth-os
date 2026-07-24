/**
 * Growth OS — Tenant Middleware
 * Extracts tenant_id from JWT claims, resolves full tenant context
 */

const { getServiceClient } = require('../../db/client');
const { resolveTenant } = require('../../core/tenant');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { resolveTenantClaim } = require('../../core/authz/claims');

const log = createLogger('tenant-middleware');

async function tenantMiddleware(req, res, next) {
  const claim = resolveTenantClaim(req.user, {
    enforce: flags.authzAppMetadataEnforce(),
  });
  const tenantId = claim.tenantId;

  if (claim.legacyFallback || claim.conflict) {
    log.warn(`Non-authoritative tenant claim observed: ${claim.reason}`);
  }

  if (!claim.allowed || !tenantId) {
    return res.status(403).json({ error: 'Authoritative tenant access could not be verified' });
  }

  try {
    const supabase = getServiceClient();
    const tenant = await resolveTenant(supabase, tenantId);
    if (flags.authzAppMetadataEnforce() && tenant.status !== 'active') {
      return res.status(403).json({ error: 'Tenant is not active' });
    }

    req.tenant = tenant;
    req.tenantId = tenantId;
    req.tenantClaimSource = claim.source;

    next();
  } catch (err) {
    return res.status(403).json({ error: `Tenant resolution failed: ${err.message}` });
  }
}

module.exports = { tenantMiddleware };
