/**
 * Commercial discovery — pure-logic unit tests (no DB / no network).
 * Exercises the deterministic engine pieces that gate paid work.
 */

'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');

const scoring = require('../core/commercial/scoring');
const { generateQueries } = require('../core/commercial/queries');
const { qualifyCandidate, worthDeepResearch, CLASS } = require('../core/commercial/qualify');
const { canonicalUrl, sourceTier, sourceType } = require('../core/commercial/sources');

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('scoring parity: recurring confirmed marathon scores high + Contact Now', () => {
  const i = scoring.computeIntelligence({
    profile: 'endurance', event_name: 'City Memorial Marathon', organization: 'City Run Co',
    event_date: inDays(200), date_confidence: 'confirmed', recurring: true, prior_year_date: inDays(200 - 365),
    size_tier: 'large', attendance: 6000, product_evidence: true, source_url: 'https://x', contacts: [{ email: 'a@b.com' }], notes: 'veteran memorial',
  });
  assert.ok(i.score >= 85, `score ${i.score} should be >=85`);
  assert.strictEqual(i.band, 'Contact Now');
  assert.ok(i.window.start && i.window.end);
});

test('scoring: no-date opportunity is Research Needed with no window', () => {
  const i = scoring.computeIntelligence({ profile: 'corporate', event_name: 'Sales Awards', organization: 'Acme' });
  assert.strictEqual(i.stage, 'research_needed');
  assert.strictEqual(i.window.start, null);
});

test('scoring: unknown profile is penalized', () => {
  const i = scoring.computeIntelligence({ profile: 'bogus', event_name: 'Thing' });
  assert.ok(i.score < 20);
});

test('dedupeKey vs seriesKey: same series, different years dedupe differently', () => {
  const a = { organization: 'City Run Co', event_name: 'City Marathon', event_date: '2026-10-01' };
  const b = { organization: 'City Run Co', event_name: 'City Marathon', event_date: '2027-10-01' };
  assert.notStrictEqual(scoring.dedupeKey(a), scoring.dedupeKey(b));
  assert.strictEqual(scoring.seriesKey(a), scoring.seriesKey(b));
});

test('query generation is date-aware and profile-specific', () => {
  const q = generateQueries('endurance', { cap: 5, states: ['Texas'] });
  assert.ok(q.length > 0 && q.length <= 5);
  const yr = new Date().getMonth() >= 8 ? new Date().getFullYear() + 1 : new Date().getFullYear();
  assert.ok(q.some((s) => s.includes(String(yr))));
  assert.ok(q.some((s) => /medal|marathon|race/i.test(s)));
});

test('query generation skips recently-run queries', () => {
  const first = generateQueries('sports', { cap: 3, states: ['Florida'] });
  const filtered = generateQueries('sports', { cap: 3, states: ['Florida'], recent: first });
  for (const f of filtered) assert.ok(!first.map((x) => x.toLowerCase()).includes(f.toLowerCase()));
});

test('stage-1 qualify: strong vs past vs irrelevant', () => {
  const strong = qualifyCandidate({ title: '2027 City Marathon Register', snippet: 'finisher medal sponsorship packet', link: 'https://runsignup.com/race/tx/city' }, 'endurance', 'q');
  assert.ok(strong.class === CLASS.STRONG || strong.class === CLASS.POSSIBLE);
  assert.ok(worthDeepResearch(strong.class));

  const past = qualifyCandidate({ title: '2018 Marathon Results', snippet: 'thanks to everyone, recap', link: 'https://blog.example.com/recap' }, 'endurance', 'q');
  assert.ok(!worthDeepResearch(past.class) || past.class === CLASS.SERIES);

  const irrelevant = qualifyCandidate({ title: 'Best laptops 2026', snippet: 'reviews', link: 'https://tech.example.com' }, 'endurance', 'q');
  assert.strictEqual(worthDeepResearch(irrelevant.class), false);
});

test('source tiers + canonicalization', () => {
  assert.strictEqual(sourceTier('https://runsignup.com/x'), 2);
  assert.strictEqual(sourceTier('https://yelp.com/x'), 4);
  assert.strictEqual(sourceTier('https://city.gov/events'), 1);
  assert.strictEqual(sourceType('https://facebook.com/page'), 'social');
  assert.strictEqual(canonicalUrl('https://www.Example.com/Race/?utm_source=x&id=5#top'), 'https://example.com/Race/?id=5');
});

test('discovery threshold logic: below 40 not auto-created (engine score gate)', () => {
  // A thin corporate event with no date/contact should score below the create threshold.
  const i = scoring.computeIntelligence({ profile: 'corporate', event_name: 'Untitled banquet' });
  assert.ok(i.score < 40, `score ${i.score} should be under the 40 creation threshold`);
});
