'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('production unsubscribe tokens fail closed without private signing material', () => {
  const script = `
    delete process.env.UNSUBSCRIBE_SECRET;
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    const drip = require('./core/drip-campaign');
    try { drip.unsubscribeUrl('lead', 'prospect@example.test'); process.exit(0); }
    catch (error) { process.exit(error.message.includes('UNSUBSCRIBE_SECRET') ? 23 : 24); }
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', UNSUBSCRIBE_SECRET: '', JWT_SECRET: '' },
  });
  assert.equal(child.status, 23);
});

test('test-only fallback remains deterministic without becoming production configuration', () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorUnsubscribe = process.env.UNSUBSCRIBE_SECRET;
  const priorJwt = process.env.JWT_SECRET;
  process.env.NODE_ENV = 'test';
  delete process.env.UNSUBSCRIBE_SECRET;
  delete process.env.JWT_SECRET;
  const drip = require('../../core/drip-campaign');
  try {
    const first = drip.unsubscribeUrl('lead', 'prospect@example.test');
    const second = drip.unsubscribeUrl('lead', 'prospect@example.test');
    assert.equal(first, second);
    assert.doesNotMatch(first, /test-only-unsubscribe-secret/);
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    if (priorUnsubscribe === undefined) delete process.env.UNSUBSCRIBE_SECRET; else process.env.UNSUBSCRIBE_SECRET = priorUnsubscribe;
    if (priorJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorJwt;
  }
});
