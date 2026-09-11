'use strict';

const crypto = require('crypto');

const CREATIVE_VERSION = 'conversation-first-touch-v1';

// These are three conversation hypotheses, not three cosmetic rewrites. Each
// asks for one easy operational answer that can become a genuine sales
// conversation. No variant pretends we observed a missed call, slow response,
// job-site scene, or other fact the lead record cannot prove.
const VARIANTS = Object.freeze([
  Object.freeze({
    key: 'inquiry_response',
    hypothesis: 'Small teams will answer a concrete question about what happens when a new inquiry arrives while everyone is busy.',
    opening: 'Say truthfully that you came across the company while looking at small businesses in its market. Do not praise or claim you inspected its operations.',
    question: 'Ask whether a new inquiry gets an automatic first response or waits for a person to become available.',
    capability: 'If useful, say only that First Gen Automate can set up an immediate text response after a captured web inquiry or missed call.',
  }),
  Object.freeze({
    key: 'followup_ownership',
    hypothesis: 'Owners will acknowledge whether follow-up after no response still depends on someone remembering it.',
    opening: 'Name the company and location from the lead record. Do not invent a trade scene, recent event, or business problem.',
    question: 'Ask whether follow-up after a prospect goes quiet is systematic or still handled manually.',
    capability: 'If useful, say only that First Gen Automate can set up a scheduled email or text follow-up sequence.',
  }),
  Object.freeze({
    key: 'owner_time',
    hypothesis: 'Owner-operated teams will identify the lead-response step that still consumes the owner personally.',
    opening: 'Name the company and identify First Gen Automate as helping small teams with lead response. Make no claim about the company beyond stored facts.',
    question: 'Ask which part of responding to or following up with new leads still depends on the owner personally.',
    capability: 'If useful, say only that First Gen Automate can set up one repeatable lead-response or follow-up step.',
  }),
]);

function assignMessageExperiment(lead = {}) {
  const stable = String(lead.id || `${lead.company_name || ''}:${lead.domain || lead.website || ''}`);
  const digest = crypto.createHash('sha256').update(stable).digest();
  const variant = VARIANTS[digest.readUInt32BE(0) % VARIANTS.length];
  return {
    experiment_key: `${CREATIVE_VERSION}:${variant.key}`,
    creative_version: CREATIVE_VERSION,
    variant: variant.key,
    hypothesis: variant.hypothesis,
    prompt: [
      `Experiment variant: ${variant.key}.`,
      variant.opening,
      variant.capability,
      variant.question,
      'The reply request is the only CTA.',
    ].join(' '),
  };
}

function wordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Fail closed before a conversation-first draft is stored. The provider gate
 * still performs its independent safety/quality review later; this contract
 * prevents the drafter from silently reverting to the old long-form pitch.
 */
function validateConversationDraft({ subject, body }) {
  const problems = [];
  const subjectWords = wordCount(subject);
  const bodyWords = wordCount(body);
  const questionCount = (String(body || '').match(/\?/g) || []).length;

  if (subjectWords < 3 || subjectWords > 6) problems.push('subject_word_count');
  if (bodyWords < 55 || bodyWords > 90) problems.push('body_word_count');
  if (questionCount !== 1) problems.push('single_question_required');
  if (/\b(meeting|demo|schedule|book|trial)\b/i.test(String(body || ''))) {
    problems.push('premature_conversion_cta');
  }
  if (/https?:\/\/|www\.|\bfirstgenautomate\.com\b/i.test(String(body || ''))) {
    problems.push('link_not_allowed');
  }
  if (/\$|\b\d+(?:\.\d+)?%\b/.test(String(body || ''))) problems.push('numeric_claim');

  return {
    ok: problems.length === 0,
    problems,
    subject_words: subjectWords,
    body_words: bodyWords,
    question_count: questionCount,
  };
}

function cleanFact(value, fallback, maxLength = 120) {
  const cleaned = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, maxLength);
  return cleaned || fallback;
}

/**
 * Grounded last resort when two model attempts cannot follow the copy
 * contract. It uses only the same stored company/contact/location facts and
 * the assigned hypothesis, so daily throughput never depends on a model
 * remembering structural rules.
 */
function buildConversationFallback({ lead = {}, contactName = 'there', experiment } = {}) {
  const company = cleanFact(lead.company_name, 'your company');
  const city = cleanFact(lead.city, '', 80);
  const rawFirst = cleanFact(contactName, 'there', 80).split(/\s+/)[0];
  const firstName = rawFirst.toLowerCase() === 'there' ? 'there' : rawFirst;
  const location = city ? ` in ${city}` : '';
  const intro = `Hi ${firstName},\n\nI came across ${company}${location} while looking at small businesses and had one operational question.`;

  const copy = {
    inquiry_response: {
      subject: 'A quick inquiry question',
      middle: 'First Gen Automate helps small teams make lead response more consistent. We can set up an immediate text after a captured web inquiry or missed call, without changing how the rest of the team works.',
      question: 'When a new inquiry arrives while everyone is busy, does it receive an automatic first response or wait until someone becomes available?',
    },
    followup_ownership: {
      subject: 'A quick follow-up question',
      middle: 'First Gen Automate helps small teams make follow-up more consistent. We can set up a timed email or text sequence after the first response, while leaving the actual sales conversation with your team.',
      question: 'When a prospect goes quiet, is follow-up handled by a repeatable process or does someone need to remember each next step?',
    },
    owner_time: {
      subject: 'A quick owner-time question',
      middle: 'First Gen Automate helps small teams make one lead-response step repeatable without taking the relationship away from the owner. We can set up that one step after you decide where it belongs in the process.',
      question: 'Which part of responding to or following up with new leads still depends on you personally?',
    },
  };
  const selected = copy[experiment?.variant] || copy.inquiry_response;
  return {
    subject: selected.subject,
    body_plain: `${intro}\n\n${selected.middle}\n\n${selected.question}`,
    body_html: null,
  };
}

module.exports = {
  CREATIVE_VERSION,
  VARIANTS,
  assignMessageExperiment,
  validateConversationDraft,
  buildConversationFallback,
};
