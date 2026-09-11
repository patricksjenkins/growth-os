'use strict';

process.env.UNSUBSCRIBE_SECRET ||= 'sales-nurture-test-secret-not-production';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deterministicUuid,
  hasNurtureReplyEvidence,
  sendNurtureEmail,
  toHtml,
} = require('../../worker/agents/sales-nurture')._internal;

const tenant = {
  id: '30566ed6-026a-45e1-9502-029e6219df31',
  slug: 'fga',
  name: 'First Gen Automate',
  config: { postal_address: '123 Main Street, Atlanta, GA 30303' },
};
const lead = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'prospect@smallco.com',
  phone: null,
  name: 'Avery',
  company_name: 'Small Co',
};
const log = { info() {}, success() {}, warn() {}, error() {} };

function replyEvidenceDatabase({ rows = [], error = null } = {}) {
  const filters = [];
  return {
    filters,
    from(table) {
      assert.equal(table, 'drip_inbound');
      return {
        select() {
          const query = {
            eq(column, value) { filters.push([column, value]); return query; },
            limit() { return Promise.resolve({ data: rows, error }); },
          };
          return query;
        },
      };
    },
  };
}

function database({ recent = [], recentError = null, evidenceError = null } = {}) {
  const writes = [];
  return {
    writes,
    from(table) {
      assert.equal(table, 'conversations');
      return {
        select() {
          const query = {
            eq() { return query; },
            gte() { return query; },
            limit() { return Promise.resolve({ data: recent, error: recentError }); },
          };
          return query;
        },
        upsert(row, options) {
          writes.push({ row, options });
          return Promise.resolve({ error: evidenceError });
        },
      };
    },
  };
}

function dependencies(databaseClient, send) {
  return {
    db: databaseClient,
    sendEmail: send,
    generateEmail: async () => ({
      subject: 'A practical follow up',
      body: 'Hi Avery,\n\nCould this help your team?\n\nPatrick',
    }),
    protectedOrganizations: {},
    matchProtectedOrganization: () => ({ protected: false }),
    isSuppressed: async () => ({ suppressed: false }),
    now: () => new Date('2026-09-11T13:00:00.000Z'),
  };
}

test('sales nurture requires provider acceptance and records an idempotent delivered snapshot', async () => {
  const client = database();
  const sends = [];
  const result = await sendNurtureEmail({
    tenant,
    lead,
    intent: 'demo_followup',
    idempotencyKey: 'sales-nurture:demo:lead:week',
    log,
    dependencies: dependencies(client, async (...args) => {
      sends.push(args);
      return { status: 'sent', id: 'resend-provider-id' };
    }),
  });

  assert.equal(result.sent, true);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][3].idempotencyKey, 'sales-nurture:demo:lead:week');
  assert.match(sends[0][2], /Unsubscribe/);
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0].row.id, deterministicUuid(
    `sales-nurture:${tenant.id}:sales-nurture:demo:lead:week`,
  ));
  assert.equal(client.writes[0].row.external_id, 'resend-provider-id');
  assert.equal(client.writes[0].row.metadata.provider, 'resend');
  assert.match(client.writes[0].row.metadata.delivery_snapshot.html, /Could this help/);
  assert.deepEqual(client.writes[0].options, { onConflict: 'id' });
});

test('monthly nurture requires a routed genuine-reply receipt from the same tenant and lead', async () => {
  const absent = replyEvidenceDatabase();
  assert.equal(await hasNurtureReplyEvidence(absent, tenant.id, lead.id), false);

  const present = replyEvidenceDatabase({ rows: [{ id: 'reply-receipt' }] });
  assert.equal(await hasNurtureReplyEvidence(present, tenant.id, lead.id), true);
  assert.deepEqual(present.filters, [
    ['tenant_id', tenant.id],
    ['lead_id', lead.id],
    ['classification', 'genuine_reply'],
    ['action_taken', 'stopped_campaign'],
  ]);
});

test('monthly nurture fails closed when reply evidence is unreadable', async () => {
  const client = replyEvidenceDatabase({ error: { message: 'unavailable' } });
  await assert.rejects(
    hasNurtureReplyEvidence(client, tenant.id, lead.id),
    /nurture_reply_evidence_failed:unavailable/,
  );
});

test('sales nurture fails closed when the recent-message guard is unreadable', async () => {
  const client = database({ recentError: { message: 'database unavailable' } });
  let sends = 0;
  await assert.rejects(
    sendNurtureEmail({
      tenant,
      lead,
      intent: 'demo_followup',
      idempotencyKey: 'sales-nurture:demo:lead:week',
      log,
      dependencies: dependencies(client, async () => {
        sends += 1;
        return { status: 'sent', id: 'should-not-send' };
      }),
    }),
    /recent_message_guard_failed/,
  );
  assert.equal(sends, 0);
  assert.equal(client.writes.length, 0);
});

test('sales nurture does not claim a send without a provider id', async () => {
  const client = database();
  await assert.rejects(
    sendNurtureEmail({
      tenant,
      lead,
      intent: 'demo_followup',
      idempotencyKey: 'sales-nurture:demo:lead:week',
      log,
      dependencies: dependencies(client, async () => ({ status: 'dev_logged' })),
    }),
    /nurture_provider_acceptance_unproven/,
  );
  assert.equal(client.writes.length, 0);
});

test('sales nurture blocks protected customers before generation or send', async () => {
  const client = database();
  let generated = 0;
  let sends = 0;
  const deps = dependencies(client, async () => {
    sends += 1;
    return { status: 'sent', id: 'should-not-send' };
  });
  deps.generateEmail = async () => { generated += 1; return { subject: 'x', body: 'y' }; };
  deps.matchProtectedOrganization = () => ({ protected: true, reason: 'protected_domain' });
  const result = await sendNurtureEmail({
    tenant,
    lead,
    intent: 'demo_followup',
    idempotencyKey: 'sales-nurture:demo:lead:week',
    log,
    dependencies: deps,
  });
  assert.deepEqual(result, { skipped: true, reason: 'protected_domain' });
  assert.equal(generated, 0);
  assert.equal(sends, 0);
});

test('plain nurture copy is escaped before it enters the HTML shell', () => {
  const html = toHtml('Hi <script>alert("x")</script>\n\nThanks');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
