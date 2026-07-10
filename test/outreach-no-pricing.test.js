/**
 * Founder rule (2026-07-09): cold outreach never names a price. A dollar
 * figure in a first touch invites a cost objection before the value has
 * landed — soften to "14-day free trial" + "check it out at
 * firstgenautomate.com" instead.
 *
 * Enforcement is by STARVATION, not instruction: the drafting prompt used to
 * hand Claude the full price list and say "mention only if natural" — and the
 * model found it natural (live drafts said "Setup is $199, then $399/mo").
 * Now the prompt contains no dollar figures at all, so there is nothing to
 * leak. This test pins that.
 *
 * Scope: worker/agents/outreach.js only (cold first-touch email + FB DM).
 * core/fga-knowledge.js keeps real pricing — that answers INBOUND "how much?"
 * questions, where a straight answer is the honest move. The drip Day-30/60
 * briefs keep "$199 setup still applies" — that is the no-overpromise
 * disclosure on the free-month offer, a warm touch, not a cold one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const OUTREACH_AGENT = path.join(__dirname, '..', 'worker', 'agents', 'outreach.js');

test('the cold-outreach drafting agent contains no dollar figures anywhere', () => {
  const src = fs.readFileSync(OUTREACH_AGENT, 'utf8');
  const hits = [];
  src.split('\n').forEach((line, i) => {
    if (/\$\s?\d/.test(line)) hits.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  assert.deepStrictEqual(
    hits, [],
    'Cold outreach must not know prices (founder rule 2026-07-09). '
    + 'If pricing context is ever needed, it belongs in the inbound knowledge '
    + `base, not the cold drafting prompt.\nOffending lines:\n  ${hits.join('\n  ')}`,
  );
});

test('the prompt carries the softened offer instead', () => {
  const src = fs.readFileSync(OUTREACH_AGENT, 'utf8');
  assert.match(src, /14-day free trial/, 'free trial stays mentionable');
  assert.match(src, /firstgenautomate\.com/, 'website is the pricing pointer');
  assert.match(src, /NEVER include a dollar amount/i, 'the hard rule is stated to the model');
});
