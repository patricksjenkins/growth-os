'use strict';

/**
 * The six product stories FGA should teach repeatedly.
 * Two posts per week completes one rotation every three weeks. On the next
 * pass the planner must change the angle, format, industry, and visual proof.
 */
const PRIMARY_MODULE_ROTATION = [
  {
    id: 'ai_voice_receptionist',
    name: 'AI Voice Receptionist',
    pillar: 'ai_voice_receptionist',
    truth: 'Answers inbound calls, captures caller details, qualifies the request, and sends the owner the information for human follow-up.',
    visual: 'Show the call screen and the captured lead handoff.',
  },
  {
    id: 'speed_to_lead',
    name: 'Speed-to-Lead',
    pillar: 'missed_calls_cost_money',
    truth: 'Acknowledges a new inbound web lead quickly and collects the basic information the owner needs to follow up.',
    visual: 'Show the form submission becoming an acknowledgement and lead card.',
  },
  {
    id: 'follow_up_sequences',
    name: 'Follow-Up Sequences',
    pillar: 'followup_admin_overhead',
    truth: 'Runs an approved sequence of follow-up messages so the next touch is visible and consistent.',
    visual: 'Show a short timeline or workflow, never the whole script as prose.',
  },
  {
    id: 'command_center',
    name: 'Command Center',
    pillar: 'command_center',
    truth: 'Gives the owner one place to see calls, leads, follow-ups, and recent activity.',
    visual: 'Show the actual dashboard hierarchy or a faithful product UI mockup.',
  },
  {
    id: 'review_requests',
    name: 'Review Requests',
    pillar: 'followup_admin_overhead',
    truth: 'Sends a review request when the business triggers its approved post-job workflow.',
    visual: 'Show the trigger, customer message, and review-request status.',
  },
  {
    id: 'content_engine',
    name: 'Content Engine + Content Approval',
    pillar: 'managed_ai_not_another_app',
    truth: 'Creates channel-ready draft content and keeps the owner in control with approval before publishing.',
    visual: 'Show concept, draft, owner approval, and scheduled post as a product workflow.',
  },
];

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function moduleIndex(value) {
  const target = normalize(value);
  if (!target) return -1;
  return PRIMARY_MODULE_ROTATION.findIndex((module) => {
    const name = normalize(module.name);
    return target === name || target.includes(name) || name.includes(target);
  });
}

function nextModules(recentModules = [], { count = 2 } = {}) {
  const latestKnown = recentModules.map(moduleIndex).find((index) => index >= 0);
  const start = latestKnown == null
    ? 0
    : (latestKnown + 1) % PRIMARY_MODULE_ROTATION.length;
  return Array.from({ length: count }, (_, offset) => (
    PRIMARY_MODULE_ROTATION[(start + offset) % PRIMARY_MODULE_ROTATION.length]
  ));
}

function matchesModule(value, module) {
  return moduleIndex(value) === PRIMARY_MODULE_ROTATION.indexOf(module);
}

function promptBlock(modules = PRIMARY_MODULE_ROTATION) {
  return modules.map((module, index) => (
    `${index + 1}. ${module.name}: ${module.truth} Visual direction: ${module.visual}`
  )).join('\n');
}

module.exports = {
  PRIMARY_MODULE_ROTATION,
  nextModules,
  matchesModule,
  promptBlock,
};
