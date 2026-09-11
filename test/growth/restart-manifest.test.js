'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { FGA_TENANT_ID } = require('../../core/config');
const manifest = require('../../core/growth/restart-manifest');

function chain(value) {
  const target = {};
  for (const method of ['eq', 'not', 'is', 'in', 'order', 'limit', 'range', 'select', 'lte']) {
    target[method] = () => target;
  }
  target.maybeSingle = async () => value;
  target.single = async () => value;
  target.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject);
  return target;
}

test('restart manifest summaries contain policy counts but no contact data', () => {
  const summary = manifest.summarizeDecisions([
    { decision: 'eligible', reason: 'fresh_qualified_prospect' },
    { decision: 'eligible', reason: 'dormant_qualified_prospect' },
    { decision: 'needs_evidence', reason: 'email_missing' },
    { decision: 'excluded', reason: 'matches_customer' },
  ]);
  assert.deepEqual(summary.by_decision, { eligible: 2, needs_evidence: 1, excluded: 1 });
  assert.equal(summary.by_reason.matches_customer, 1);
  assert.equal(summary.tenant_scope, 'FGA_ONLY');
  assert.equal(summary.contains_contact_data, false);
  assert.equal(summary.sends_messages, false);
});

test('manifest persistence hides a partial batch until all exact-FGA candidates exist', async () => {
  const operations = [];
  const db = {
    from(table) {
      return {
        insert(payload) {
          operations.push({ table, action: 'insert', payload });
          if (table === 'growth_restart_batches') {
            return { select: () => ({ single: async () => ({ data: { id: 'batch-new' }, error: null }) }) };
          }
          return Promise.resolve({ error: null });
        },
        update(payload) {
          operations.push({ table, action: 'update', payload });
          return chain({ data: { id: 'batch-new', status: payload.status }, error: null });
        },
      };
    },
  };
  const decisions = [
    { lead_id: 'lead-a', decision: 'eligible', reason: 'fresh_qualified_prospect', evidence: {} },
    { lead_id: 'lead-b', decision: 'excluded', reason: 'matches_customer', evidence: {} },
  ];
  const result = await manifest.persistFgaRestartManifest(db, {
    decisions,
    summary: manifest.summarizeDecisions(decisions),
    status: 'completed',
    createdBy: 'growth-restart',
    supersedesBatchId: 'batch-old',
  });

  assert.equal(result.candidateCount, 2);
  assert.equal(operations[0].payload.status, 'draft');
  assert.ok(operations[1].payload.every((row) => row.tenant_id === FGA_TENANT_ID));
  assert.equal(operations.at(-1).payload.status, 'completed');
  assert.ok(operations.findIndex((op) => op.table === 'growth_restart_candidates')
    < operations.findIndex((op) => op.action === 'update' && op.payload.status === 'completed'));
});

function rotationDb({
  remaining = 0,
  pending = 0,
  leaseError = null,
  leaseErrors = null,
  leaseExpiresAt = new Date(Date.now() + 60_000).toISOString(),
  latest = ['batch-old'],
} = {}) {
  const inserts = [];
  let batchRead = 0;
  let candidateRead = 0;
  let leaseAttempt = 0;
  return {
    inserts,
    from(table) {
      if (table === 'growth_restart_batches') {
        return {
          select() {
            const id = latest[Math.min(batchRead++, latest.length - 1)];
            return chain({ data: id ? { id, status: 'completed' } : null, error: null });
          },
        };
      }
      if (table === 'growth_restart_candidates') {
        return {
          select() {
            const count = candidateRead++ === 0 ? remaining : pending;
            return chain({ count, error: null });
          },
        };
      }
      if (table === 'idempotency_keys') {
        return {
          insert(payload) {
            inserts.push(payload);
            const error = Array.isArray(leaseErrors)
              ? leaseErrors[Math.min(leaseAttempt++, leaseErrors.length - 1)]
              : leaseError;
            return Promise.resolve({ error });
          },
          select() {
            return chain({
              data: { expires_at: leaseExpiresAt, result: { state: 'planning' } },
              error: null,
            });
          },
          update() { return chain({ error: null }); },
          delete() { return chain({ data: { id: 'lease' }, error: null }); },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

test('rotation creates one replacement only after exhaustion and no unconsumed authorization', async () => {
  const db = rotationDb();
  let persistedOptions = null;
  const result = await manifest.rotateFgaRestartManifest(db, {
    exhaustedBatchId: 'batch-old',
    buildManifest: async () => ({
      decisions: [{ lead_id: 'lead-a', decision: 'eligible', reason: 'fresh_qualified_prospect', evidence: {} }],
      summary: { leads_examined: 1, by_decision: { eligible: 1 }, sends_messages: false },
    }),
    persistManifest: async (_db, options) => {
      persistedOptions = options;
      return { batch: { id: 'batch-new', status: 'completed' }, candidateCount: 1 };
    },
  });

  assert.equal(result.rotated, true);
  assert.equal(result.reason, 'replacement_manifest_created');
  assert.equal(persistedOptions.status, 'completed');
  assert.equal(persistedOptions.supersedesBatchId, 'batch-old');
  assert.equal(db.inserts.length, 1);
  assert.equal(db.inserts[0].tenant_id, FGA_TENANT_ID);
  assert.equal(db.inserts[0].action, manifest.ROTATION_ACTION);
});

test('rotation refuses a non-exhausted manifest and deduplicates a concurrent winner', async () => {
  const notExhausted = rotationDb({ remaining: 3 });
  const held = await manifest.rotateFgaRestartManifest(notExhausted, { exhaustedBatchId: 'batch-old' });
  assert.deepEqual(held, { rotated: false, reason: 'manifest_not_exhausted', remaining: 3 });
  assert.equal(notExhausted.inserts.length, 0);

  const raced = rotationDb({
    leaseError: { code: '23505', message: 'duplicate key' },
    latest: ['batch-old', 'batch-new'],
  });
  const wonElsewhere = await manifest.rotateFgaRestartManifest(raced, { exhaustedBatchId: 'batch-old' });
  assert.equal(wonElsewhere.rotated, true);
  assert.equal(wonElsewhere.reason, 'rotation_already_claimed');
  assert.equal(wonElsewhere.batch.id, 'batch-new');
});

test('an active rotation lease waits, while an expired lease is reclaimed once', async () => {
  const duplicate = { code: '23505', message: 'duplicate key' };
  const active = rotationDb({ leaseError: duplicate });
  const waiting = await manifest.rotateFgaRestartManifest(active, { exhaustedBatchId: 'batch-old' });
  assert.equal(waiting.rotated, false);
  assert.equal(waiting.reason, 'rotation_in_progress');

  const expired = rotationDb({
    leaseErrors: [duplicate, null],
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  let persisted = 0;
  const recovered = await manifest.rotateFgaRestartManifest(expired, {
    exhaustedBatchId: 'batch-old',
    buildManifest: async () => ({
      decisions: [{ lead_id: 'lead-a', decision: 'eligible', reason: 'fresh_qualified_prospect', evidence: {} }],
      summary: { leads_examined: 1, by_decision: { eligible: 1 }, sends_messages: false },
    }),
    persistManifest: async () => {
      persisted += 1;
      return { batch: { id: 'batch-new', status: 'completed' }, candidateCount: 1 };
    },
  });
  assert.equal(recovered.rotated, true);
  assert.equal(persisted, 1);
  assert.equal(expired.inserts.length, 2);
});

test('rotation code is exact-FGA, provider-disconnected, and used by both planner and agent', () => {
  const source = fs.readFileSync(require.resolve('../../core/growth/restart-manifest'), 'utf8');
  const planner = fs.readFileSync(require.resolve('../../scripts/plan-fga-prospect-restart'), 'utf8');
  const agent = fs.readFileSync(require.resolve('../../worker/agents/growth-restart'), 'utf8');
  assert.match(source, /tenant_id', FGA_TENANT_ID/);
  assert.match(source, /idempotency_keys/);
  assert.doesNotMatch(source, /resend[.]emails|sendEmail|telnyx|twilio/i);
  assert.match(planner, /buildFgaRestartManifest/);
  assert.match(agent, /rotateFgaRestartManifest/);
});
