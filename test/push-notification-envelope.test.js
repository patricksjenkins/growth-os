const test = require('node:test');
const assert = require('node:assert/strict');

const TENANT_ID = '30566ed6-026a-45e1-9502-029e6219df31';
const OTHER_TENANT_ID = 'bd2deab7-c870-4565-bf8d-93d6511f2d09';

const axiosPath = require.resolve('axios');
const dbClientPath = require.resolve('../db/client');
const pushPath = require.resolve('../integrations/push');

const providerCalls = [];
const deviceReads = [];

function deviceQuery() {
  const query = {
    select() { return query; },
    eq(column, value) {
      deviceReads.push([column, value]);
      return query;
    },
    then(resolve) {
      return Promise.resolve({ data: [{ token: 'ExponentPushToken[test]' }], error: null })
        .then(resolve);
    },
  };
  return query;
}

require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: {
    post: async (...args) => {
      providerCalls.push(args);
      return { data: { data: [{ status: 'ok' }] } };
    },
  },
};

require.cache[dbClientPath] = {
  id: dbClientPath,
  filename: dbClientPath,
  loaded: true,
  exports: {
    db: {
      from(table) {
        assert.equal(table, 'push_devices');
        return deviceQuery();
      },
    },
  },
};

delete require.cache[pushPath];
const { buildTenantPushData, sendPushToTenant } = require('../integrations/push');

test.beforeEach(() => {
  providerCalls.length = 0;
  deviceReads.length = 0;
});

test('central envelope preserves caller data and sets the exact recipient tenant', () => {
  assert.deepEqual(
    buildTenantPushData(TENANT_ID, {
      type: 'lead_handoff',
      lead_id: 'lead-123',
    }),
    {
      type: 'lead_handoff',
      lead_id: 'lead-123',
      recipient_tenant_id: TENANT_ID,
    },
  );
});

test('matching legacy tenant aliases remain backward compatible', () => {
  assert.deepEqual(
    buildTenantPushData(TENANT_ID, {
      tenant_id: TENANT_ID,
      tenantId: TENANT_ID,
      recipient_tenant_id: TENANT_ID,
      type: 'test',
    }),
    {
      tenant_id: TENANT_ID,
      tenantId: TENANT_ID,
      recipient_tenant_id: TENANT_ID,
      type: 'test',
    },
  );
});

for (const key of ['recipient_tenant_id', 'tenant_id', 'tenantId']) {
  test(`conflicting ${key} is rejected before a provider call`, async () => {
    await assert.rejects(
      sendPushToTenant(TENANT_ID, {
        title: 'Existing title',
        body: 'Existing body',
        data: { type: 'test', [key]: OTHER_TENANT_ID },
      }),
      (err) => err.code === 'PUSH_TENANT_CLAIM_CONFLICT',
    );
    assert.equal(deviceReads.length, 0);
    assert.equal(providerCalls.length, 0);
  });
}

test('sender preserves title, body, and provider behavior while tenant-binding data', async () => {
  const result = await sendPushToTenant(TENANT_ID, {
    title: 'Existing title',
    body: 'Existing body',
    data: { type: 'lead_handoff', lead_id: 'lead-123' },
  });

  assert.deepEqual(result, { sent: 1, failed: 0, deactivated: 0 });
  assert.deepEqual(deviceReads, [
    ['tenant_id', TENANT_ID],
    ['active', true],
  ]);
  assert.equal(providerCalls.length, 1);
  const [url, messages] = providerCalls[0];
  assert.equal(url, 'https://exp.host/--/api/v2/push/send');
  assert.equal(messages[0].title, 'Existing title');
  assert.equal(messages[0].body, 'Existing body');
  assert.deepEqual(messages[0].data, {
    type: 'lead_handoff',
    lead_id: 'lead-123',
    recipient_tenant_id: TENANT_ID,
  });
});

test('non-object push data fails closed without reading devices or calling Expo', async () => {
  await assert.rejects(
    sendPushToTenant(TENANT_ID, {
      title: 'Existing title',
      body: 'Existing body',
      data: ['not', 'an', 'object'],
    }),
    /push data must be an object/,
  );
  assert.equal(deviceReads.length, 0);
  assert.equal(providerCalls.length, 0);
});
