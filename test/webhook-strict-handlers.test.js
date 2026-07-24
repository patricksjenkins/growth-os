'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  verifyCalendlySignature,
  verifyTwilioSignature,
} = require('../api/middleware/webhookVerify');
const { verifyTelnyxSignature } = require('../api/webhooks/telnyx');
const { verifySvixSignature } = require('../api/webhooks/resend');

const STRICT_FLAG = 'FGA_OS_STRICT_WEBHOOK_VERIFICATION';

function withStrict(value, fn) {
  const previous = process.env[STRICT_FLAG];
  try {
    if (value === undefined) delete process.env[STRICT_FLAG];
    else process.env[STRICT_FLAG] = value;
    return fn();
  } finally {
    if (previous === undefined) delete process.env[STRICT_FLAG];
    else process.env[STRICT_FLAG] = previous;
  }
}

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

test('strict mode rejects missing Calendly and Twilio verification material', () => {
  const calendlyRes = responseRecorder();
  let calendlyNext = false;
  withStrict('true', () => verifyCalendlySignature(
    { headers: {}, tenant: { integrations: {} } },
    calendlyRes,
    () => { calendlyNext = true; }
  ));
  assert.equal(calendlyRes.statusCode, 403);
  assert.equal(calendlyNext, false);

  const twilioRes = responseRecorder();
  let twilioNext = false;
  withStrict('true', () => verifyTwilioSignature(
    {
      headers: { 'x-twilio-signature': 'present' },
      tenant: { integrations: {} },
      body: {},
      originalUrl: '/webhooks/voice-receptionist',
    },
    twilioRes,
    () => { twilioNext = true; }
  ));
  assert.equal(twilioRes.statusCode, 503);
  assert.equal(twilioNext, false);
});

test('strict mode rejects Telnyx and Resend when verification cannot be proven', () => {
  const previousTelnyx = process.env.TELNYX_PUBLIC_KEY;
  const previousResend = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.TELNYX_PUBLIC_KEY;
  delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    withStrict('true', () => {
      assert.equal(verifyTelnyxSignature({ headers: {} }), false);
      assert.equal(verifySvixSignature({ headers: {} }), false);
    });
  } finally {
    if (previousTelnyx === undefined) delete process.env.TELNYX_PUBLIC_KEY;
    else process.env.TELNYX_PUBLIC_KEY = previousTelnyx;
    if (previousResend === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = previousResend;
  }
});

test('legacy compatibility remains unchanged while strict mode is disabled', () => {
  const res = responseRecorder();
  let nextCalled = false;
  withStrict(undefined, () => verifyCalendlySignature(
    { headers: {}, tenant: { integrations: {} } },
    res,
    () => { nextCalled = true; }
  ));
  assert.equal(nextCalled, true);
});

test('mounted Telnyx voice and Vapi assistant routes contain strict verification gates', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'webhooks', 'voice-receptionist.js'),
    'utf8'
  );
  assert.match(source, /router\.post\('\/telnyx',[\s\S]{0,240}verifyTelnyxSignature/);
  assert.match(source, /router\.post\('\/telnyx\/after',[\s\S]{0,240}verifyTelnyxSignature/);
  assert.match(source, /router\.post\('\/vapi-assistant'[\s\S]{0,500}strictWebhookVerification/);
  assert.match(source, /verifyServerSecret\(provided\)/);
});
