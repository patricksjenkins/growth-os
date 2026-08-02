'use strict';

const ROUTE_ENV = Object.freeze({
  calendly: 'FGA_WEBHOOK_CALENDLY_ROUTE_ENABLED',
  vapi: 'FGA_WEBHOOK_VAPI_ROUTE_ENABLED',
});

function enabledUnlessFalse(env, name) {
  return String(env?.[name] ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Legacy routes default on for backward compatibility, until the traffic
 * inventory this file asks for proves one is unused. Active Stripe, Telnyx,
 * and Resend surfaces are never controlled by these retirement flags.
 *
 * The previous carrier's route and its inbound voice handlers were removed on
 * 2026-08-02: the cutover to Telnyx finished in June 2026 and it had taken no
 * traffic since. Its environment flag is dead and can be deleted.
 */
function readWebhookRoutePolicy(env = process.env) {
  return Object.freeze({
    stripe: true,
    telnyx: true,
    resend: true,
    calendly: enabledUnlessFalse(env, ROUTE_ENV.calendly),
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
