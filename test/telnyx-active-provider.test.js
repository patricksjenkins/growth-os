'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const activeSmsFiles = [
  'api/routes/leads.js',
  'worker/agents/speed-to-lead.js',
  'worker/agents/review-request.js',
  'worker/agents/referral-request.js',
  'worker/agents/missed-call.js',
  'worker/agents/follow-up.js',
  'worker/agents/past-customer-reengagement.js',
  'worker/agents/partner-outreach.js',
  'worker/agents/facebook-prospecting.js',
];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('active SMS producers authorize Telnyx', () => {
  for (const file of activeSmsFiles) {
    const source = read(file);
    assert.match(source, /telnyx-readiness/, `${file} lacks canonical readiness`);
    assert.doesNotMatch(
      source,
      /integrations\?*\.twilio|integrations\[['"]twilio['"]\]/,
      `${file} still authorizes with a Twilio integration`
    );
  }
});

test('new provisioning writes canonical Telnyx keys only', () => {
  const source = read('worker/agents/app-asset-pipeline.js');
  assert.match(source, /key:\s*'telnyx_phone_number'/);
  assert.match(source, /key:\s*'telnyx_phone_id'/);
  assert.match(source, /TELNYX_MESSAGING_PROFILE_ID/);
  assert.match(source, /TELNYX_CONNECTION_ID/);
  assert.doesNotMatch(source, /key:\s*'twilio_phone_/);
  assert.doesNotMatch(source, /webhooks\/twilio/);
});

test('email-capable follow-up cannot select SMS without Telnyx readiness', () => {
  const source = read('worker/agents/follow-up.js');
  assert.match(source, /const hasSms = hasTelnyx && !!lead\.phone/);
});

/*
 * The previous carrier is gone, not merely inactive (2026-08-02).
 *
 * These assertions used to pin the OPPOSITE: that the fallbacks still existed
 * as "read-only compatibility". They were real fallbacks with real effects —
 * `config.twilio_phone_number` was FGA's, holding a number given up in June
 * 2026, and worker/agents/dfy-website-build.js printed it on the customer's
 * website. Compatibility with a dead carrier is not compatibility; it is a
 * dead number in front of customers.
 */
test('nothing reads the retired carrier as a fallback any more', () => {
  for (const file of [
    'core/telnyx-readiness.js',
    'api/routes/admin.js',
    'db/queries/config.js',
    'worker/agents/dfy-website-build.js',
  ]) {
    assert.doesNotMatch(read(file), /twilio/i, `${file} still references the retired carrier`);
  }
});

test('the tenant phone lookup queries Telnyx alone', () => {
  assert.match(read('db/queries/config.js'), /\.eq\('service', 'telnyx'\)/);
});
