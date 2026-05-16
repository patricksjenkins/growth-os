/**
 * Growth OS — Sentry initialization
 *
 * Wire-in is intentionally LAZY and FAULT-TOLERANT:
 *   - If SENTRY_DSN is not set, init becomes a no-op so dev environments
 *     and the early days of testing don't get spammed with errors.
 *   - If @sentry/node isn't installed (e.g. someone ran a partial install),
 *     we swallow the require error so the API still boots.
 *
 * Call `initSentry()` ONCE at the very top of api/server.js (before any
 * route imports) and `attachExpressErrorHandler(app)` AFTER routes are
 * registered but BEFORE any custom error middleware.
 */

let Sentry = null;
let initialized = false;

function initSentry() {
  if (initialized) return Sentry;
  initialized = true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.log('[sentry] SENTRY_DSN not set — error monitoring disabled');
    return null;
  }

  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn,
      // Mirror the deploy environment (Railway sets NODE_ENV=production)
      environment: process.env.NODE_ENV || 'development',
      // Sample 100% of errors and 10% of perf traces — adjust if Sentry
      // quota gets tight (free tier = 5k errors/month)
      tracesSampleRate: 0.1,
      // Drop PII by default; flip to true if you intentionally want IPs/headers
      sendDefaultPii: false,
    });
    console.log('[sentry] initialized for environment:', process.env.NODE_ENV || 'development');
    return Sentry;
  } catch (err) {
    console.warn('[sentry] failed to initialize (continuing without):', err.message);
    return null;
  }
}

/**
 * Attach Sentry's Express error handler. Must be called AFTER all routes
 * are registered but BEFORE any custom error middleware. No-ops if Sentry
 * isn't initialized.
 */
function attachExpressErrorHandler(app) {
  if (!Sentry || !app) return;
  try {
    Sentry.setupExpressErrorHandler(app);
  } catch (err) {
    console.warn('[sentry] setupExpressErrorHandler failed:', err.message);
  }
}

/**
 * Manually capture an exception with optional tags/context. Useful inside
 * agent runs where the express handler doesn't catch.
 */
function captureException(err, context = {}) {
  if (!Sentry) return;
  try {
    Sentry.captureException(err, { tags: context.tags, extra: context.extra });
  } catch {}
}

module.exports = { initSentry, attachExpressErrorHandler, captureException };
