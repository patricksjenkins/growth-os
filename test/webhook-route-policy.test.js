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
  assert.equal(policy.twilio, true);
  assert.equal(policy.vapi, true);
  assert.equal(policy.telnyx, true);
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
