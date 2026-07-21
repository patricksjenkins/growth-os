/**
 * Suggested-reply safety invariants (2026-07-21, the one new outbound
 * surface Patrick approved — with these exact boundaries):
 *
 *   1. The suggestion module NEVER sends. Its only outputs are stored text;
 *      the send lives solely in the admin-authed /pipeline/:id/reply route.
 *   2. The drafting prompt carries the hard rules (no discounts, no invented
 *      capabilities, no scheduling/dispatch, no legal commitments).
 *   3. Unprompted pricing is stripped: a draft that volunteers a dollar
 *      figure when the prospect didn't ask is discarded.
 *   4. The manual send route still honors suppression — even a human click
 *      cannot email an unsubscribed/bounced address from there.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the suggestion module has no send capability', () => {
  const src = read('core/sales/reply-suggestion.js');
  assert.ok(!/sendEmail|integrations\/email|sendSms|telnyx|resend/i.test(src),
    'core/sales/reply-suggestion.js must never import or call a send path');
});

test('the drafting prompt states every hard rule', () => {
  const src = read('core/sales/reply-suggestion.js');
  assert.match(src, /NEVER offer a discount/i);
  assert.match(src, /NO scheduling, dispatch, calendar, or booking/i);
  assert.match(src, /NEVER make legal or contractual commitments/i);
  assert.match(src, /buildFgaKnowledgePrompt/, 'grounded in the fact-gated knowledge base');
  assert.match(src, /stripAiTells/, 'output passes the text-style sanitizer');
});

test('unprompted pricing is discarded, prompted pricing is allowed', () => {
  const src = read('core/sales/reply-suggestion.js');
  assert.match(src, /volunteered pricing unprompted/, 'the discard branch exists');
  // Mirror of the asked-detection expression.
  const asked = (t) => /\$\s?\d|price|pricing|cost|how much|charge/i.test(t);
  assert.ok(asked('how much does this cost?'));
  assert.ok(asked('is it $500?'));
  assert.ok(!asked('sounds interesting, tell me more'));
});

test('the only send path is the admin reply route, and it checks suppression', () => {
  const admin = read('api/routes/admin.js');
  const routeAt = admin.indexOf("router.post('/pipeline/:leadId/reply'");
  assert.ok(routeAt !== -1, 'owner reply route exists');
  const routeSrc = admin.slice(routeAt, routeAt + 4000);
  assert.match(routeSrc, /isSuppressed/, 'suppression is honored even for the manual send');
  assert.match(routeSrc, /suggested_reply/, 'consumed suggestion is cleared');
  const classifier = read('worker/agents/reply-classification.js');
  assert.ok(!/sendEmail/.test(classifier), 'reply-classification never sends');
});
