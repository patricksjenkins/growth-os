/**
 * Autosend hold-release rule (2026-07-22).
 *
 * Found live: after the quality-gate repair cleared 33 stale zero-score
 * verdicts, the dispatcher ran three windows and sent ZERO — the
 * recently-denied exclusion still held those leads on their OLD
 * needs_review decision rows, so the repaired drafts were never
 * re-evaluated. The rule is now: a held lead is released for
 * re-evaluation when its draft carries no failing cached verdict; a
 * draft that still holds a failing verdict stays held.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'auto-outreach.js'), 'utf8');

// Mirror of the filter predicate in the candidate pool.
const eligible = (draft, heldLeadIds) => {
  if (!heldLeadIds.has(draft.lead_id)) return true;
  const cached = draft.metadata?.autosend_quality;
  return !(cached && cached.ok === false);
};

test('held lead with a CLEARED verdict is released for re-evaluation', () => {
  const held = new Set(['lead-1']);
  assert.ok(eligible({ lead_id: 'lead-1', metadata: {} }, held), 'no cached verdict -> re-evaluate');
  assert.ok(eligible({ lead_id: 'lead-1', metadata: null }, held), 'null metadata -> re-evaluate');
});

test('held lead whose draft STILL has a failing verdict stays held', () => {
  const held = new Set(['lead-1']);
  assert.ok(!eligible(
    { lead_id: 'lead-1', metadata: { autosend_quality: { ok: false, score: 0 } } }, held,
  ), 'known-failing draft must not be reprocessed');
});

test('held lead whose draft was re-judged OK is eligible', () => {
  const held = new Set(['lead-1']);
  assert.ok(eligible(
    { lead_id: 'lead-1', metadata: { autosend_quality: { ok: true, score: 78 } } }, held,
  ));
});

test('never-held leads are always eligible', () => {
  assert.ok(eligible({ lead_id: 'lead-2', metadata: { autosend_quality: { ok: false } } }, new Set(['lead-1'])));
});

test('the predicate is wired into the live candidate pool', () => {
  assert.match(src, /const cached = d\.metadata\?\.autosend_quality;/);
  assert.match(src, /return !\(cached && cached\.ok === false\);/);
});
