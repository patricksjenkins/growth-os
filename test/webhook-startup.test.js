'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  WebhookStartupReadinessError,
  enforceWebhookStartupReadiness,
} = require('../core/security/webhook-startup');

const STRICT_FLAG = 'FGA_OS_STRICT_WEBHOOK_VERIFICATION';

function withStrictFlag(value, fn) {
  const saved = process.env[STRICT_FLAG];
  try {
    if (value === undefined) delete process.env[STRICT_FLAG];
    else process.env[STRICT_FLAG] = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env[STRICT_FLAG];
    else process.env[STRICT_FLAG] = saved;
  }
}

function readyEnv() {
  return {
    STRIPE_WEBHOOK_SECRET: 'stripe-secret-never-log',
    TELNYX_PUBLIC_KEY: 'telnyx-key-never-log',
    RESEND_WEBHOOK_SECRET: 'resend-secret-never-log',
    VAPI_HMAC_SECRET: 'vapi-secret-never-log',
  };
}

function readySignals() {
  return {
    calendly_tenant_signing_secrets: true,

  };
}

function captureLogger() {
  const entries = [];
  return {
    entries,
    info(message, data) {
      entries.push({ level: 'info', message, data });
    },
    warn(message, data) {
      entries.push({ level: 'warn', message, data });
    },
  };
}

test('default-off enforcement preserves startup and logs degraded readiness', () => {
  const logger = captureLogger();
  const readiness = withStrictFlag(undefined, () =>
    enforceWebhookStartupReadiness({ env: {}, logger }));

  assert.equal(readiness.strict_enforcement_enabled, false);
  assert.equal(readiness.startup.allowed, true);
  assert.equal(readiness.startup.decision, 'allow_observe_only');
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].level, 'warn');
  assert.equal(logger.entries[0].data.summary.missing_active_count, 5);
});

test('strict enforcement throws before startup when active verification is missing', () => {
  const logger = captureLogger();
  const env = readyEnv();
  delete env.TELNYX_PUBLIC_KEY;

  assert.throws(
    () => withStrictFlag('true', () =>
      enforceWebhookStartupReadiness({ env, signals: readySignals(), logger })),
    (error) => {
      assert.ok(error instanceof WebhookStartupReadinessError);
      assert.equal(error.code, 'strict_webhook_verification_missing_config');
      assert.deepEqual(error.readiness.startup.blocking_providers, ['telnyx']);
      assert.equal(error.readiness.startup.allowed, false);
      return true;
    }
  );
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].level, 'warn');
  assert.equal(logger.entries[0].data.startup.decision, 'block');
});

test('strict enforcement allows startup when all active providers are ready', () => {
  const logger = captureLogger();
  const readiness = withStrictFlag('true', () =>
    enforceWebhookStartupReadiness({ env: readyEnv(), signals: readySignals(), logger }));

  assert.equal(readiness.startup.allowed, true);
  assert.equal(readiness.startup.decision, 'allow');
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].level, 'info');
});

test('startup logs and errors contain no supplied verification values', () => {
  const logger = captureLogger();
  const env = readyEnv();
  delete env.RESEND_WEBHOOK_SECRET;

  let caught;
  try {
    withStrictFlag('true', () =>
      enforceWebhookStartupReadiness({ env, signals: readySignals(), logger }));
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof WebhookStartupReadinessError);
  const serialized = JSON.stringify({ entries: logger.entries, error: caught });
  for (const secret of Object.values(readyEnv())) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /resend_svix_signing_secret/);
});

test('server enforces readiness before opening its listener', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'server.js'),
    'utf8'
  );
  const enforcement = source.indexOf('enforceWebhookStartupReadiness({');
  const listen = source.indexOf('app.listen(PORT');

  assert.ok(enforcement >= 0, 'server must invoke the readiness guard');
  assert.ok(listen >= 0, 'server must open its listener');
  assert.ok(enforcement < listen, 'readiness guard must run before listen');
});
