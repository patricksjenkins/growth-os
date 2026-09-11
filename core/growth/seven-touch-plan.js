'use strict';

/**
 * FGA's canonical database-first, seven-total-touch outreach plan. Touch 1 is
 * the personalized cold email drafted by the outreach agent. These six
 * templates are the follow-up contract used by the versioned drip campaign.
 *
 * The spacing is intentionally front-loaded for relevance and then slows down:
 * day 0, 3, 7, 14, 30, 90, 180. Every touch asks for a reply, not a meeting,
 * and each uses a different conversational purpose.
 */
const PLAN_KEY = 'database-first-seven-touch-v2';
const DATABASE_FIRST_CUTOFF = '2026-09-10T00:00:00.000Z';
const TOTAL_TOUCHES = 7;
const TOUCH_DAYS = Object.freeze([0, 3, 7, 14, 30, 90, 180]);
const INITIAL_DAILY_CAP = 25;

function requiredSteadyStateFollowupCapacity(initialDailyCap = INITIAL_DAILY_CAP, totalTouches = TOTAL_TOUCHES) {
  const initial = Number(initialDailyCap);
  const touches = Number(totalTouches);
  if (!Number.isSafeInteger(initial) || initial < 0) return 0;
  if (!Number.isSafeInteger(touches) || touches < 1) return 0;
  return initial * (touches - 1);
}

const AUDIENCE = Object.freeze({
  market: 'Any legitimate small-business industry',
  priority_order: Object.freeze([
    'Existing FGA prospects with an estimated or verified 1-9 employees',
    'Existing FGA prospects with an estimated or verified 10-19 employees',
    'Newly discovered 1-9 prospects',
    'Newly discovered 10-19 prospects',
  ]),
  research_only: 'Unknown size or a range that could include 20 or more employees',
  excluded: 'Known 20+ employee organizations, customers, tenant contacts, inbound leads, replies, suppressions, complaints, bounces, and terminal sales states',
});

const VOLUME = Object.freeze({
  initial_daily_cap: INITIAL_DAILY_CAP,
  // A sustained 25 new prospects/day produces six later touches per cohort:
  // 25 × 6 = 150 due follow-ups/day once the 180-day plan reaches steady
  // state. A cap below that is not a safety control; it guarantees an
  // ever-growing queue and silently breaks the seven-touch promise. The
  // provider/deliverability breaker remains the safety authority and can
  // throttle or stop actual sends at any volume.
  followup_daily_cap: requiredSteadyStateFollowupCapacity(),
  existing_inventory_share_until_exhausted: 1,
  ramp_increment: 10,
  ramp_review_days: 7,
  ramp_requires: Object.freeze([
    'zero complaints',
    'bounce rate below half the circuit-breaker threshold',
    'fresh reply synchronization',
    'provider-backed delivery evidence',
  ]),
});

const STOP_CONDITIONS = Object.freeze([
  'customer or tenant-contact match',
  'any human reply',
  'unsubscribe or suppression',
  'bounce, complaint, or provider failure requiring review',
  'demo booked, proposal, won, lost, or other terminal sales state',
  'unverifiable tenant, recipient, provider, or prior-send state',
]);

const OUTCOME_LADDER = Object.freeze([
  'provider_accepted',
  'delivered',
  'human_reply',
  'warm_reply',
  'owner_accepted',
  'demo_booked',
  'demo_held',
  'proposal',
  'won',
]);

const TOUCHES = Object.freeze([
  {
    number: 1,
    day: 0,
    purpose: 'relevant_operational_question',
    promise: 'Show that the note is for this business and ask one easy operational question.',
    cta: 'Reply with a short answer; never ask for a meeting in the first touch.',
  },
  {
    number: 2,
    day: 3,
    purpose: 'contextual_follow_up',
    promise: 'Reduce the first question to a simple manual-or-automated answer.',
    cta: 'Reply manual or automated.',
  },
  {
    number: 3,
    day: 7,
    purpose: 'different_pain_point',
    promise: 'Explore a second workflow problem instead of repeating the first email.',
    cta: 'Say whether follow-up after no answer is already covered.',
  },
  {
    number: 4,
    day: 14,
    purpose: 'practical_example',
    promise: 'Explain one concrete managed-automation workflow without guarantees.',
    cta: 'Reply if seeing the workflow would be useful.',
  },
  {
    number: 5,
    day: 30,
    purpose: 'helpful_resource',
    promise: 'Give a useful self-audit the owner can use without buying.',
    cta: 'Reply checklist for the short version.',
  },
  {
    number: 6,
    day: 90,
    purpose: 'fresh_context_check_in',
    promise: 'Re-open with a fresh question and no assumption that earlier notes were read.',
    cta: 'Name the most time-consuming manual step.',
  },
  {
    number: 7,
    day: 180,
    purpose: 'final_touch',
    promise: 'Close the loop respectfully and stop scheduled outreach.',
    cta: 'Leave the door open without urgency or guilt.',
  },
]);

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
  if (TOUCHES.length !== TOTAL_TOUCHES) errors.push('touch_strategy_incomplete');
  if (TOUCHES.map((step) => step.day).join(',') !== TOUCH_DAYS.join(',')) errors.push('touch_strategy_cadence_mismatch');
  if (!AUDIENCE.priority_order[0]?.startsWith('Existing FGA prospects')) errors.push('existing_inventory_not_prioritized');
  if (!STOP_CONDITIONS.some((rule) => rule.includes('human reply'))) errors.push('reply_stop_missing');
  if (!OUTCOME_LADDER.includes('warm_reply') || !OUTCOME_LADDER.includes('won')) errors.push('outcome_contract_incomplete');
  if (VOLUME.followup_daily_cap < requiredSteadyStateFollowupCapacity(VOLUME.initial_daily_cap, TOTAL_TOUCHES)) {
    errors.push('followup_capacity_below_steady_state_requirement');
  }
  for (const step of steps) {
    if (!step.subject || !step.body || !step.purpose) errors.push(`incomplete_day_${step.day}`);
    if (/guarantee|risk-free|double your revenue|book a demo/i.test(`${step.subject} ${step.body}`)) {
      errors.push(`prohibited_claim_day_${step.day}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  PLAN_KEY,
  DATABASE_FIRST_CUTOFF,
  TOTAL_TOUCHES,
  TOUCH_DAYS,
  AUDIENCE,
  VOLUME,
  STOP_CONDITIONS,
  OUTCOME_LADDER,
  TOUCHES,
  FOLLOW_UPS,
  requiredSteadyStateFollowupCapacity,
  validatePlan,
};
