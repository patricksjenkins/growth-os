'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  readWebhookRoutePolicy,
  requireWebhookRoute,
} = require('../core/security/webhook-route-policy');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('legacy routes default on to preserve deployed tenant behavior', () => {
  const policy = readWebhookRoutePolicy({});
  assert.equal(policy.calendly, true);
  assert.equal(policy.vapi, true);
  assert.equal(policy.telnyx, true);
});

/*
 * Twilio is retired. Telnyx is the carrier and the cutover is finished: the
 * voice_calls table holds 10 Twilio-originated calls ending 2026-06-12 and 15
 * Telnyx calls continuing to 2026-07-27. The route stayed on by default only
 * because nobody had checked, and it read a stored Twilio auth_token that was
 * still sitting on the FGA tenant.
 */
test('the Twilio route is off by default now that the carrier is gone', () => {
  assert.equal(readWebhookRoutePolicy({}).twilio, false,
    'a retired carrier must not keep a live webhook surface');
});

test('Twilio can still be switched back on deliberately', () => {
  // If a number is ever pointed at it again, this has to be recoverable
  // without a deploy.
  assert.equal(
    readWebhookRoutePolicy({ FGA_WEBHOOK_TWILIO_ROUTE_ENABLED: 'true' }).twilio,
    true,
  );
});

test('retiring Twilio does not touch the carrier actually in use', () => {
  const policy = readWebhookRoutePolicy({});
  assert.equal(policy.telnyx, true, 'Telnyx carries every call and SMS today');
  assert.equal(policy.vapi, true, 'Vapi answers the calls');
});

test('legacy routes can be isolated independently without affecting Telnyx', () => {
  const policy = readWebhookRoutePolicy({
    FGA_WEBHOOK_CALENDLY_ROUTE_ENABLED: 'false',
    FGA_WEBHOOK_TWILIO_ROUTE_ENABLED: 'false',
  });
  assert.equal(policy.calendly, false);
  assert.equal(policy.twilio, false);
  assert.equal(policy.vapi, true);
  assert.equal(policy.telnyx, true);
});

/*
 * `status: 'retired'` on a tenant_integrations row is decorative.
 * core/tenant.js resolveTenant loads every row into tenant.integrations
 * regardless of status, so verifyTwilioSignature
 * (api/middleware/webhookVerify.js) reads a retired row's auth_token exactly
 * as it would a live one. Retiring an integration means DELETING the row, not
 * labelling it — which is why migration 100 removes it rather than flipping a
 * flag.
 */
test('a retired integration row still hands out its credentials', () => {
  const { resolveTenant } = require('../core/tenant');
  const src = require('fs').readFileSync(require.resolve('../core/tenant'), 'utf8');
  assert.ok(typeof resolveTenant === 'function');
  assert.ok(
    !/\.eq\(\s*'status'\s*,\s*'active'\s*\)[\s\S]{0,80}tenant_integrations|tenant_integrations[\s\S]{0,200}\.neq\(\s*'status'/.test(src),
    'if integration loading ever starts filtering on status, revisit this note',
  );
});

test('disabled route returns a stable retirement response before tenant resolution', () => {
  const middleware = requireWebhookRoute('twilio', {
    FGA_WEBHOOK_TWILIO_ROUTE_ENABLED: 'false',
  });
  const res = responseRecorder();
  let nextCalled = false;
  middleware({}, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 410);
  assert.deepEqual(res.body, {
    error: 'Webhook route is not active',
    code: 'WEBHOOK_ROUTE_RETIRED',
  });
});
