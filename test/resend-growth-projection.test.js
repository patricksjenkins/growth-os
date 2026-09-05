'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function database(spec) {
  return {
    from(table) {
      const state = { table, op: 'select' };
      const builder = {
        select() { return builder; },
        insert() { state.op = 'insert'; return builder; },
        upsert() { state.op = 'upsert'; return builder; },
        update() { state.op = 'update'; return builder; },
        eq() { return builder; },
        contains() { return builder; },
        limit() { return builder; },
        maybeSingle() { return builder; },
        then(resolve, reject) {
          const value = typeof spec[table] === 'function' ? spec[table](state) : spec[table];
          return Promise.resolve(value || { data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

async function postWebhook(spec) {
  const dbPath = require.resolve('../db/client');
  const routePath = require.resolve('../api/webhooks/resend');
  const savedDb = require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { getServiceClient: () => database(spec) },
  };
  delete require.cache[routePath];
  const priorSecret = process.env.RESEND_WEBHOOK_SECRET;
  delete process.env.RESEND_WEBHOOK_SECRET;
  try {
    const app = express();
    app.use(express.json());
    app.use('/webhook', require('../api/webhooks/resend'));
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': 'event-a' },
      body: JSON.stringify({
        type: 'email.delivered', created_at: '2026-09-05T12:00:00Z',
        data: { email_id: 'provider-email-a', to: ['prospect@example.test'] },
      }),
    });
    const body = await response.json();
    server.close();
    return { status: response.status, body };
  } finally {
    if (priorSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = priorSecret;
    if (savedDb) require.cache[dbPath] = savedDb;
    else delete require.cache[dbPath];
    delete require.cache[routePath];
  }
}

test('a durable provider event still returns 500 when canonical growth projection fails', async () => {
  const result = await postWebhook({
    email_events: { data: null, error: null },
    drip_sends: { data: { lead_id: 'lead-a' }, error: null },
    growth_events: { data: null, error: { message: 'ledger unavailable' } },
  });
  assert.equal(result.status, 500, 'non-2xx is required so the provider retries projection');
  assert.equal(result.body.ok, false);
});

test('a correlated delivery returns 200 only after the canonical event is written', async () => {
  const result = await postWebhook({
    email_events: { data: null, error: null },
    drip_sends: { data: { lead_id: 'lead-a' }, error: null },
    growth_events: { data: { id: 'growth-event-a' }, error: null },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});
