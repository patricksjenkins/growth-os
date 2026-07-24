'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const tripwire = require('../api/middleware/cross-tenant-tripwire');

function harness(tenantId) {
  const sent = [];
  const req = {
    tenantId,
    originalUrl: '/api/leads',
    method: 'GET',
    user: { email: 'redacted@example.test' },
    ip: '127.0.0.1',
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      sent.push(body);
      return body;
    },
  };
  tripwire(req, res, () => {});
  return { req, res, sent };
}

test('matching tenant responses pass through unchanged', () => {
  const { res, sent } = harness('tenant-a');
  const body = { success: true, data: [{ tenant_id: 'tenant-a', id: 'lead-1' }] };
  res.json(body);

  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], body);
});

test('a mismatched tenant response is replaced and returns HTTP 500', () => {
  const { res, sent } = harness('tenant-a');
  res.json({ success: true, data: [{ tenant_id: 'tenant-b', id: 'lead-2' }] });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(sent[0], {
    success: false,
    error: 'Internal error: cross-tenant integrity check failed. This incident has been logged.',
  });
});

test('circular response structures can still be inspected safely', () => {
  const { res, sent } = harness('tenant-a');
  const body = { success: true, tenant_id: 'tenant-a' };
  body.self = body;
  res.json(body);

  assert.equal(res.statusCode, 200);
  assert.equal(sent[0], body);
});

test('inspection errors fail closed instead of leaking an unverified payload', () => {
  const { res, sent } = harness('tenant-a');
  const body = {};
  Object.defineProperty(body, 'danger', {
    enumerable: true,
    get() {
      throw new Error('uninspectable response');
    },
  });
  res.json(body);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(sent[0], {
    success: false,
    error: 'Internal error: tenant integrity could not be verified. This incident has been logged.',
  });
});
