/**
 * Cross-tenant tripwire middleware — DRAFT (2026-05-26)
 *
 * GOAL
 *   After Phase C3 (when /api/tenant/* routes are switched to user-JWT
 *   clients backed by RLS), a cross-tenant data leak should be
 *   structurally impossible. This middleware is a tripwire: it
 *   compares every JSON response body against the calling user's
 *   tenant_id and screams loudly if any row's tenant_id doesn't match.
 *
 *   If it ever fires, it means either:
 *     (a) a route still uses the service-role client and forgot a
 *         WHERE clause, OR
 *     (b) RLS got dropped, misconfigured, or has a policy gap.
 *
 *   Treat any fire as P0.
 *
 * STATUS
 *   Drafted only. Not yet registered in server.js. Should be enabled
 *   AFTER Phase C3 is fully rolled out so it doesn't fire on
 *   intentionally-cross-tenant admin routes during the migration.
 *
 *   Registration (when ready):
 *     // server.js, AFTER auth middleware that sets req.tenantId,
 *     // BEFORE the route handlers
 *     app.use('/api/tenant', require('./api/middleware/cross-tenant-tripwire'));
 *     app.use('/api/finance', require('./api/middleware/cross-tenant-tripwire'));
 *     // Do NOT apply to /api/admin — admin routes intentionally cross.
 */

let Sentry = null;
try {
  // Loaded lazily — Sentry isn't required for the middleware to function;
  // it just won't ship to a tracker if Sentry isn't installed.
  // eslint-disable-next-line global-require
  Sentry = require('@sentry/node');
} catch (_) {
  // ok — log to console only
}

/**
 * Walk an arbitrary JSON value and collect every `tenant_id` string we
 * find. Handles arrays, nested objects, and the common API response
 * shapes used by /api/finance and /api/tenant routes:
 *   { success: true, data: [...] }
 *   { success: true, clients: [...] }
 *   { success: true, leads: [...] }
 */
function collectTenantIds(value, out = new Set(), seen = new WeakSet()) {
  if (value == null) return out;
  if (typeof value !== 'object') return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTenantIds(item, out, seen);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'tenant_id' && typeof v === 'string' && v.length > 0) {
      out.add(v);
    } else if (typeof v === 'object' && v !== null) {
      collectTenantIds(v, out, seen);
    }
  }
  return out;
}

function makeMiddleware() {
  return function crossTenantTripwire(req, res, next) {
    // Save original res.json so we can wrap it without breaking
    // Express's response chain.
    const originalJson = res.json.bind(res);
    res.json = function wrappedJson(body) {
      try {
        const expected = req.tenantId; // set by upstream auth middleware
        if (expected) {
          const seen = collectTenantIds(body);
          for (const id of seen) {
            if (id !== expected) {
              // Cross-tenant data is in this response. ALERT.
              const incident = {
                route: req.originalUrl,
                method: req.method,
                expected_tenant: expected,
                actual_tenant_in_payload: id,
                user_email: (req.user && req.user.email) || null,
                ip: req.ip,
                ts: new Date().toISOString(),
              };
              // Always log loudly to stderr.
              // eslint-disable-next-line no-console
              console.error('[CROSS-TENANT TRIPWIRE]', JSON.stringify(incident));
              if (Sentry && typeof Sentry.captureMessage === 'function') {
                Sentry.captureMessage('CROSS-TENANT DATA LEAK', {
                  level: 'fatal',
                  extra: incident,
                });
              }
              // Stop the response — fail closed.
              res.status(500);
              return originalJson({
                success: false,
                error: 'Internal error: cross-tenant integrity check failed. This incident has been logged.',
              });
            }
          }
        }
      } catch (e) {
        // A tripwire that cannot inspect a response cannot prove isolation.
        // Fail closed rather than returning an unverified tenant payload.
        // eslint-disable-next-line no-console
        console.error('[CROSS-TENANT TRIPWIRE] internal error', e);
        if (Sentry && typeof Sentry.captureException === 'function') {
          Sentry.captureException(e, {
            level: 'fatal',
            extra: {
              route: req.originalUrl,
              method: req.method,
              expected_tenant: req.tenantId || null,
            },
          });
        }
        res.status(500);
        return originalJson({
          success: false,
          error: 'Internal error: tenant integrity could not be verified. This incident has been logged.',
        });
      }
      return originalJson(body);
    };
    next();
  };
}

module.exports = makeMiddleware();
module.exports.makeMiddleware = makeMiddleware;
module.exports.collectTenantIds = collectTenantIds;
