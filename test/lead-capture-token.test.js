'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOrigin,
  signLeadCaptureToken,
  verifyLeadCaptureToken,
} = require('../core/security/lead-capture-token');

const SECRET = 'test-secret-that-is-not-used-outside-fixtures';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-07-24T12:00:00.000Z');

test('capture token binds an immutable tenant and normalized site origin', () => {
  const token = signLeadCaptureToken({
    tenantId: TENANT_A,
    origin: 'https://Example.com/contact?source=test',
    siteId: 'site-a',
    now: NOW,
  }, SECRET);

  const decision = verifyLeadCaptureToken(token, {
    tenantId: TENANT_A,
    origin: 'https://example.com/another/path',
    siteId: 'site-a',
    now: NOW,
  }, SECRET);

  assert.equal(decision.valid, true);
  assert.equal(decision.claims.tenantId, TENANT_A);
  assert.equal(decision.claims.origin, 'https://example.com');
  assert.equal(decision.claims.siteId, 'site-a');
  assert.equal(decision.claims.keyId, 'v1');
  assert.ok(decision.claims.expiresAt > decision.claims.issuedAt);
});

test('capture token cannot be replayed for another tenant or origin', () => {
  const token = signLeadCaptureToken({
    tenantId: TENANT_A,
    origin: 'https://tenant-a.example',
    siteId: 'site-a',
    now: NOW,
  }, SECRET);

  assert.equal(verifyLeadCaptureToken(token, {
    tenantId: TENANT_B,
    origin: 'https://tenant-a.example',
    siteId: 'site-a',
    now: NOW,
  }, SECRET).valid, false);
  assert.equal(verifyLeadCaptureToken(token, {
    tenantId: TENANT_A,
    origin: 'https://tenant-b.example',
    siteId: 'site-a',
    now: NOW,
  }, SECRET).valid, false);
  assert.equal(verifyLeadCaptureToken(token, {
    tenantId: TENANT_A,
    origin: 'https://tenant-a.example',
    siteId: 'site-b',
    now: NOW,
  }, SECRET).valid, false);
});

test('capture token expires and key rotation invalidates old tokens', () => {
  const token = signLeadCaptureToken({
    tenantId: TENANT_A,
    origin: 'https://tenant-a.example',
    siteId: 'site-a',
    keyId: '2026-07',
    now: NOW,
    expiresInSeconds: 60,
  }, SECRET);

  assert.equal(verifyLeadCaptureToken(token, {
    tenantId: TENANT_A,
    origin: 'https://tenant-a.example',
    siteId: 'site-a',
    expectedKeyId: '2026-07',
    now: NOW + 59_000,
  }, SECRET).valid, true);
  assert.equal(verifyLeadCaptureToken(token, {
    tenantId: TENANT_A,
    origin: 'https://tenant-a.example',
    siteId: 'site-a',
    expectedKeyId: '2026-07',
    now: NOW + 60_000,
  }, SECRET).reason, 'expired');
  assert.equal(verifyLeadCaptureToken(token, {
    tenantId: TENANT_A,
    origin: 'https://tenant-a.example',
    siteId: 'site-a',
    expectedKeyId: '2026-08',
    now: NOW,
  }, SECRET).reason, 'binding');
});

test('missing secret or malformed token always fails closed', () => {
  assert.equal(verifyLeadCaptureToken('bad', {
    tenantId: TENANT_A,
    origin: 'https://tenant-a.example',
    siteId: 'site-a',
  }, null).valid, false);
  assert.equal(normalizeOrigin('not a url'), null);
});
