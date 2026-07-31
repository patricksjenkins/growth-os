'use strict';

const ROUTE_ENV = Object.freeze({
  calendly: 'FGA_WEBHOOK_CALENDLY_ROUTE_ENABLED',
  twilio: 'FGA_WEBHOOK_TWILIO_ROUTE_ENABLED',
  vapi: 'FGA_WEBHOOK_VAPI_ROUTE_ENABLED',
});

function enabledUnlessFalse(env, name) {
  return String(env?.[name] ?? '').trim().toLowerCase() !== 'false';
}

function disabledUnlessTrue(env, name) {
  return String(env?.[name] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Legacy routes default on for backward compatibility, until the traffic
 * inventory this file asks for proves one is unused. Active Stripe, Telnyx,
 * and Resend surfaces are never controlled by these retirement flags.
 *
 * TWILIO IS RETIRED (2026-07-30). Telnyx is the carrier, and the call record
 * shows the cutover completed: `voice_calls` holds 10 Twilio-originated calls
 * ending 2026-06-12, and 15 Telnyx calls continuing to 2026-07-27. Seven weeks
 * with no Twilio traffic is the inventory, so the default flips to off. Set
 * FGA_WEBHOOK_TWILIO_ROUTE_ENABLED=true to bring it back if a number is ever
 * pointed at it again.
 */
function readWebhookRoutePolicy(env = process.env) {
  return Object.freeze({
    stripe: true,
    telnyx: true,
    resend: true,
    calendly: enabledUnlessFalse(env, ROUTE_ENV.calendly),
    twilio: disabledUnlessTrue(env, ROUTE_ENV.twilio),
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
