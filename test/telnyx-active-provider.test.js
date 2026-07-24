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

test('active SMS producers authorize Telnyx rather than legacy Twilio rows', () => {
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

test('new provisioning writes canonical Telnyx keys and no Twilio webhooks', () => {
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

test('legacy Twilio values remain read-only compatibility, never a Telnyx send grant', () => {
  const readiness = read('core/telnyx-readiness.js');
  const admin = read('api/routes/admin.js');
  const tenantLookup = read('db/queries/config.js');

  assert.doesNotMatch(readiness, /integrations\?*\.twilio/);
  assert.match(admin, /config\.telnyx_phone_number \|\| config\.twilio_phone_number/);
  assert.match(tenantLookup, /\.in\('service', \['telnyx', 'twilio'\]\)/);
});
