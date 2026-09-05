/**
 * FGA content pillars (file-based) — the new positioning, ADDED alongside the
 * existing editorial pillars in core/fga-content-playbook.js.
 *
 * These 7 pillars put the brand's current positioning front-and-center — the
 * 24/7 AI Voice Receptionist as flagship, missed-call pain, managed AI (not
 * another app), the Command Center, follow-up/overhead, micro-business reality,
 * and the before/after. Each maps to the visual_types that best SHOW it and to
 * example angles, so the planner reaches for them regularly without losing the
 * existing rolling-mix balance or the anti-fear / anti-overpromise guardrails.
 */

const PILLARS = [
  {
    id: 'missed_calls_cost_money',
    label: 'Missed Calls Cost Money',
    idea: 'A missed call is a missed lead — but framed as the opportunity FGA captures, not just the loss.',
    visualTypes: ['pain_scenario', 'before_after', 'product_workflow'],
    angles: ['You cannot answer the phone with a chainsaw / under a sink / on a roof.', 'The customer who goes to voicemail is already calling the next business.', 'Most lost leads just look like missed calls.'],
  },
  {
    id: 'managed_ai_not_another_app',
    label: 'Managed AI, Not Another App',
    idea: 'FGA is set up and managed for you — not another tool/login the owner has to run.',
    visualTypes: ['command_center', 'founder_pov', 'service_business'],
    angles: ['AI tools are easy to buy, harder to run.', 'You do not need another login — you need the system set up for you.', 'We set it up. We manage it. You stay in control.'],
  },
  {
    id: 'ai_voice_receptionist',
    label: 'AI Voice Receptionist',
    idea: 'The flagship: a lead calls, the AI answers, captures the caller\'s details, qualifies the request, and sends the owner the info to follow up.',
    visualTypes: ['product_workflow', 'pain_scenario', 'carousel_story'],
    angles: ['Your phone should not stop working because you are on a job.', 'A lead calls, the AI answers, the details get captured.', 'No more mystery voicemails with half the information missing.'],
  },
  {
    id: 'command_center',
    label: 'Command Center',
    idea: 'One simple place to see what happened — calls, leads, follow-ups, activity — without becoming the tech person.',
    visualTypes: ['command_center', 'product_workflow'],
    angles: ['Your business needs one place to see what happened.', 'Calls, leads, follow-ups, and activity in one simple view.', 'Not a complicated dashboard — a simple way to stay in control.'],
  },
  {
    id: 'followup_admin_overhead',
    label: 'Follow-Up & Admin Overhead',
    idea: 'The overhead does not disappear — it waits for the owner. FGA organizes the follow-up.',
    visualTypes: ['before_after', 'pain_scenario', 'command_center'],
    angles: ['The quote was sent. The follow-up never happened.', 'The job got done. The review request did not.', 'Admin work does not disappear. It just waits for you.'],
  },
  {
    id: 'micro_business_reality',
    label: 'Micro-Business Reality',
    idea: 'In a 1-9 person business, the owner is the salesperson, dispatcher, operator, and admin all at once.',
    visualTypes: ['service_business', 'founder_pov', 'pain_scenario'],
    angles: ['In a 3-person business, everybody is already busy.', 'Small teams need practical help, not enterprise software.', 'The owner wears every hat.'],
  },
  {
    id: 'before_after_fga',
    label: 'Before / After FGA',
    idea: 'The shift: from missed calls / sticky notes / forgotten follow-ups to calls answered / details captured / owner notified / Command Center visibility.',
    visualTypes: ['before_after', 'carousel_story', 'product_workflow'],
    angles: ['Before: missed calls, sticky notes, forgotten follow-ups. After: answered, captured, notified, organized.'],
  },
];

const BY_ID = Object.fromEntries(PILLARS.map((p) => [p.id, p]));

function all() { return PILLARS.slice(); }
function getById(id) { return BY_ID[id] || null; }
function ids() { return PILLARS.map((p) => p.id); }

/** Compact block listing the pillars + preferred visual types for a prompt. */
function promptBlock() {
  return PILLARS.map((p) => `- ${p.label} (${p.id}): ${p.idea} [visuals: ${p.visualTypes.join(', ')}]`).join('\n');
}

module.exports = { PILLARS, all, getById, ids, promptBlock };
