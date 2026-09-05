'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PIPELINE_STAGES,
  eventIdempotencyKey,
  sanitizeEvidence,
  growthEventRow,
  recordGrowthEvent,
} = require('../../core/growth/events');

test('canonical pipeline stages follow the prospect-to-revenue contract', () => {
  assert.deepEqual(PIPELINE_STAGES, [
    'discovered', 'contact_verified', 'qualified', 'drafted',
    'provider_accepted', 'delivered', 'human_reply', 'warm',
    'owner_accepted', 'demo_held', 'proposal', 'won',
  ]);
});

test('event idempotency is deterministic and tenant-bound', () => {
  const input = { tenantId: 'tenant-a', leadId: 'lead-1', eventType: 'delivered', sourceId: 'email-1' };
  assert.equal(eventIdempotencyKey(input), eventIdempotencyKey(input));
  assert.notEqual(eventIdempotencyKey(input), eventIdempotencyKey({ ...input, tenantId: 'tenant-b' }));
});

test('evidence sanitizer refuses contact content and credentials', () => {
  assert.deepEqual(sanitizeEvidence({ provider_status: 'sent', email: 'private@example.com', body_html: '<p>x</p>', api_key: 'secret', count: 1 }), {
    provider_status: 'sent', count: 1,
  });
});

test('growthEventRow produces the tenant-bound sanitized bulk-backfill contract', () => {
  const row = growthEventRow({
    tenantId: 'tenant-a', leadId: 'lead-a', eventType: 'prospect_qualified',
    stage: 'qualified', sourceSystem: 'backfill', sourceId: 'source-a',
    evidence: { score: 80, email: 'never-copy@example.com' },
  });
  assert.equal(row.tenant_id, 'tenant-a');
  assert.equal(row.lead_id, 'lead-a');
  assert.deepEqual(row.evidence, { score: 80 });
  assert.equal(row.idempotency_key, eventIdempotencyKey({
    tenantId: 'tenant-a', leadId: 'lead-a', eventType: 'prospect_qualified', sourceId: 'source-a',
  }));
});

test('recordGrowthEvent scopes the upsert to tenant plus idempotency key', async () => {
  let captured;
  const builder = {
    upsert(row, options) { captured = { row, options }; return this; },
    select() { return this; },
    maybeSingle() { return Promise.resolve({ data: { id: 'event-1', ...captured.row }, error: null }); },
  };
  const db = { from(table) { assert.equal(table, 'growth_events'); return builder; } };
  const result = await recordGrowthEvent(db, {
    tenantId: 'tenant-a', leadId: 'lead-1', eventType: 'email_delivered',
    stage: 'delivered', sourceSystem: 'resend', sourceId: 'email-1',
    evidence: { provider_status: 'delivered', recipient: 'never-store@example.com' },
  });
  assert.equal(captured.options.onConflict, 'tenant_id,idempotency_key');
  assert.equal(captured.row.tenant_id, 'tenant-a');
  assert.equal(captured.row.evidence.recipient, undefined);
  assert.equal(result.stage, 'delivered');
});

test('recordGrowthEvent fails closed for invalid stages', async () => {
  await assert.rejects(() => recordGrowthEvent({ from() {} }, {
    tenantId: 'tenant-a', eventType: 'bad', stage: 'emailed-ish', sourceSystem: 'test',
  }), /invalid_growth_stage/);
});
