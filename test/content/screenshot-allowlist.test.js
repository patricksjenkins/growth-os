/**
 * Screenshot capture allowlist — host + tenant guards (security-critical).
 */
'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');
const capture = require('../../core/content/screenshot-capture');

test('only allowlisted hosts are permitted', () => {
  assert.strictEqual(capture.hostAllowed('https://firstgenautomate.com/pricing'), true);
  assert.strictEqual(capture.hostAllowed('https://www.firstgenautomate.com/'), true);
  assert.strictEqual(capture.hostAllowed('https://evil.example.com/'), false);
  assert.strictEqual(capture.hostAllowed('not a url'), false);
});

test('tenant-scoped URLs only allow FGA / approved demo tenants', () => {
  assert.strictEqual(capture.tenantAllowed('https://firstgenautomate.com/'), true); // not tenant-scoped
  assert.strictEqual(capture.tenantAllowed('https://firstgenautomate.com/?tenant=00000000-0000-0000-0000-000000000000'), false);
});
