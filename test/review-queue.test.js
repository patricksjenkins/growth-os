/**
 * Review Queue guards (2026-07-24).
 *
 * The bug this queue fixes was not a rendering bug — it was an ALIGNMENT bug.
 * The dashboard counted held drafts one way, the page it linked to listed
 * them another way (or not at all), and Patrick was left reconciling by hand:
 * "I click the 7 outreach drafts need manual review... now I have to go
 * hunting for these 7."
 *
 * These tests pin the three properties that stop it recurring:
 *   1. count and list share ONE predicate (they cannot drift apart)
 *   2. approving is tenant-scoped and re-validated server-side
 *   3. bulk sends are capped (a real email per row — no runaway keystroke)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const QUEUE_SRC = path.join(__dirname, '..', 'core', 'growth', 'review-queue.js');
const ROUTE_SRC = path.join(__dirname, '..', 'api', 'routes', 'admin-review-queue.js');
const ADMIN_SRC = path.join(__dirname, '..', 'api', 'routes', 'admin.js');
const AGENT_SRC = path.join(__dirname, '..', 'worker', 'agents', 'auto-outreach.js');

const queueSrc = fs.readFileSync(QUEUE_SRC, 'utf8');
const routeSrc = fs.readFileSync(ROUTE_SRC, 'utf8');
const adminSrc = fs.readFileSync(ADMIN_SRC, 'utf8');
const agentSrc = fs.readFileSync(AGENT_SRC, 'utf8');

const { listReviewableDrafts, countReviewableDrafts, explainHold } = require('../core/growth/review-queue');

// --- Fake Supabase builder: enough to exercise the predicate end to end. ---
function fakeDb(tables) {
  const make = (rows) => {
    const b = {
      _rows: rows,
      select() { return b; },
      eq(col, val) { b._rows = b._rows.filter((r) => r[col] === val); return b; },
      in(col, vals) { b._rows = b._rows.filter((r) => vals.includes(r[col])); return b; },
      order(col, { ascending = true } = {}) {
        b._rows = [...b._rows].sort((x, y) =>
          ascending ? String(x[col]).localeCompare(String(y[col])) : String(y[col]).localeCompare(String(x[col])));
        return b;
      },
      limit(n) { b._rows = b._rows.slice(0, n); return b; },
      then(res) { return Promise.resolve({ data: b._rows, error: null }).then(res); },
    };
    return b;
  };
  return { from: (t) => make((tables[t] || []).map((r) => ({ ...r }))) };
}

const FGA = process.env.FGA_TENANT_ID || require('../core/config').FGA_TENANT_ID;

function fixture() {
  return {
    outreach_sequences: [
      // reviewable: email draft, lead is new_lead
      { id: 's1', tenant_id: FGA, lead_id: 'L1', sequence_type: 'email', sequence_status: 'draft', message_subject: 'Hi', message_body: '<p>Body one</p>', created_at: '2026-07-22' },
      // second draft on the SAME lead — must collapse into one row
      { id: 's2', tenant_id: FGA, lead_id: 'L1', sequence_type: 'email', sequence_status: 'draft', message_subject: 'Old', message_body: 'old', created_at: '2026-07-01' },
      // excluded: facebook_dm channel
      { id: 's3', tenant_id: FGA, lead_id: 'L2', sequence_type: 'facebook_dm', sequence_status: 'draft', message_subject: 'FB', message_body: 'fb', created_at: '2026-07-20' },
      // excluded: lead already contacted
      { id: 's4', tenant_id: FGA, lead_id: 'L3', sequence_type: 'email', sequence_status: 'draft', message_subject: 'X', message_body: 'x', created_at: '2026-07-20' },
      // excluded: already sent
      { id: 's5', tenant_id: FGA, lead_id: 'L4', sequence_type: 'email', sequence_status: 'sent', message_subject: 'S', message_body: 's', created_at: '2026-07-20' },
      // excluded: another tenant
      { id: 's6', tenant_id: 'other-tenant', lead_id: 'L5', sequence_type: 'email', sequence_status: 'draft', message_subject: 'Nope', message_body: 'nope', created_at: '2026-07-22' },
    ],
    leads: [
      { id: 'L1', tenant_id: FGA, status: 'new_lead', company_name: 'Acme', name: 'Ann', email: 'a@acme.com', lead_score: 70 },
      { id: 'L2', tenant_id: FGA, status: 'new_lead', company_name: 'FB Co', email: 'b@fb.com' },
      { id: 'L3', tenant_id: FGA, status: 'contacted', company_name: 'Worked', email: 'c@w.com' },
      { id: 'L4', tenant_id: FGA, status: 'new_lead', company_name: 'Sent Co', email: 'd@s.com' },
      { id: 'L5', tenant_id: 'other-tenant', status: 'new_lead', company_name: 'Other', email: 'e@o.com' },
    ],
    autosend_decisions: [
      { tenant_id: FGA, lead_id: 'L1', sequence_id: 's1', decision: 'needs_review', reason: 'draft_quality', quality: { score: 64 }, created_at: '2026-07-22' },
    ],
  };
}

test('the predicate excludes everything that is not Patrick’s decision', async () => {
  const items = await listReviewableDrafts(fakeDb(fixture()));
  assert.strictEqual(items.length, 1, 'only the new_lead email draft is reviewable');
  const it = items[0];
  assert.strictEqual(it.company, 'Acme');
  assert.strictEqual(it.sequence_id, 's1', 'the NEWEST draft is the one shown');
  assert.strictEqual(it.older_drafts, 1, 'the superseded draft is counted, not shown');
  assert.strictEqual(it.body, 'Body one', 'body is readable text, not HTML');
  assert.strictEqual(it.quality_score, 64);
  assert.strictEqual(it.sendable, true);
});

test('count and list can never disagree — they are the same query', async () => {
  const db = fakeDb(fixture());
  const list = await listReviewableDrafts(db);
  const { count } = await countReviewableDrafts(fakeDb(fixture()));
  assert.strictEqual(count, list.length,
    'the dashboard alert count and the queue page must always match');
});

test('the dashboard count helper delegates to the shared predicate', () => {
  assert.match(adminSrc, /countReviewableDrafts.*require\('\.\.\/\.\.\/core\/growth\/review-queue'\)/s,
    'admin.js must not re-implement the predicate');
  assert.match(adminSrc, /const countNewLeadEmailDrafts = countReviewableDrafts/,
    'the old local implementation must be gone, not merely unused');
});

test('the alert links to the queue, not to a page you have to search', () => {
  assert.match(adminSrc, /action_link: '\/admin\/review'/,
    'the pending-drafts attention item must deep-link to the Review Queue');
  assert.ok(!/action_label: 'Review Drafts',\s*\n\s*action_link: '\/admin\/pipeline'/.test(adminSrc),
    'the old dead-end link to /admin/pipeline must be gone');
});

test('per-run attention snapshots are gone (they piled up and went stale)', () => {
  assert.ok(!/type: 'autosend_review_queue'/.test(agentSrc),
    'auto-outreach must not raise per-run review-queue rows — five stale counts accumulated in Needs Attention');
});

test('approve is tenant-scoped and re-validated against the live queue', () => {
  assert.match(routeSrc, /listReviewableDrafts/,
    'approve must re-derive the queue server-side');
  assert.match(routeSrc, /allowed\.get\(sequenceId\)/,
    'a sequence_id not currently in the queue must be refused');
  assert.match(routeSrc, /not_in_queue/, 'refusal is explicit, not silent');
  assert.ok(!/req\.query\.tenant|'all'/.test(routeSrc), 'no cross-tenant escape hatch');
});

test('bulk actions are capped — one row is one real email', () => {
  assert.match(routeSrc, /const MAX_BULK = (\d+)/);
  const cap = Number(routeSrc.match(/const MAX_BULK = (\d+)/)[1]);
  assert.ok(cap > 0 && cap <= 50, `MAX_BULK should be a sane ceiling, got ${cap}`);
  const guards = routeSrc.match(/items\.length > MAX_BULK/g) || [];
  assert.strictEqual(guards.length, 2, 'both approve and reject enforce the cap');
});

test('approve routes through the shared send choke point (atomic claim)', () => {
  assert.match(routeSrc, /sendEmailOutreachSequence/,
    'must reuse the send helper whose draft->sending claim prevents double sends');
  assert.ok(!/from\('outreach_sequences'\)[\s\S]{0,200}resend|new Resend/i.test(routeSrc),
    'must not hand-roll its own send path');
});

test('hold reasons are explained in plain English, not gate names', () => {
  assert.strictEqual(explainHold({ reason: 'draft_quality', quality: { score: 62 } }).label, 'Draft quality');
  assert.match(explainHold({ reason: 'draft_quality', quality: { score: 62 } }).detail, /62 out of 100/);
  assert.strictEqual(explainHold(null).code, 'not_evaluated');
  assert.strictEqual(explainHold({ reason: 'score_threshold' }).label, 'Low lead score');
});

test('every queue read is explicitly limited (PostgREST caps unbounded selects)', () => {
  const fromCount = (queueSrc.match(/\.from\('/g) || []).length;
  const limitCount = (queueSrc.match(/\.limit\(/g) || []).length;
  assert.ok(limitCount >= fromCount,
    `every read needs an explicit .limit() (found ${fromCount} reads, ${limitCount} limits)`);
});
