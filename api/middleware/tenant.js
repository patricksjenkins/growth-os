/**
 * Growth OS — Tenant Middleware
 * Extracts tenant_id from JWT claims, resolves full tenant context
 */

const { getServiceClient } = require('../../db/client');
const { resolveTenant } = require('../../core/tenant');

async function tenantMiddleware(req, res, next) {
  // Tenant ID comes from user's app_metadata (set during user creation)
  const tenantId = req.user?.app_metadata?.tenant_id;

  if (!tenantId) {
    return res.status(403).json({ error: 'No tenant associated with this user' });
  }

  try {
    const supabase = getServiceClient();
    const tenant = await resolveTenant(supabase, tenantId);

    req.tenant = tenant;
    req.tenantId = tenantId;

    next();
  } catch (err) {
    return res.status(403).json({ error: `Tenant resolution failed: ${err.message}` });
  }
}

module.exports = { tenantMiddleware };
