/**
 * Draft personalization gate (2026-07-21 fix).
 *
 * 116 drafts had piled up in needs_review. The cause was NOT bad drafts: the
 * personalization check read only lead.name / company_name / city, while the
 * drafting agent greets the enriched OWNER by first name from the `contacts`
 * table. On prospected leads, lead.name is usually the company itself
 * ("Moore Plumbing and Heating LLC") or a surname ("McGarry"), so a draft
 * opening "Ryan," or "Linda," — the strongest personalization we have —
 * scored ZERO and was parked forever.
 *
 * These tests pin BOTH directions: contact-name greetings pass, and genuinely
 * generic "Hey there" drafts still fail. A gate that passes everything is
 * worse than the bug it replaced.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const { deterministicDraftChecks: checks } = require('../core/auto-outreach');

const BODY_TAIL = 'We set up and manage the system so calls get answered. '
  + 'Open to a 15-minute call this week? Talk soon, Patrick Jenkins, Founder.';

const run = (body, lead, contactNames = []) =>
  checks({
    sequence: { message_subject: 'Quick question about missed calls' },
    lead,
    bodyText: body,
    contactNames,
  });

test('a draft greeting the enriched owner by first name PASSES personalization', () => {
  // The exact live shape that was failing: lead.name is the company.
  const problems = run(
    `Ryan, you are under a sink and the phone rings. ${BODY_TAIL}`,
    { name: 'Moore Plumbing and Heating LLC', company_name: 'Moore Plumbing and Heating LLC', city: 'Massachusetts' },
    ['Ryan'],
  );
  assert.ok(!problems.includes('missing_personalization'), `unexpected: ${problems.join(', ')}`);
});

test('surname-style lead.name with a real contact first name PASSES', () => {
  const problems = run(
    `Linda, you are mid-job with the caddy on the counter. ${BODY_TAIL}`,
    { name: 'McGarry', company_name: 'McGarry Cleaning Services, LLC', city: 'Ambler' },
    ['Linda'],
  );
  assert.ok(!problems.includes('missing_personalization'));
});

test('a genuinely generic draft STILL fails — the gate must keep discriminating', () => {
  const problems = run(
    `Hey there, Monday mornings are the busiest call window. ${BODY_TAIL}`,
    { name: 'Chippewa Valley Electrical Solutions', company_name: 'Chippewa Valley Electrical Solutions', city: 'Eau Claire' },
    [],
  );
  assert.ok(problems.includes('missing_personalization'), 'generic drafts must still be held');
});

test('a generic draft is not rescued by an UNUSED contact name', () => {
  const problems = run(
    `Hey there, you are mid-job and the phone rings. ${BODY_TAIL}`,
    { name: 'Western Plumbing LLC', company_name: 'Western Plumbing LLC', city: 'Indianapolis' },
    ['Dave'], // enriched, but the draft never uses it
    );
  assert.ok(problems.includes('missing_personalization'), 'the NAME must appear in the body, not merely exist');
});

test('company token or city still personalize, as before', () => {
  assert.ok(!run(`Your team at Jenson Electric handles panel work. ${BODY_TAIL}`,
    { name: 'x', company_name: 'Jenson Electric LLC', city: 'Johnston' }).includes('missing_personalization'));
  assert.ok(!run(`Plenty of Johnston homeowners call after hours. ${BODY_TAIL}`,
    { name: 'x', company_name: 'Q', city: 'Johnston' }).includes('missing_personalization'));
});

test('"we install" is still banned — and the drafting prompt no longer teaches it', () => {
  const problems = run(`Mike, we install a system for shops like yours. ${BODY_TAIL}`,
    { name: 'Mike Jenson', company_name: 'Jenson Electric LLC', city: 'Johnston' }, ['Mike']);
  assert.ok(problems.some((p) => p.startsWith('banned_phrase:we install')), 'gate still bans it');

  const fs = require('node:fs');
  const path = require('node:path');
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'outreach.js'), 'utf8');
  assert.ok(!/We install a done-for-you/i.test(prompt),
    'the drafting prompt must not contain the phrase its own quality gate rejects');
});

test('the scoring agent window covers leads that were drafted before scoring ran', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'scoring.js'), 'utf8');
  assert.match(src, /'sequenced'/, "must include 'sequenced' or drafted leads can never be scored");
  assert.match(src, /'stale'/, "must include 'stale'");
});
