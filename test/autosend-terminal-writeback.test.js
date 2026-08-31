'use strict';

/**
 * A terminal gate verdict must reach the field the selectors read.
 *
 * WHY (2026-08-30)
 * The drafter picks leads by status='new_lead', highest score first. The
 * gate blocks some of them for reasons that are PERMANENT properties of the
 * lead (email already worked under another lead, dead address, suppression).
 * recordDecision dutifully wrote that verdict to automation_status — a column
 * nothing selects on — so the lead stayed 'new_lead', stayed high-score, and
 * was re-drafted at the head of the queue every day, superseding yesterday's
 * identical doomed draft.
 *
 * Live measurement: EZ Plumbing Solutions was drafted 5 days straight
 * (Aug 25, 26, 27, 29, 30), blocked on dedupe each time. ~25 of the drafter's
 * daily slots burned on the same recurring blocked pool; fresh drafts fell
 * from 40/day to 12; sends fell with them (sends track judge-passed drafts
 * 1:1). Third occurrence of head-of-line starvation in this pipeline — the
 * lesson each time: work that cannot succeed must LEAVE the queue.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { recordDecision, TERMINAL_BLOCK_REASONS } = require('../core/auto-outreach');

function recordingDb() {
  const writes = [];
  const make = (table) => {
    const state = { table, op: null, payload: null, filters: [] };
    const api = {
      insert(p) { state.op = 'insert'; state.payload = p; writes.push(state); return thenable(); },
      update(p) { state.op = 'update'; state.payload = p; writes.push(state); return api; },
      eq(k, v) { state.filters.push([k, v]); return api; },
      then(res) { return thenable().then(res); },
    };
    const thenable = () => Promise.resolve({ data: null, error: null });
    return api;
  };
  return { from: make, writes };
}

const tenant = { id: 'fga-tenant' };
const lead = (over = {}) => ({
  id: 'lead-ez', metadata: { note: 'kept' }, status: 'new_lead', ...over,
});
const sequence = { id: 'seq-1' };

test('a dedupe block disqualifies the lead and retires its draft', async () => {
  const db = recordingDb();
  await recordDecision(db, {
    tenant, lead: lead(), sequence,
    evaluation: { decision: 'blocked', reason: 'dedupe',
      gates: { dedupe: { pass: false, detail: 'email already worked on lead-x (contacted)' } } },
    sent: false,
  });

  const leadWrites = db.writes.filter((w) => w.table === 'leads' && w.op === 'update');
  const disqualify = leadWrites.find((w) => w.payload.status === 'disqualified');
  assert.ok(disqualify, 'the lead must leave the drafter\'s selection pool');
  assert.strictEqual(disqualify.payload.metadata.disqualified_reason, 'autosend:dedupe');
  assert.strictEqual(disqualify.payload.metadata.note, 'kept', 'existing metadata survives');
  assert.ok(disqualify.filters.some(([k, v]) => k === 'status' && v === 'new_lead'),
    'guarded so a replied/won lead can never be clobbered by a stale verdict');

  const retire = db.writes.find((w) => w.table === 'outreach_sequences' && w.op === 'update');
  assert.ok(retire, 'the unsendable draft must stop counting as inventory');
  assert.strictEqual(retire.payload.sequence_status, 'superseded');
  assert.ok(retire.filters.some(([k, v]) => k === 'sequence_status' && v === 'draft'),
    'only a draft may be retired — never a sent row');
});

test('every terminal reason disqualifies; every retryable one does not', async () => {
  const retryable = ['daily_cap', 'deliverability', 'kill_switch', 'score_threshold',
    'draft_quality', 'lead_state', 'first_touch_only', 'postal_address_config'];
  for (const reason of TERMINAL_BLOCK_REASONS) {
    const db = recordingDb();
    await recordDecision(db, { tenant, lead: lead(), sequence,
      evaluation: { decision: 'blocked', reason, gates: {} }, sent: false });
    assert.ok(db.writes.some((w) => w.table === 'leads' && w.payload?.status === 'disqualified'),
      `${reason} is a permanent lead attribute and must disqualify`);
  }
  for (const reason of retryable) {
    const db = recordingDb();
    await recordDecision(db, { tenant, lead: lead(), sequence,
      evaluation: { decision: 'blocked', reason, gates: {} }, sent: false });
    assert.ok(!db.writes.some((w) => w.table === 'leads' && w.payload?.status === 'disqualified'),
      `${reason} is a circumstance of the moment and must stay retryable`);
  }
});

test('a needs_review decision never disqualifies, whatever the reason says', async () => {
  const db = recordingDb();
  await recordDecision(db, { tenant, lead: lead(), sequence,
    evaluation: { decision: 'needs_review', reason: 'valid_email', gates: {} }, sent: false });
  assert.ok(!db.writes.some((w) => w.table === 'leads' && w.payload?.status === 'disqualified'));
});

test('a sent decision never disqualifies', async () => {
  const db = recordingDb();
  await recordDecision(db, { tenant, lead: lead(), sequence,
    evaluation: { decision: 'send', reason: 'all_gates_passed', gates: {} }, sent: true });
  assert.ok(!db.writes.some((w) => w.table === 'leads' && w.payload?.status === 'disqualified'));
});

test("'disqualified' is in the approved never-cold-contact vocabulary", () => {
  const { CLOSED_STATUSES, NEVER_COLD_CONTACT } = require('../core/growth/lead-status');
  assert.ok(CLOSED_STATUSES.has('disqualified'));
  assert.ok(NEVER_COLD_CONTACT.has('disqualified'),
    'drip/suppression/bulk-send must already refuse these leads');
});

test('the drafter cannot select a disqualified lead', () => {
  // The selection filter is .eq('status','new_lead') — assert the contract
  // that makes the writeback effective, so a refactor that widens the filter
  // fails here with the history attached.
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../worker/agents/outreach.js'), 'utf8');
  assert.match(src, /\.eq\('status', 'new_lead'\)/,
    'the drafter must select only new_lead — disqualified leaves the pool via this filter');
});
