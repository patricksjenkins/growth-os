'use strict';

const ROUTE_ENV = Object.freeze({
  calendly: 'FGA_WEBHOOK_CALENDLY_ROUTE_ENABLED',
  twilio: 'FGA_WEBHOOK_TWILIO_ROUTE_ENABLED',
  vapi: 'FGA_WEBHOOK_VAPI_ROUTE_ENABLED',
});

function enabledUnlessFalse(env, name) {
  return String(env?.[name] ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Legacy routes default on for backward compatibility. Operators can isolate
 * each one independently after the tenant regression inventory proves it is
 * unused. Active Stripe, Telnyx, and Resend surfaces are never controlled by
 * these retirement flags.
 */
function readWebhookRoutePolicy(env = process.env) {
  return Object.freeze({
    stripe: true,
    telnyx: true,
    resend: true,
    calendly: enabledUnlessFalse(env, ROUTE_ENV.calendly),
    twilio: enabledUnlessFalse(env, ROUTE_ENV.twilio),
    vapi: enabledUnlessFalse(env, ROUTE_ENV.vapi),
  });
}

function requireWebhookRoute(provider, env = process.env) {
  if (!Object.hasOwn(ROUTE_ENV, provider)) {
    throw new TypeError(`Unknown legacy webhook route: ${provider}`);
  }
  return function webhookRoutePolicy(req, res, next) {
    if (readWebhookRoutePolicy(env)[provider]) return next();
    return res.status(410).json({
      error: 'Webhook route is not active',
      code: 'WEBHOOK_ROUTE_RETIRED',
    });
  };
}

module.exports = {
  ROUTE_ENV,
  readWebhookRoutePolicy,
  requireWebhookRoute,
};
