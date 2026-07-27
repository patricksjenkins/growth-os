'use strict';

/**
 * The send drill-down endpoint, executed.
 *
 * WHY (Codex 2026-07-27): the feature shipped with no endpoint test, and the
 * bug that reached Patrick — the frontend reading the wrong level of the
 * response — would have been caught by asserting the payload's SHAPE here.
 *
 * So this pins the contract the UI depends on:
 *   - `sends` is a TOP-LEVEL array, not nested under `data`
 *   - its length equals the headline count for that day
 *   - the delivered snapshot is preferred over the pre-assembly draft copy
 *   - a failed enrichment read is reported, never silently blanked
 */

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const FGA = '30566ed6-026a-45e1-9502-029e6219df31';

/** Programmable Supabase double, mirroring the real thenable builder. */
function db(spec) {
  return {
    from(table) {
      const st = { table, filters: {} };
      const b = {
        select() { return b; },
        eq(k, v) { st.filters[k] = v; return b; },
        gte() { return b; }, lt() { return b; }, lte() { return b; },
        in(k, v) { st.filters[k] = v; return b; },
        not() { return b; }, is() { return b; }, filter() { return b; },
        order() { return b; }, limit() { return b; },
        maybeSingle() { return b; }, single() { return b; },
        then(ok, err) {
          const h = spec[table];
          const out = typeof h === 'function' ? h(st) : (h || { data: [], error: null });
          return Promise.resolve(out).then(ok, err);
        },
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

/** Mount the real router with a stubbed client and call it over HTTP. */
async function callEndpoint(spec, query = '') {
  const dbPath = require.resolve('../db/client');
  const routePath = require.resolve('../api/routes/admin-revenue-outcome');
  const savedDb = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { getServiceClient: () => db(spec) } };
  delete require.cache[routePath];
  try {
    const app = express();
    app.use('/x', require('../api/routes/admin-revenue-outcome'));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/x/sends${query}`);
    const body = await res.json();
    server.close();
    return { status: res.status, body };
  } finally {
    if (savedDb) require.cache[dbPath] = savedDb; else delete require.cache[dbPath];
    delete require.cache[routePath];
  }
}

/** One accepted send in the ledger, shaped like the real activity_log row. */
const sendRow = (over = {}) => ({
  entity_id: 'lead-1',
  created_at: '2026-07-26T18:00:00.000Z',
  metadata: {
    provider_id: 'resend-abc',
    sequence_id: 'seq-1',
    recipient: 'owner@example.com',
    sent_at: '2026-07-26T18:00:00.000Z',
    channel: 'email',
    ...over,
  },
});

/**
 * countFirstTouchSends does not trust metadata: it verifies each candidate
 * against the sequence record AND the gate ledger, and reads prior days to
 * establish first touch. A fixture that skips any of those counts zero — which
 * is the point, so these tests exercise the real verification rather than
 * bypassing it.
 */
function ledger({ today = [sendRow()], sequences, decisions, leads, seqError, leadError } = {}) {
  let activityCall = 0;
  return {
    activity_log: () => {
      activityCall += 1;
      // 1st call = today's window, 2nd = prior history (empty => first touch).
      return { data: activityCall === 1 ? today : [], error: null };
    },
    autosend_decisions: { data: decisions ?? [{ lead_id: 'lead-1', sequence_id: 'seq-1', decision: 'sent' }], error: null },
    outreach_sequences: seqError
      ? { data: null, error: seqError }
      : { data: sequences ?? [{
          id: 'seq-1', lead_id: 'lead-1', sequence_type: 'email', sequence_status: 'sent',
          message_subject: 'Subj', message_body: 'Copy', metadata: {},
        }], error: null },
    leads: leadError
      ? { data: null, error: leadError }
      : { data: leads ?? [{ id: 'lead-1', company_name: 'Acme Plumbing', email: 'owner@example.com' }], error: null },
  };
}

test('sends is a TOP-LEVEL array — the shape the UI reads', async () => {
  // The original bug: the frontend read res.data.sends. If this payload ever
  // gains a `data` envelope, the UI silently renders "no sends" again.
  const { status, body } = await callEndpoint(ledger(), '?date=2026-07-26');

  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.sends), 'sends must be a top-level array');
  assert.strictEqual(body.data, undefined, 'no data envelope — the UI reads res.sends');
  assert.strictEqual(body.count, body.sends.length, 'count must match the list it describes');
});

test('the delivered snapshot wins over the pre-assembly draft copy', async () => {
  // message_body is the copy BEFORE the signature, shell, CTA, unsubscribe and
  // postal footer are added at send time. Showing it as "what was sent" claims
  // more fidelity than it has.
  const { body } = await callEndpoint(ledger({
    sequences: [{
      id: 'seq-1', lead_id: 'lead-1', sequence_type: 'email', sequence_status: 'sent',
      message_subject: 'Draft subject',
      message_body: 'draft copy only',
      metadata: { delivered: {
        subject: 'Delivered subject',
        html: '<html>full assembled email with unsubscribe</html>',
        includes: { signature: true, shell: true, unsubscribe: true, postal_address: true },
      } },
    }],
  }), '?date=2026-07-26');

  const s = body.sends[0];
  assert.strictEqual(s.body_source, 'delivered');
  assert.match(s.body, /unsubscribe/);
  assert.strictEqual(s.subject, 'Delivered subject');
  assert.strictEqual(s.delivered_includes.unsubscribe, true);
});

test('an older send with no snapshot is LABELLED as draft copy, not passed off as sent', async () => {
  const { body } = await callEndpoint(ledger(), '?date=2026-07-26');

  const s = body.sends[0];
  assert.strictEqual(s.body_source, 'draft_copy');
  assert.strictEqual(s.body_is_html, false);
  assert.strictEqual(s.body_available, true);
});

test('a failed enrichment read is reported, not rendered as blanks', async () => {
  // The VERIFICATION read of outreach_sequences must still succeed (otherwise
  // the count itself is unverifiable); this simulates the ENRICHMENT reads
  // failing, which is the case that used to render blanks.
  const { status, body } = await callEndpoint({
    ...ledger(),
    leads: { data: null, error: { message: 'connection reset' } },
  }, '?date=2026-07-26');

  assert.strictEqual(status, 200, 'the count is still authoritative');
  assert.strictEqual(body.count, 1, 'the send itself is real and must still be listed');
  assert.ok(Array.isArray(body.detail_incomplete), 'the failure must be stated');
  assert.match(body.detail_incomplete.join(' '), /connection reset/);
});

test('a day with no sends returns an empty list, not an error', async () => {
  const { status, body } = await callEndpoint(ledger({ today: [] }), '?date=2026-07-20');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.sends, []);
});

test('a malformed date falls back to today rather than throwing', async () => {
  const { status, body } = await callEndpoint(ledger({ today: [] }), '?date=not-a-date');
  assert.strictEqual(status, 200);
  assert.match(body.date, /^\d{4}-\d{2}-\d{2}$/);
});
