'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  assessWebhookReadiness,
  decideWebhookStartup,
} = require('../core/security/webhook-readiness');

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

function activeEnv() {
  return {
    STRIPE_WEBHOOK_SECRET: 'stripe-secret-sentinel',
    TELNYX_PUBLIC_KEY: 'telnyx-key-sentinel',
    RESEND_WEBHOOK_SECRET: 'resend-secret-sentinel',
    VAPI_HMAC_SECRET: 'vapi-secret-sentinel',
  };
}

function activeSignals() {
  return {
    calendly_tenant_signing_secrets: true,
  };
}

function byId(report, id) {
  return report.providers.find((provider) => provider.id === id);
}

test('classifies active and legacy providers explicitly', () => {
  const report = withStrictFlag(undefined, () =>
    assessWebhookReadiness({ env: activeEnv() }));

  assert.equal(byId(report, 'stripe').lifecycle, 'active');
  assert.equal(byId(report, 'telnyx').lifecycle, 'active');
  assert.equal(byId(report, 'resend').lifecycle, 'active');
  assert.equal(byId(report, 'calendly').lifecycle, 'legacy');
  assert.equal(byId(report, 'vapi').lifecycle, 'legacy');
  assert.equal(byId(report, 'calendly').exposure, 'public_route');
  assert.equal(byId(report, 'vapi').exposure, 'public_route');
  // The retired carrier is not listed at all — its route, handlers and
  // signature middleware were deleted, so it is not a surface to assess.
  assert.equal(byId(report, 'twilio'), undefined);
  assert.equal(report.summary.active_count, 5);
  assert.equal(report.summary.inactive_count, 0);
});

test('strict webhook enforcement defaults off and missing config is observe-only', () => {
  const report = withStrictFlag(undefined, () =>
    assessWebhookReadiness({ env: {} }));

  assert.equal(report.strict_enforcement_enabled, false);
  assert.equal(report.verification_ready, false);
  assert.equal(report.readiness_status, 'degraded');
  assert.equal(report.startup.allowed, true);
  assert.equal(report.startup.decision, 'allow_observe_only');
  assert.deepEqual(report.startup.blocking_providers, []);
  assert.equal(report.summary.missing_active_count, 5);
});

test('strict mode blocks startup when an active provider is missing verification config', () => {
  const env = activeEnv();
  delete env.TELNYX_PUBLIC_KEY;

  const report = withStrictFlag('true', () =>
    assessWebhookReadiness({ env, signals: activeSignals() }));

  assert.equal(report.strict_enforcement_enabled, true);
  assert.equal(report.startup.allowed, false);
  assert.equal(report.startup.decision, 'block');
  assert.deepEqual(report.startup.blocking_providers, ['telnyx']);
  assert.equal(byId(report, 'telnyx').blocks_startup, true);
  assert.deepEqual(
    byId(report, 'telnyx').missing_requirements,
    ['telnyx_ed25519_public_key']
  );
});

test('strict mode allows startup when every active provider is configured', () => {
  const report = withStrictFlag('true', () =>
    assessWebhookReadiness({ env: activeEnv(), signals: activeSignals() }));

  assert.equal(report.verification_ready, true);
  assert.equal(report.startup.allowed, true);
  assert.equal(report.startup.decision, 'allow');
  assert.equal(report.summary.ready_active_count, 5);
});

test('mounted legacy routes remain blocking attack surface', () => {
  const report = withStrictFlag('true', () =>
    assessWebhookReadiness({ env: activeEnv() }));

  assert.equal(byId(report, 'vapi').lifecycle, 'legacy');
  assert.equal(byId(report, 'vapi').required, true);
  // A legacy route that is still publicly mounted is still attack surface,
  // whatever we call it.
  assert.deepEqual(report.startup.blocking_providers, ['calendly']);
});

test('isolated legacy routes stop blocking strict readiness without relabeling lifecycle', () => {
  const report = withStrictFlag('true', () =>
    assessWebhookReadiness({
      env: activeEnv(),
      routeExposure: {
        calendly: false,
        vapi: true,
      },
    }));

  assert.equal(byId(report, 'calendly').lifecycle, 'legacy');
  assert.equal(byId(report, 'calendly').exposure, 'isolated_route');
  assert.equal(byId(report, 'calendly').required, false);
  assert.equal(report.startup.allowed, true);
  assert.equal(report.summary.active_count, 4);
});

test('route exposure rejects unknown providers and non-boolean state', () => {
  assert.throws(
    () => assessWebhookReadiness({ routeExposure: { telynx: false } }),
    /Unknown webhook provider id: telynx/
  );
  assert.throws(
    () => assessWebhookReadiness({ routeExposure: { calendly: 'false' } }),
    /Webhook route exposure must be boolean: calendly/
  );
  // The retired carrier is not a provider any more, so naming it is an
  // unknown-provider error rather than a silently accepted no-op.
  assert.throws(
    () => assessWebhookReadiness({ routeExposure: { twilio: false } }),
    /Unknown webhook provider id: twilio/
  );
});

test('external boolean signals can prove tenant-scoped provider readiness', () => {
  const report = withStrictFlag('true', () =>
    assessWebhookReadiness({
      env: {
        ...activeEnv(),
        VAPI_HMAC_SECRET: 'vapi-hmac-sentinel',
      },
      signals: {
        calendly_tenant_signing_secrets: true,
      },
      activeProviders: ['calendly', 'vapi'],
    }));

  assert.equal(byId(report, 'calendly').configured, true);
  assert.equal(byId(report, 'vapi').configured, true);
  assert.equal(report.startup.allowed, true);
  assert.equal(report.summary.active_count, 5);
});

test('readiness output never contains supplied secret values', () => {
  const sentinels = [
    'stripe-secret-never-output',
    'telnyx-key-never-output',
    'resend-secret-never-output',
    'vapi-secret-never-output',
  ];
  const report = withStrictFlag('true', () =>
    assessWebhookReadiness({
      env: {
        STRIPE_WEBHOOK_SECRET: sentinels[0],
        TELNYX_PUBLIC_KEY: sentinels[1],
        RESEND_WEBHOOK_SECRET: sentinels[2],
        VAPI_SERVER_SECRET: sentinels[3],
      },
    }));
  const serialized = JSON.stringify(report);

  for (const secret of sentinels) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.match(serialized, /STRIPE_WEBHOOK_SECRET/);
  assert.match(serialized, /TELNYX_PUBLIC_KEY/);
  assert.match(serialized, /RESEND_WEBHOOK_SECRET/);
});

test('startup decision helper returns the same sanitized decision', () => {
  const decision = withStrictFlag('true', () =>
    decideWebhookStartup({ env: activeEnv(), signals: activeSignals() }));

  assert.deepEqual(decision, {
    allowed: true,
    decision: 'allow',
    reason_code: 'required_webhook_verification_configured',
    blocking_providers: [],
  });
});

test('unknown provider activation is rejected so a typo cannot hide readiness state', () => {
  assert.throws(
    () => assessWebhookReadiness({ env: activeEnv(), activeProviders: ['telynx'] }),
    /Unknown webhook provider id: telynx/
  );
});
