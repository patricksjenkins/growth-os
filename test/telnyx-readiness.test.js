'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasTelnyxMessaging,
  telnyxMessagingReadiness,
  tenantTelnyxNumber,
} = require('../core/telnyx-readiness');

const CLIENT = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'client',
  config: {},
  integrations: {},
};

test('a real tenant never inherits the platform Telnyx number', () => {
  const env = {
    TELNYX_API_KEY: 'test-key',
    TELNYX_PHONE_NUMBER: '+14045550101',
  };
  assert.equal(tenantTelnyxNumber(CLIENT, env), null);
  assert.equal(hasTelnyxMessaging(CLIENT, env), false);
});

test('canonical Telnyx integration and tenant config are supported', () => {
  const env = { TELNYX_API_KEY: 'test-key' };
  const integrationTenant = {
    ...CLIENT,
    integrations: {
      telnyx: {
        status: 'active',
        config: { phone_number: '+17195550101' },
      },
    },
  };
  const configTenant = {
    ...CLIENT,
    config: { telnyx_phone_number: '+17195550102' },
  };

  assert.equal(hasTelnyxMessaging(integrationTenant, env), true);
  assert.equal(hasTelnyxMessaging(configTenant, env), true);
});

test('an explicitly identified platform tenant may use the injected platform number', () => {
  const tenant = {
    ...CLIENT,
    id: '22222222-2222-4222-8222-222222222222',
    slug: 'platform-company',
  };
  const env = {
    FGA_TENANT_ID: tenant.id,
    TELNYX_API_KEY: 'test-key',
    TELNYX_PHONE_NUMBER: '+17195550104',
  };

  assert.equal(tenantTelnyxNumber(tenant, env), '+17195550104');
  assert.equal(hasTelnyxMessaging(tenant, env), true);
});

test('legacy Twilio rows cannot authorize a new Telnyx send', () => {
  const result = telnyxMessagingReadiness({
    ...CLIENT,
    integrations: {
      twilio: {
        status: 'active',
        credentials: { account_sid: 'legacy' },
        config: { phone_number: '+17195550103' },
      },
    },
  }, { TELNYX_API_KEY: 'test-key' });

  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, ['tenant_telnyx_number_missing']);
  assert.equal(JSON.stringify(result).includes('legacy'), false);
});

test('readiness reports capability names but never credentials', () => {
  const sentinel = 'never-output-this-key';
  const result = telnyxMessagingReadiness(CLIENT, {
    TELNYX_API_KEY: sentinel,
  });

  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(result.provider, 'telnyx');
});
