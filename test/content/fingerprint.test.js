/**
 * Content fingerprint + repetition control — pure-logic unit tests.
 */
'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');
const fp = require('../../core/content/fingerprint');

test('detects overused themes from concept text', () => {
  const a = fp.computeFingerprint({ audience_problem: 'you missed the call and the competitor won', hook: 'They Googled. They chose someone else.' });
  assert.ok(a.theme_tags.includes('missed_call'));
  assert.ok(a.theme_tags.includes('competitor'));
});

test('flags the banned two-clause echo headline pattern', () => {
  const a = fp.computeFingerprint({ hook: 'It rang. You missed it.' });
  assert.strictEqual(a.hook_pattern, 'two_clause');
});

test('identical fingerprints score ~1, orthogonal ones score low', () => {
  const a = fp.computeFingerprint({ objective: 'Educate', audience_problem: 'missed call costs', hook: 'You missed the call.', format_id: 5 });
  const b = fp.computeFingerprint({ objective: 'Build Trust', audience_problem: 'too many tools to manage', hook: 'One system handles the overhead.', format_id: 2 });
  assert.ok(fp.similarityScore(a, a) > 0.95);
  assert.ok(fp.similarityScore(a, b) < 0.4);
});

test('checkRepetition rejects a near-duplicate above threshold', () => {
  const base = { objective: 'Educate', module_theme: 'Speed-to-Lead', is_module_post: true, evidence_kind: 'stat', evidence_ref: { stat_id: '78pct' }, angle: 'Workflow Walkthrough', format_id: 3 };
  const a = fp.computeFingerprint({ ...base, audience_problem: 'slow response loses jobs' });
  const recent = [fp.computeFingerprint({ ...base, audience_problem: 'slow response loses the job' })];
  const r = fp.checkRepetition(a, recent, { threshold: 0.82 });
  assert.strictEqual(r.reject, true);
  assert.ok(r.warnings.length > 0);
});

test('detectOveruse warns when an overused theme recurs', () => {
  const cand = fp.computeFingerprint({ hook: 'You missed the call.' });
  const recent = [fp.computeFingerprint({ hook: 'Another missed call this week.' })];
  const warnings = fp.detectOveruse(cand, recent);
  assert.ok(warnings.some((w) => /missed_call/.test(w)));
});
