'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  _internal: { projectCanonicalAppointment },
} = require('../api/webhooks/calendly');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const LEAD_ID = '22222222-2222-4222-8222-222222222222';
const APPOINTMENT_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const URI = 'https://api.calendly.com/scheduled_events/fixture-1';

function withProjectionFlags(fn) {
  const values = {
    FGA_OS_SCHEDULING_WRITES_ENABLED: 'true',
    FGA_OS_STRICT_WEBHOOK_VERIFICATION: 'true',
    FGA_OS_SCHEDULING_TENANT_ALLOWLIST: TENANT_ID,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map(key => [key, process.env[key]])
  );
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('canonical projection is invisible while any safety gate is absent', async () => {
  const client = {
    rpc() {
      throw new Error('disabled projection must not call the database');
    },
  };
  assert.deepEqual(await projectCanonicalAppointment({
    client,
    tenantId: TENANT_ID,
    eventType: 'invitee.created',
    payload: {},
  }), { mode: 'disabled' });
});

test('verified and allowlisted booking projects a PII-free typed receipt', async () => {
  await withProjectionFlags(async () => {
    let rpcArgs;
    const client = {
      async rpc(name, args) {
        assert.equal(name, 'appointment_provider_event_rpc');
        rpcArgs = args;
        return {
          data: {
            outcome: 'scheduled',
            appointment: {
              id: APPOINTMENT_ID,
              tenant_id: TENANT_ID,
              provider: 'calendly',
              provider_event_id: URI,
              status: 'scheduled',
            },
            event: {
              id: EVENT_ID,
              tenant_id: TENANT_ID,
              appointment_id: APPOINTMENT_ID,
            },
          },
          error: null,
        };
      },
    };
    const result = await projectCanonicalAppointment({
      client,
      tenantId: TENANT_ID,
      eventType: 'invitee.created',
      leadId: LEAD_ID,
      payload: {
        invitee: {
          name: 'Must not enter RPC',
          email: 'must-not-enter-rpc@example.test',
        },
        event: {
          uri: URI,
          start_time: '2026-07-25T18:00:00.000Z',
          end_time: '2026-07-25T18:30:00.000Z',
        },
      },
    });

    assert.deepEqual(result, {
      mode: 'canonical',
      outcome: 'scheduled',
      appointment_id: APPOINTMENT_ID,
    });
    assert.equal(rpcArgs.p_tenant_id, TENANT_ID);
    assert.equal(rpcArgs.p_lead_id, LEAD_ID);
    assert.equal(rpcArgs.p_feature_gate_enabled, true);
    assert.equal(JSON.stringify(rpcArgs).includes('Must not enter RPC'), false);
    assert.equal(JSON.stringify(rpcArgs).includes('must-not-enter-rpc@example.test'), false);
  });
});

test('malformed RPC success fails closed', async () => {
  await withProjectionFlags(async () => {
    const client = {
      async rpc() {
        return { data: { outcome: 'scheduled' }, error: null };
      },
    };
    await assert.rejects(
      projectCanonicalAppointment({
        client,
        tenantId: TENANT_ID,
        eventType: 'invitee.created',
        payload: {
          event: {
            uri: URI,
            start_time: '2026-07-25T18:00:00.000Z',
            end_time: '2026-07-25T18:30:00.000Z',
          },
        },
      }),
      /calendly_projection_result_invalid/
    );
  });
});
