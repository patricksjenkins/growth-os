/**
 * Growth OS — Tenant Middleware
 * Extracts tenant_id from JWT claims, resolves full tenant context
 */

const { getServiceClient } = require('../../db/client');
const { resolveTenant } = require('../../core/tenant');

async function tenantMiddleware(req, res, next) {
  // Tenant ID can live in either app_metadata (set server-side via admin API
  // during backend provisioning) OR user_metadata (set by admin user-creation
  // scripts for demo/self-service flows). Check both so demo users resolve.
  const tenantId =
    req.user?.app_metadata?.tenant_id ||
    req.user?.user_metadata?.tenant_id;

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
