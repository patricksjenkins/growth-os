/**
 * SMS identity guard (2026-07-14 audit) — a non-platform tenant must never
 * fall back to FGA's own sending number, and cross-tenant content must be
 * detectable in SMS bodies the same way it is for email.
 */
const test = require('node:test');
const assert = require('node:assert');

const { resolveFromNumber } = require('../integrations/telnyx');
const { scanForbidden, resolveIdentity } = require('../core/tenant-email-identity');

const REAL_TENANT = {
  id: 'bd2deab7-c870-4565-bf8d-93d6511f2d09',
  slug: '923a-coins',
  config: { business_name: '923A Coins & Designs' },
};
const PLATFORM_TENANT = { id: 'fga-id', slug: 'fga', config: {} };

test('resolveFromNumber: non-platform tenant with no number gets NULL, never the FGA env number', () => {
  const prev = process.env.TELNYX_PHONE_NUMBER;
  process.env.TELNYX_PHONE_NUMBER = '+14045551234';
  try {
    assert.strictEqual(resolveFromNumber(null, REAL_TENANT), null);
  } finally {
    if (prev === undefined) delete process.env.TELNYX_PHONE_NUMBER; else process.env.TELNYX_PHONE_NUMBER = prev;
  }
});

test('resolveFromNumber: tenant-configured number always wins', () => {
  const t = { ...REAL_TENANT, config: { ...REAL_TENANT.config, telnyx_phone_number: '+17195550000' } };
  assert.strictEqual(resolveFromNumber(null, t), '+17195550000');
});

test('resolveFromNumber: platform tenant keeps the env fallback', () => {
  const prev = process.env.TELNYX_PHONE_NUMBER;
  process.env.TELNYX_PHONE_NUMBER = '+14045551234';
  try {
    assert.strictEqual(resolveFromNumber(null, PLATFORM_TENANT), '+14045551234');
  } finally {
    if (prev === undefined) delete process.env.TELNYX_PHONE_NUMBER; else process.env.TELNYX_PHONE_NUMBER = prev;
  }
});

test('scanForbidden catches FGA identity in an SMS body for a real tenant', () => {
  const identity = resolveIdentity(REAL_TENANT);
  const hit = scanForbidden(identity, { text: 'Thanks for reaching out! - Patrick Jenkins, First Gen Automate' });
  assert.ok(hit, 'FGA identity in a tenant SMS body must be flagged');
  const clean = scanForbidden(identity, { text: 'Thanks for your order with 923A Coins! Reply STOP to opt out.' });
  assert.strictEqual(clean, null, 'legit tenant SMS body must pass');
});
