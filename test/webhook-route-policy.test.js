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

test('retiring the old carrier does not touch the one actually in use', () => {
  const policy = readWebhookRoutePolicy({});
  assert.equal(policy.telnyx, true, 'Telnyx carries every call and SMS today');
  assert.equal(policy.vapi, true, 'Vapi answers the calls');
});

test('legacy routes can be isolated independently without affecting Telnyx', () => {
  const policy = readWebhookRoutePolicy({
    FGA_WEBHOOK_CALENDLY_ROUTE_ENABLED: 'false',
  });
  assert.equal(policy.calendly, false);
  assert.equal(policy.vapi, true);
  assert.equal(policy.telnyx, true);
});

/*
 * The previous carrier's route was deleted outright on 2026-08-02, along with
 * its inbound voice handlers and signature middleware. It is not a disabled
 * route — it is not a route. Asking for it must be an error, not a silent
 * false, so a stale caller cannot quietly believe it is gating something.
 */
test('the retired carrier is not a route any more, not even a disabled one', () => {
  const policy = readWebhookRoutePolicy({});
  assert.ok(!('twilio' in policy), 'the key itself must be gone');
  assert.throws(() => requireWebhookRoute('twilio'), /Unknown legacy webhook route/);
});

test('disabled route returns a stable retirement response before tenant resolution', () => {
  const middleware = requireWebhookRoute('calendly', {
    FGA_WEBHOOK_CALENDLY_ROUTE_ENABLED: 'false',
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
