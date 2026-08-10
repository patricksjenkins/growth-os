'use strict';

/**
 * The sales department collapsed from 25 sends a day to 3, and every layer
 * reported itself healthy.
 *
 * TIMELINE (2026-08-10, from the live tables)
 *   Jul 31  40 drafts, 25 passed quality, 25 sent
 *   Aug  6  40 drafts, 23 passed, 25 sent
 *   Aug  7  40 drafts, 18 passed, 25 sent
 *   Aug  8  38 drafts, 11 passed, 13 sent
 *   Aug  9  32 drafts,  3 passed,  3 sent
 *
 * Sends track the quality pass count exactly. Deliverability was fine, the
 * caps were fine, inventory was fine (48 send-ready). The failures were all
 * DETERMINISTIC — score 0, short-circuiting before the Claude judge — and
 * 100% of them were the single reason `missing_personalization`.
 *
 * ROOT CAUSE. Across the 65 rejected drafts in the 5 days to Aug 9:
 *   - 56 HAD a city on the lead record
 *   - the drafter used it 0 times
 *   - 60 of 65 opened "Hey there,"
 *
 * `worker/agents/outreach.js` did not select `city` from the leads table, so
 * the prompt never carried it — while that same prompt forbade "any place name
 * unless it is this prospect's OWN city". Telling a model not to use a value
 * it cannot see is telling it to say nothing. Meanwhile the quality gate
 * accepts the city as valid personalization, so the one field that would have
 * passed 56 of 65 drafts was withheld from the writer and demanded by the
 * grader.
 *
 * These tests execute the real gate against the real shapes. The prompt ones
 * assert on the CONTEXT THE MODEL RECEIVES, because that is the thing that was
 * wrong — no amount of testing the gate would have found this.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { deterministicDraftChecks } = require('../core/auto-outreach');

const lead = (over = {}) => ({
  id: 'lead-1', company_name: 'Alabama Junk Removal Co', name: 'Alabama Junk Removal Co',
  city: 'Cullman', hq_state: 'AL', industry: 'junk removal', ...over,
});

// The real body of a rejected draft, 2026-08-09. Names nothing.
const GENERIC_BODY = `Hey there,

You're mid-cleanout, hauling furniture out of a garage, and your phone rings.
You can't stop. By the time you're back in the truck, that caller has already
moved on to the next number on Google.

That's the spot most junk removal crews are in.`;

test('the live rejected draft is genuinely unpersonalized — the gate was right', () => {
  const problems = deterministicDraftChecks({
    sequence: { message_subject: 'Missing calls while you are on a cleanout job' },
    lead: lead(),
    bodyText: GENERIC_BODY,
    contactNames: [],
  });
  assert.ok(problems.includes('missing_personalization'),
    'this is the exact draft that was rejected 22 times a day; the gate is not the bug');
});

test('naming the city alone clears the gate — the field we had and never used', () => {
  const body = GENERIC_BODY.replace('most junk removal crews', 'most Cullman junk removal crews');
  const problems = deterministicDraftChecks({
    sequence: { message_subject: 'Missing calls on a cleanout job' },
    lead: lead(),
    bodyText: body,
    contactNames: [],
  });
  assert.ok(!problems.includes('missing_personalization'),
    'one real city name converts a rejected draft into a sendable one');
});

test('naming the company clears it too', () => {
  const body = GENERIC_BODY.replace("That's the spot", "That's the spot Alabama Junk Removal Co is in");
  const problems = deterministicDraftChecks({
    sequence: { message_subject: 's' }, lead: lead(), bodyText: body, contactNames: [],
  });
  assert.ok(!problems.includes('missing_personalization'));
});

test('a nickname is NOT the city — "DC" does not stand in for "Washington"', () => {
  // Live case: Williams Renovations LLC, city Washington, body said "in DC".
  // The check is a literal match, so the prompt must now demand the exact name.
  const problems = deterministicDraftChecks({
    sequence: { message_subject: 's' },
    lead: lead({ company_name: 'Williams Renovations LLC', name: 'Williams Renovations LLC', city: 'Washington' }),
    bodyText: "Hey there,\n\nIf you're running jobs in DC, you're probably on a roof when the phone rings.",
    contactNames: [],
  });
  assert.ok(problems.includes('missing_personalization'),
    'the writer must be told to use the exact city string, which the prompt now says');
});

test('the owner first name still clears it, as it did before', () => {
  const problems = deterministicDraftChecks({
    sequence: { message_subject: 's' },
    lead: lead({ name: 'McGarry' }),
    bodyText: 'Ryan,\n\nYou are mid-cleanout and the phone rings.',
    contactNames: ['Ryan'],
  });
  assert.ok(!problems.includes('missing_personalization'));
});

// ---------------------------------------------------------------------------
// The actual defect: what reaches the model.
// ---------------------------------------------------------------------------

const drafterSrc = fs.readFileSync(require.resolve('../worker/agents/outreach.js'), 'utf8');

test('the drafter SELECTS the city it is required to use', () => {
  const select = drafterSrc.match(/\.select\('id, company_name, industry[^']*'\)/);
  assert.ok(select, 'lead select not found — this test must be repointed, not deleted');
  assert.match(select[0], /\bcity\b/,
    'the prompt demands the prospect\'s own city; omitting it from the read is why 56 of 65 drafts named nothing');
});

test('the prompt carries the city into the business context', () => {
  assert.match(drafterSrc, /- City: \$\{lead\.city/,
    'the model cannot use a field it is not shown');
});

test('the prompt names the exact fields that satisfy the gate', () => {
  // The gate and the writer must agree on what counts as personalization.
  // They did not, and nothing connected them, so the disagreement was silent.
  assert.match(drafterSrc, /NAME THIS PROSPECT/);
  assert.match(drafterSrc, /company name[\s\S]{0,120}\$\{lead\.company_name\}/);
  assert.match(drafterSrc, /\$\{lead\.city\}/);
});

test('with no city known, the prompt tells it to name no city rather than invent one', () => {
  assert.match(drafterSrc, /their city is unknown, so name no city/,
    'a missing city must produce silence, never a plausible-sounding wrong town');
});
