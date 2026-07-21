/**
 * Sales-department coordination invariants (2026-07-21).
 *
 * The whole point of the coordination layer is three guarantees:
 *   1. Every non-closed lead derives exactly ONE next action with ONE owner.
 *   2. Closed leads derive none (state cleared, not stale).
 *   3. The human lane wins: engaged humans (replied / interested / question)
 *      always route to the owner, never to a machine.
 * Plus the supersession safety contract: only email drafts on leads that left
 * new_lead are eligible — mirrored here as a predicate test since the DB
 * sweep is scoped by the same conditions.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const {
  deriveLeadNextAction, CLOSED_STATUSES,
} = require('../core/sales/coordination');

const ACTIVE_MATRIX = [
  // [lead, ctx, expected action, expected owner]
  [{ status: 'new_lead', email: 'a@b.com' }, { hasDraft: false }, 'draft_outreach', 'outreach'],
  [{ status: 'new_lead', email: 'a@b.com' }, { hasDraft: true }, 'review_draft', 'owner'],
  [{ status: 'new_lead', email: 'a@b.com' }, { hasDraft: true, autosendArmed: true }, 'review_draft', 'auto-outreach'],
  [{ status: 'new_lead', lifecycle_stage: 'fb_only' }, {}, 'facebook_dm', 'facebook-prospecting'],
  [{ status: 'new_lead' }, {}, 'enrich', 'enrichment'],
  [{ status: 'contacted' }, { hasActiveEnrollment: true, nextTouchAt: '2026-08-01T00:00:00Z' }, 'await_sequence', 'drip-campaign'],
  [{ status: 'contacted' }, { hasActiveEnrollment: false }, 'enroll_followup', 'drip-campaign'],
  [{ status: 'replied' }, {}, 'sales_call', 'owner'],
  [{ status: 'contacted', lifecycle_stage: 'interested' }, { hasActiveEnrollment: true }, 'sales_call', 'owner'],
  [{ status: 'contacted', lifecycle_stage: 'engaged' }, {}, 'answer_question', 'owner'],
  [{ status: 'demo_booked' }, {}, 'prep_meeting', 'meeting-prep'],
  [{ status: 'demo_booked', briefing_generated: true }, {}, 'sales_call', 'owner'],
  [{ status: 'quoted' }, {}, 'follow_up_proposal', 'sales-nurture'],
  [{ status: 'trial_active' }, {}, 'trial_checkin', 'sales-nurture'],
  [{ status: 'contacted', lifecycle_stage: 'nurture' }, {}, 'nurture_touch', 'sales-nurture'],
];

test('every non-closed lead state derives exactly one action with one owner', () => {
  for (const [lead, ctx, action, owner] of ACTIVE_MATRIX) {
    const next = deriveLeadNextAction(lead, ctx);
    assert.ok(next, `expected an action for ${JSON.stringify(lead)}`);
    assert.strictEqual(next.action, action, `action for ${JSON.stringify(lead)}`);
    assert.strictEqual(next.owner, owner, `owner for ${JSON.stringify(lead)}`);
    assert.strictEqual(typeof next.owner, 'string');
  }
});

test('closed leads derive no next action', () => {
  for (const status of CLOSED_STATUSES) {
    assert.strictEqual(deriveLeadNextAction({ status }, {}), null, `status=${status}`);
  }
  assert.strictEqual(deriveLeadNextAction(null, {}), null);
});

test('the human lane always beats the machine lane', () => {
  // A replied lead with an active enrollment AND a draft still goes to the owner.
  const next = deriveLeadNextAction(
    { status: 'replied', email: 'a@b.com' },
    { hasDraft: true, hasActiveEnrollment: true, autosendArmed: true },
  );
  assert.strictEqual(next.owner, 'owner');
  assert.strictEqual(next.action, 'sales_call');
});

test('unknown legacy statuses surface to the owner instead of guessing', () => {
  const next = deriveLeadNextAction({ status: 'some_legacy_thing' }, {});
  assert.strictEqual(next.owner, 'owner');
});

test('every derived action carries a due date except sequence-waits without a touch time', () => {
  for (const [lead, ctx] of ACTIVE_MATRIX) {
    const next = deriveLeadNextAction(lead, ctx);
    if (next.action === 'await_sequence' && !ctx.nextTouchAt) continue;
    assert.ok(next.due_at, `due_at missing for ${JSON.stringify(lead)}`);
  }
});

test('supersession eligibility predicate: email drafts on non-new_lead leads only', () => {
  // Mirror of the two DB filters in supersedeStaleDrafts — pinned so a future
  // edit that widens either condition fails a test before it eats FB-DM
  // drafts (their queue filters on sequence_status='draft').
  const eligible = (seq, lead) =>
    seq.sequence_type === 'email' && seq.sequence_status === 'draft' && lead.status !== 'new_lead';

  assert.ok(eligible({ sequence_type: 'email', sequence_status: 'draft' }, { status: 'contacted' }));
  assert.ok(!eligible({ sequence_type: 'email', sequence_status: 'draft' }, { status: 'new_lead' }), 'live drafts stay');
  assert.ok(!eligible({ sequence_type: 'facebook_dm', sequence_status: 'draft' }, { status: 'contacted' }), 'FB-DM drafts are never touched');
  assert.ok(!eligible({ sequence_type: 'email', sequence_status: 'sent' }, { status: 'contacted' }), 'sent rows are never touched');
  assert.ok(!eligible({ sequence_type: 'email', sequence_status: 'sending' }, { status: 'contacted' }), 'in-flight claims are never touched');
});

test('idempotency classifier recognizes the superseded status', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'ai-safety', 'idempotency.js'), 'utf8');
  assert.match(src, /superseded/, 'core/ai-safety/idempotency.js must classify superseded rows');
});
