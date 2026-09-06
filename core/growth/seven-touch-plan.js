'use strict';

/**
 * FGA's canonical seven-total-touch plan. Touch 1 is the personalized cold
 * email drafted by the outreach agent. These six templates are the follow-up
 * contract used by the versioned drip campaign.
 *
 * The spacing is intentionally front-loaded for relevance and then slows down:
 * day 0, 3, 7, 14, 30, 90, 180. Every touch asks for a reply, not a meeting,
 * and each uses a different conversational purpose.
 */
const PLAN_KEY = 'wide-net-seven-touch-v1';
const TOTAL_TOUCHES = 7;
const TOUCH_DAYS = Object.freeze([0, 3, 7, 14, 30, 90, 180]);

const FOLLOW_UPS = [
  {
    day: 3,
    purpose: 'contextual_follow_up',
    subject: 'A quick question about {{company}}',
    body: `<p>Hi {{first_name}},</p><p>I had one quick follow-up about {{company}}. When a new call or web inquiry arrives while everyone is busy, is the first response handled by a person each time?</p><p>If you reply with “manual” or “automated,” I can send back the most relevant example.</p>`,
  },
  {
    day: 7,
    purpose: 'different_pain_point',
    subject: 'What happens after no answer?',
    body: `<p>Hi {{first_name}},</p><p>A different question for {{company}}: when a potential customer does not answer the first follow-up, does someone remember to try again over the next few days?</p><p>That is often the quiet gap we automate. Is that already covered on your side?</p>`,
  },
  {
    day: 14,
    purpose: 'practical_example',
    subject: 'One workflow for {{company}}',
    body: `<p>Hi {{first_name}},</p><p>One practical workflow we can set up is simple: acknowledge a new inquiry quickly, collect the missing details, keep following up when the person goes quiet, and hand the conversation to the owner when a real buying signal appears.</p><p>Would seeing how that could fit {{company}} be useful?</p>`,
  },
  {
    day: 30,
    purpose: 'helpful_resource',
    subject: 'A simple follow-up check',
    body: `<p>Hi {{first_name}},</p><p>Here is a quick check you can use without buying anything: look at the last ten new inquiries and note how many received a reply, a second follow-up, and a clear next step. Any blank is a place where good leads can disappear.</p><p>If you want, reply “checklist” and I will send the short version we use.</p>`,
  },
  {
    day: 90,
    purpose: 'fresh_context_check_in',
    subject: 'Still handling follow-up manually?',
    body: `<p>Hi {{first_name}},</p><p>Reaching out with a fresh question rather than assuming my earlier notes were timely. Is lead response and follow-up at {{company}} still mostly manual?</p><p>If it is, tell me the part that takes the most time and I will reply with one focused automation idea.</p>`,
  },
  {
    day: 180,
    purpose: 'final_touch',
    subject: 'Closing the loop',
    body: `<p>Hi {{first_name}},</p><p>This is my last scheduled note. I reached out because small teams can lose good opportunities when response and follow-up depend on someone remembering every step.</p><p>If that becomes a priority for {{company}}, reply whenever the timing is right. I will leave it there.</p>`,
  },
];

function validatePlan(steps = FOLLOW_UPS) {
  const errors = [];
  if (steps.length !== TOTAL_TOUCHES - 1) errors.push('must_have_six_followups');
  const days = steps.map((step) => Number(step.day));
  if (new Set(days).size !== days.length) errors.push('duplicate_day');
  if (days.join(',') !== '3,7,14,30,90,180') errors.push('unexpected_cadence');
  for (const step of steps) {
    if (!step.subject || !step.body || !step.purpose) errors.push(`incomplete_day_${step.day}`);
    if (/guarantee|risk-free|double your revenue|book a demo/i.test(`${step.subject} ${step.body}`)) {
      errors.push(`prohibited_claim_day_${step.day}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { PLAN_KEY, TOTAL_TOUCHES, TOUCH_DAYS, FOLLOW_UPS, validatePlan };
