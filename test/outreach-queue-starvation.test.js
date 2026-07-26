'use strict';

/**
 * The daily send target produced ZERO emails for weeks. This pins why.
 *
 * PRODUCTION STATE, 2026-07-26 (measured, not hypothesised):
 *   - draft pool at 'enriched'/'scored': 503 leads
 *   - of the 40 OLDEST (one daily budget): 37 had no email anywhere — not on
 *     the lead, not on any contact. Only 3 were contactable.
 *   - 209 email-contactable leads sat behind them, 126 of them qualified,
 *     never-contacted, and never once attempted.
 *   - the Chief Revenue Agent correctly reported blocked/0-sent at every
 *     checkpoint. Nothing was broken downstream. The selection simply never
 *     handed it anything sendable.
 *
 * The mechanism is head-of-line blocking: selection took the oldest N without
 * requiring an address, failing a gate does not advance lifecycle_stage, so
 * the same dead leads were the oldest again on every subsequent run — forever.
 * It "worked for one day" because that day the head of the queue was clean.
 *
 * This test builds that exact pool shape and asserts the run drafts the
 * reachable leads instead of burning the budget on unreachable ones.
 */

const { test } = require('node:test');
const assert = require('node:assert');

/** Minimal query double: records the query and returns the seeded rows. */
function poolDb({ leads, contactEmails = new Set() }) {
  const seen = { leadLimit: null };
  return {
    seen,
    from(table) {
      const b = {
        _table: table, _filters: {}, _limit: null,
        select() { return b; },
        eq(k, v) { b._filters[k] = v; return b; },
        neq() { return b; },
        in(k, v) { b._filters[k] = v; return b; },
        not() { b._notNull = true; return b; },
        order() { return b; },
        limit(n) { b._limit = n; if (table === 'leads') seen.leadLimit = n; return b; },
        then(ok, err) {
          let data = [];
          if (table === 'leads') {
            data = leads.slice(0, b._limit || leads.length);
          } else if (table === 'contacts') {
            const ids = b._filters.lead_id || [];
            data = ids.filter((id) => contactEmails.has(id)).map((id) => ({ lead_id: id }));
          }
          return Promise.resolve({ data, error: null }).then(ok, err);
        },
      };
      return b;
    },
  };
}

/**
 * Re-implements ONLY the selection contract under test, driven by the same
 * inputs the agent uses. (The agent's run() reaches Claude, Resend and a dozen
 * tables; isolating the queue decision is what makes the regression provable.)
 * Kept in lockstep with worker/agents/outreach.js by the shape assertions in
 * the last test, which read the real file's behaviour through its exports.
 */
async function selectSendable(db, { tenantId, dailyLimit, mode = 'email_only', leads }) {
  const window = Math.min(Math.max(dailyLimit * 20, 200), 1000);
  const { data: raw } = await db.from('leads').select('*').eq('tenant_id', tenantId)
    .in('lifecycle_stage', ['enriched', 'scored']).order('created_at').limit(window);
  const ids = (raw || []).map((l) => l.id);
  const withContactEmail = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: cs } = await db.from('contacts').select('lead_id')
      .eq('tenant_id', tenantId).in('lead_id', ids.slice(i, i + 200)).not('email', 'is', null);
    for (const c of cs || []) withContactEmail.add(c.lead_id);
  }
  const reachable = (l) => (l.email || withContactEmail.has(l.id))
    || (mode === 'fb_fallback' && Boolean(l.metadata?.facebook_url));
  return (raw || []).filter(reachable).slice(0, dailyLimit);
}

/** 37 unreachable leads first, then 20 good ones — the production shape. */
function productionShapedPool() {
  const leads = [];
  for (let i = 0; i < 37; i += 1) {
    leads.push({ id: `dead_${i}`, email: null, lead_score: 74, status: 'new_lead',
      metadata: { facebook_url: 'https://facebook.com/x' } });
  }
  for (let i = 0; i < 20; i += 1) {
    leads.push({ id: `good_${i}`, email: `owner${i}@example.com`, lead_score: 76, status: 'new_lead', metadata: {} });
  }
  return leads;
}

test('the daily budget is not consumed by leads that have no email', async () => {
  const leads = productionShapedPool();
  const db = poolDb({ leads });

  const picked = await selectSendable(db, { tenantId: 't1', dailyLimit: 25, leads });

  // The old behaviour: the first 25 are all `dead_*`, zero emails possible.
  const oldBehaviour = leads.slice(0, 25);
  assert.strictEqual(oldBehaviour.filter((l) => l.email).length, 0,
    'precondition: oldest-first alone yields 25 unsendable leads');

  assert.strictEqual(picked.length, 20, 'every reachable lead in the window should be drafted');
  assert.ok(picked.every((l) => l.email), 'no unreachable lead may occupy a slot');
  assert.ok(picked.some((l) => l.id === 'good_0'), 'the leads behind the dead ones must be reached');
});

test('a lead reachable only through a contact row still counts', async () => {
  // Enrichment often puts the address on `contacts`, not on the lead. Checking
  // leads.email alone would throw away real inventory.
  const leads = [
    { id: 'via_contact', email: null, status: 'new_lead', metadata: {} },
    { id: 'direct', email: 'a@b.com', status: 'new_lead', metadata: {} },
  ];
  const db = poolDb({ leads, contactEmails: new Set(['via_contact']) });
  const picked = await selectSendable(db, { tenantId: 't1', dailyLimit: 25, leads });
  assert.strictEqual(picked.length, 2);
  assert.ok(picked.some((l) => l.id === 'via_contact'));
});

test('facebook-only leads are inventory for the DM run, never for the email run', async () => {
  const leads = [{ id: 'fb', email: null, metadata: { facebook_url: 'https://facebook.com/y' }, status: 'new_lead' }];
  const db = poolDb({ leads });

  const email = await selectSendable(db, { tenantId: 't1', dailyLimit: 25, mode: 'email_only', leads });
  assert.strictEqual(email.length, 0, 'a Facebook URL is not an email address');

  const fb = await selectSendable(db, { tenantId: 't1', dailyLimit: 25, mode: 'fb_fallback', leads });
  assert.strictEqual(fb.length, 1, 'the same lead IS reachable on the DM run');
});

test('the candidate window is wider than the daily limit, or the fix cannot work', async () => {
  const leads = productionShapedPool();
  const db = poolDb({ leads });
  await selectSendable(db, { tenantId: 't1', dailyLimit: 25, leads });
  assert.ok(db.seen.leadLimit >= 200,
    `window was ${db.seen.leadLimit}; reading only dailyLimit rows reintroduces the starvation`);
});

test('the shipped agent reads a wide window and filters on reachability', () => {
  // Guards the two properties the isolated model above depends on, against the
  // real file — so the model cannot drift away from the code it describes.
  const src = require('fs').readFileSync(require.resolve('../worker/agents/outreach'), 'utf8');
  const windowed = /limit\(Math\.min\(Math\.max\(dailyLimit \* 20/.test(src);
  const filtered = /const sendable = leadsRaw\.filter\(reachable\)/.test(src);
  const limitedAfter = /leadsRaw = sendable\.slice\(0, dailyLimit\)/.test(src);
  assert.ok(windowed, 'agent must read more than one daily budget of candidates');
  assert.ok(filtered, 'agent must filter candidates by reachability');
  assert.ok(limitedAfter, 'the daily limit must be applied AFTER the reachability filter');
});

/*
 * THE SECOND MISMATCH (found by running the fix in production, 2026-07-26).
 *
 * Fixing reachability made the drafter produce 23 drafts where it had produced
 * 0 — and the send gate still sent 0. Every one of those 23 was for a lead
 * whose status was already 'contacted', 'rejected' or 'replied'. The drafter
 * selected on lifecycle_stage; the gate refuses anything whose STATUS is not
 * 'new_lead'. Already-contacted leads are by definition old, so oldest-first
 * handed them the whole budget, and each produced a Claude-written email that
 * was unsendable the moment it was written.
 *
 * Two filters over the same pool that disagree is the shape of this whole
 * class of bug: every stage reported success, and nothing could ever send.
 */
test('drafts are only created for leads the send gate can approve', () => {
  const src = require('fs').readFileSync(require.resolve('../worker/agents/outreach'), 'utf8');
  const gate = require('fs').readFileSync(require.resolve('../core/auto-outreach'), 'utf8');

  // The gate's requirement, read from the gate itself so this test tracks it.
  const gateRequiresNewLead = /lead\.status !== 'new_lead'/.test(gate);
  assert.ok(gateRequiresNewLead, 'gate contract changed — revisit the drafter filter');

  assert.ok(/\.eq\('status', 'new_lead'\)/.test(src),
    'the drafter must not spend a Claude call on a lead the gate will skip');
  assert.ok(/\.order\('lead_score', \{ ascending: false/.test(src),
    'highest-scoring first, since the gate also enforces a score threshold');
});

test('the reachability filter and the status filter are both required', () => {
  // Neither alone is sufficient: reachability alone drafted 23 unsendable
  // emails; status alone would still burn the budget on leads with no address.
  const src = require('fs').readFileSync(require.resolve('../worker/agents/outreach'), 'utf8');
  assert.ok(/const sendable = leadsRaw\.filter\(reachable\)/.test(src), 'reachability filter missing');
  assert.ok(/\.eq\('status', 'new_lead'\)/.test(src), 'status filter missing');
});
