'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CREATIVE_VERSION,
  VARIANTS,
  assignMessageExperiment,
  validateConversationDraft,
  buildConversationFallback,
} = require('../../core/growth/message-experiment');
const { scoreDraftQuality } = require('../../core/auto-outreach');
const { FGA_TENANT_ID } = require('../../core/config');

function stubDb(responses = {}) {
  return {
    from(table) {
      const builder = {};
      for (const method of ['select', 'eq', 'order', 'limit', 'update']) builder[method] = () => builder;
      builder.then = (resolve) => resolve(responses[table] || { data: null, error: null });
      return builder;
    },
  };
}

test('conversation experiment assignment is deterministic and exercises every hypothesis', () => {
  const assignments = Array.from({ length: 120 }, (_, index) =>
    assignMessageExperiment({ id: `lead-${index}`, company_name: `Company ${index}` }));
  assert.deepEqual(assignments[17], assignMessageExperiment({ id: 'lead-17' }));
  assert.deepEqual(new Set(assignments.map((item) => item.variant)), new Set(VARIANTS.map((item) => item.key)));
  for (const assignment of assignments) {
    assert.equal(assignment.creative_version, CREATIVE_VERSION);
    assert.equal(assignment.experiment_key, `${CREATIVE_VERSION}:${assignment.variant}`);
    assert.match(assignment.prompt, /only CTA/i);
    assert.doesNotMatch(assignment.prompt, /book a demo|schedule a meeting|we noticed|we saw you miss/i);
  }
});

test('conversation draft contract admits one short operational question', () => {
  const body = [
    'I came across Northstar Electric while looking at small businesses around Albany.',
    'First Gen Automate can set up an immediate text response after a captured web inquiry or missed call, so the first acknowledgment does not depend on someone being free right away.',
    'When a new inquiry comes in while everyone is busy, does it get an automatic first response or wait for a person to become available?',
  ].join('\n\n');
  const result = validateConversationDraft({ subject: 'How Northstar handles inquiries', body });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.question_count, 1);
  assert.ok(result.body_words >= 55 && result.body_words <= 90);
});

test('conversation draft contract blocks old pitch shape and premature conversion asks', () => {
  const result = validateConversationDraft({
    subject: 'A very long subject line about your sales automation process',
    body: 'I would love to book a demo. Does Tuesday work? Or Wednesday?',
  });
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes('subject_word_count'));
  assert.ok(result.problems.includes('body_word_count'));
  assert.ok(result.problems.includes('single_question_required'));
  assert.ok(result.problems.includes('premature_conversion_cta'));
});

test('every deterministic fallback is personalized and satisfies the send contract', () => {
  for (const variant of VARIANTS) {
    const draft = buildConversationFallback({
      lead: { company_name: 'Northstar Electric', city: 'Albany', industry: 'Electrical' },
      contactName: 'Maria Rodriguez',
      experiment: { variant: variant.key },
    });
    const contract = validateConversationDraft({ subject: draft.subject, body: draft.body_plain });
    assert.equal(contract.ok, true, `${variant.key}: ${JSON.stringify(contract)}`);
    assert.match(draft.body_plain, /Northstar Electric/);
    assert.match(draft.body_plain, /Electrical businesses in Albany/);
    assert.match(draft.body_plain, /^Hi Maria,/);
    assert.doesNotMatch(draft.subject, /quick follow-up/i);
    assert.doesNotMatch(draft.body_plain, /meeting|demo|trial|https?:/i);
  }
});

test('deterministic fallback cleans stored HTML entities before drafting', () => {
  const draft = buildConversationFallback({
    lead: { company_name: 'Repair &amp; Restore', city: 'Albany', industry: 'Home Services' },
    contactName: 'Alex',
    experiment: { variant: 'inquiry_response' },
  });
  assert.match(draft.body_plain, /Repair & Restore/);
  assert.doesNotMatch(draft.body_plain, /&amp;/);
});

test('a cached model score cannot bypass the conversation-first copy contract', async () => {
  const longPitch = `${Array.from({ length: 95 }, () => 'word').join(' ')}?`;
  const sequence = {
    id: 'sequence-1',
    message_subject: 'A much too long subject for this conversation experiment',
    message_body: `${longPitch}\n\nPatrick Jenkins\nFounder, First Gen Automate\nfirstgenautomate.com`,
    metadata: {
      creative_version: CREATIVE_VERSION,
      autosend_quality: { ok: true, score: 99, problems: [], judged_by: 'claude' },
    },
  };
  const verdict = await scoreDraftQuality(stubDb({
    conversations: { data: [{ metadata: {}, message_body: sequence.message_body }], error: null },
    contacts: { data: [], error: null },
  }), {
    tenant: {
      id: FGA_TENANT_ID,
      slug: 'first-gen-automate',
      config: { sender_name: 'Patrick Jenkins', sender_title: 'Founder, First Gen Automate' },
    },
    lead: { id: 'lead-1', company_name: 'Example Company', city: 'Atlanta' },
    sequence,
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => problem.startsWith('conversation_first:')));
  assert.equal(verdict.judged_by, 'deterministic');
});

test('FGA drafting path is short and experiment-attributed while customer copy stays unchanged', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../worker/agents/outreach.js'), 'utf8');
  const sendSource = fs.readFileSync(path.join(__dirname, '../../core/outreach-send.js'), 'utf8');
  const gateSource = fs.readFileSync(path.join(__dirname, '../../core/auto-outreach.js'), 'utf8');
  assert.match(source, /3-4 short paragraphs and 55-90 words/);
  assert.match(source, /4-6 short paragraphs and 120-180 words/);
  assert.match(source, /validateConversationDraft/);
  assert.match(source, /REPAIR REQUIRED/);
  assert.match(source, /malformed_repair/);
  assert.match(source, /deterministic_fallback/);
  assert.match(source, /creative_version: messageExperiment\.creative_version/);
  assert.match(source, /experimentKey: messageExperiment\?\.experiment_key/);
  assert.match(sendSource, /experimentKey: sequence\.metadata\?\.experiment_key/);
  assert.doesNotMatch(gateSource, /if \(cached && typeof cached\.score === 'number'\) return cached/);
  assert.match(gateSource, /conversation_first:/);
  assert.match(
    gateSource,
    /update\(\{ metadata: \{ \.\.\.\(sequence\.metadata \|\| \{\}\), autosend_quality: verdict \} \}\)[\s\S]{0,120}\.eq\('tenant_id', tenant\.id\)/,
    'quality verdict cache write must remain tenant scoped',
  );
  assert.match(gateSource, /operationType: 'outreach_quality_gate'/);
  assert.match(gateSource, /agentName: 'auto-outreach'/);
  assert.match(gateSource, /actionClass: 'analysis'/);
  assert.match(gateSource, /sideEffect: 'none'/);
});
