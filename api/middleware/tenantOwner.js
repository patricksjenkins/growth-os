/**
 * Growth OS — Tenant Owner Middleware
 *
 * Used on the `/api/tenant/*` routes. Resolves the logged-in user's
 * tenant_id from user_metadata and attaches it to the request. Also
 * enforces the "write guard" for demo tenants: when tenant.is_demo = true,
 * destructive methods (POST/PATCH/PUT/DELETE) are allowed to run but
 * return a mocked success response instead of mutating.
 *
 * This middleware is what separates the tenant self-view from the
 * cross-tenant founder view — every /api/tenant/* query gets
 * automatically scoped to req.tenantId.
 */

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { resolveTenantClaim } = require('../../core/authz/claims');
const log = createLogger('tenant-owner');

async function tenantOwnerMiddleware(req, res, next) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Unauthenticated' });
  }

  const claim = resolveTenantClaim(user, {
    enforce: flags.authzAppMetadataEnforce(),
  });
  const tenantId = claim.tenantId;

  if (claim.legacyFallback || claim.conflict) {
    log.warn(`Non-authoritative tenant-owner claim observed: ${claim.reason}`);
  }

  if (!claim.allowed || !tenantId) {
    return res.status(403).json({
      success: false,
      error: 'Authoritative tenant access could not be verified.',
    });
  }

  // Resolve the tenant so downstream handlers can read is_demo + vertical + branding
  const db = getServiceClient();
  const { data: tenant, error } = await db
    .from('tenants')
    .select('id, name, slug, vertical, status, is_demo, branding')
    .eq('id', tenantId)
    .single();

  if (error || !tenant) {
    log.warn(`Tenant lookup failed: ${error?.code || 'not_found'}`);
    return res.status(404).json({ success: false, error: 'Tenant not found' });
  }
  if (flags.authzAppMetadataEnforce() && tenant.status !== 'active') {
    return res.status(403).json({ success: false, error: 'Tenant is not active' });
  }

  req.tenantId = tenant.id;
  req.tenant = tenant;
  req.isDemo = !!tenant.is_demo;
  req.tenantClaimSource = claim.source;
  next();
}

/**
 * Demo write guard. Applied AFTER tenantOwnerMiddleware. For mutating HTTP
 * methods, if the tenant is a demo, short-circuit with a mocked success
 * response so prospects can tap around without persisting changes (beyond
 * what the weekly seeder resets anyway).
 */
function demoWriteGuard(req, res, next) {
  if (!req.isDemo) return next();

  const method = req.method.toUpperCase();
  const isMutation = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  if (!isMutation) return next();

  log.info(`[demo] ${method} ${req.originalUrl} short-circuited`);
  return res.json({
    success: true,
    mocked: true,
    message: 'Demo mode — change was simulated but not saved.',
  });
}

module.exports = { tenantOwnerMiddleware, demoWriteGuard };
