'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  enqueueFgaScoringHandoffs,
  enqueueFgaOutreachHandoffs,
  draftInventoryDays,
  draftInventoryTarget,
  queuedDraftCapacity,
  readFgaDraftSupply,
} = require('../../core/growth/handoffs');

function fakeClient({ sequences = [], drafts = [], jobs = [], config = [], usage = [], readError = null } = {}) {
  const inserts = [];
  return {
    inserts,
    from(table) {
      const builder = {
        columns: '',
        select(columns) { this.columns = String(columns || ''); return this; },
        eq() { return this; },
        in() { return this; },
        gte() { return this; },
        lt() { return this; },
        limit() { return this; },
        insert(rows) {
          inserts.push({ table, rows });
          return Promise.resolve({ error: null });
        },
        then(resolve) {
          const data = table === 'outreach_sequences'
            ? (builder.columns.includes('created_at') ? drafts : sequences)
            : table === 'agent_jobs' ? jobs
              : table === 'tenant_config' ? config
                : table === 'ai_usage_events' ? usage
              : [];
          resolve({ data, count: table === 'ai_usage_events' ? usage.length : null, error: readError });
        },
      };
      return builder;
    },
  };
}

test('FGA scoring handoff queues one durable exact-lead job per unique prospect', async () => {
  const client = fakeClient();
  const result = await enqueueFgaScoringHandoffs(
    client,
    FGA_TENANT_ID,
    ['lead-1', 'lead-1', 'lead-2'],
    { source: 'evidence_recovery_handoff' },
  );
  assert.deepStrictEqual(result, { queued: 2, skipped: 0 });
  assert.equal(client.inserts.length, 1);
  assert.deepStrictEqual(client.inserts[0].rows.map((row) => row.payload), [
    { lead_id: 'lead-1', source: 'evidence_recovery_handoff' },
    { lead_id: 'lead-2', source: 'evidence_recovery_handoff' },
  ]);
});

test('FGA outreach handoff is idempotent and remains email-only with provider dispatch disconnected', async () => {
  const client = fakeClient({
    sequences: [{ lead_id: 'lead-sequenced' }],
    jobs: [{ payload: { lead_id: 'lead-queued' } }],
  });
  const result = await enqueueFgaOutreachHandoffs(
    client,
    FGA_TENANT_ID,
    ['lead-new', 'lead-sequenced', 'lead-queued'],
  );
  assert.deepStrictEqual(result, {
    queued: 1,
    skipped: 2,
    inventory_target: 50,
    actionable_drafts: 0,
    queued_draft_capacity: 1,
    deferred_for_capacity: 0,
  });
  const inserted = client.inserts[0].rows;
  assert.equal(inserted.length, 1);
  assert.deepStrictEqual(inserted[0].payload, {
    lead_id: 'lead-new',
    limit: 1,
    mode: 'email_only',
    skip_send_handoff: true,
    source: 'scoring_handoff',
  });
});

test('FGA outreach handoffs maintain two days of draft inventory instead of amplifying every score', async () => {
  const drafts = Array.from({ length: 49 }, (_, i) => ({
    id: `draft-${i}`,
    sequence_status: 'draft',
    metadata: {},
    created_at: new Date().toISOString(),
  }));
  const client = fakeClient({
    drafts,
    jobs: [{ payload: { lead_id: 'already-queued', limit: 1 } }],
  });
  const result = await enqueueFgaOutreachHandoffs(
    client,
    FGA_TENANT_ID,
    ['lead-1', 'lead-2'],
  );
  assert.deepStrictEqual(result, {
    queued: 0,
    skipped: 2,
    inventory_target: 50,
    actionable_drafts: 49,
    queued_draft_capacity: 1,
    deferred_for_capacity: 2,
  });
  assert.equal(client.inserts.length, 0);
});

test('draft inventory limits are bounded and account for batch jobs without counting Facebook fallback', () => {
  assert.equal(draftInventoryDays(undefined), 2);
  assert.equal(draftInventoryDays('0'), 1);
  assert.equal(draftInventoryDays('99'), 7);
  assert.equal(draftInventoryDays('bad'), 2);
  assert.equal(draftInventoryTarget(25), 50);
  assert.equal(draftInventoryTarget(40, '3'), 120);
  assert.equal(queuedDraftCapacity([
    { payload: { lead_id: 'one', limit: 50 } },
    { payload: { limit: 12 } },
    { payload: { mode: 'fb_fallback', limit: 100 } },
  ]), 13);
});

test('exact-FGA provider-backed supply work is held when draft inventory is sufficient', async () => {
  const drafts = Array.from({ length: 49 }, (_, i) => ({
    id: `draft-${i}`,
    sequence_status: 'draft',
    metadata: {},
    created_at: new Date().toISOString(),
  }));
  const supply = await readFgaDraftSupply(fakeClient({
    drafts,
    jobs: [{ payload: { lead_id: 'already-queued' } }],
  }), FGA_TENANT_ID);
  assert.equal(supply.applicable, true);
  assert.equal(supply.available, true);
  assert.equal(supply.hold, true);
  assert.equal(supply.reason, 'draft_inventory_sufficient');
  assert.equal(supply.actionable_drafts, 49);
  assert.equal(supply.queued_draft_capacity, 1);
  assert.equal(supply.committed_draft_supply, 50);
  assert.equal(supply.draft_inventory_target, 50);
  assert.equal(supply.draft_inventory_days, 2);
  assert.equal(supply.daily_send_target, 25);
  assert.equal(supply.daily_target_source, 'default');
  assert.equal(supply.resource_budget.exhausted, false);
  assert.equal(supply.resource_budget.calls_used, 0);
});

test('exact-FGA speculative supply is held at its daily provider-call ceiling', async () => {
  const usage = Array.from({ length: 200 }, () => ({ estimated_cost_usd: 0 }));
  const supply = await readFgaDraftSupply(fakeClient({ usage }), FGA_TENANT_ID);
  assert.equal(supply.available, true);
  assert.equal(supply.hold, true);
  assert.equal(supply.reason, 'supply_call_budget_exhausted');
  assert.equal(supply.resource_budget.calls_used, 200);
  assert.equal(supply.resource_budget.calls_cap, 200);
  assert.equal(supply.resource_budget.remaining_calls, 0);
});

test('exact-FGA supply work fails closed on an unverified inventory while customers bypass the policy', async () => {
  const unavailable = await readFgaDraftSupply(
    fakeClient({ readError: { message: 'read unavailable' } }),
    FGA_TENANT_ID,
  );
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.hold, true);
  assert.equal(unavailable.reason, 'supply_usage_unverified');

  const customer = await readFgaDraftSupply(fakeClient(), 'customer-tenant');
  assert.deepStrictEqual(customer, {
    applicable: false,
    available: true,
    hold: false,
    reason: 'customer_tenant_unchanged',
  });
});

test('research handoffs leave customer tenants completely unchanged', async () => {
  const client = fakeClient();
  const scoring = await enqueueFgaScoringHandoffs(client, 'customer-tenant', ['lead-1']);
  const outreach = await enqueueFgaOutreachHandoffs(client, 'customer-tenant', ['lead-1']);
  assert.deepStrictEqual(scoring, { queued: 0, skipped: 1, reason: 'customer_tenant_unchanged' });
  assert.deepStrictEqual(outreach, { queued: 0, skipped: 1, reason: 'customer_tenant_unchanged' });
  assert.equal(client.inserts.length, 0);
});

test('outreach handoff fails closed when current sequence or job ownership cannot be read', async () => {
  const client = fakeClient({ readError: { message: 'read unavailable' } });
  await assert.rejects(
    enqueueFgaOutreachHandoffs(client, FGA_TENANT_ID, ['lead-1']),
    /outreach_handoff_(sequence|job)_read_failed/,
  );
  assert.equal(client.inserts.length, 0);
});
