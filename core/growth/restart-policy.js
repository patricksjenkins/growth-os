'use strict';

const { FGA_TENANT_ID } = require('../config');
const { isProspectSource } = require('../lead-sources');
const { evaluateEmployeeFit } = require('./eligibility');

const POLICY_VERSION = 'fga-prospect-restart-v2';
const MIN_DORMANT_DAYS = 45;
const MIN_SCORE = 60;
const NEVER_RESTART_STATUSES = new Set([
  'won', 'lost', 'rejected', 'declined', 'disqualified', 'unsubscribed',
  'bounced', 'replied', 'interested', 'demo_booked', 'quoted', 'trial_active',
  'nurture',
]);
const NEVER_RESTART_LIFECYCLES = new Set(['customer', 'unqualified']);
const { DATABASE_FIRST_CUTOFF } = require('./seven-touch-plan');

const EMPLOYEE_SEGMENT_PRIORITY = Object.freeze({
  verified_sweet_spot_1_9: 4000,
  estimated_sweet_spot_1_9: 3500,
  verified_small_business_10_19: 3000,
  estimated_small_business_10_19: 2500,
});

function restartPriority({ lead = {}, employeeFit, dormantDays }) {
  const createdAt = Date.parse(lead.created_at || '');
  const cutoff = Date.parse(DATABASE_FIRST_CUTOFF);
  const existingInventory = Number.isFinite(createdAt) && createdAt < cutoff;
  const score = Math.max(0, Math.min(100, Number(lead.lead_score) || 0));
  const neverContacted = dormantDays === null;
  return {
    priority_score: (existingInventory ? 10000 : 0)
      + (EMPLOYEE_SEGMENT_PRIORITY[employeeFit.segment] || 0)
      + (neverContacted ? 500 : 0)
      + score,
    inventory_cohort: existingInventory ? 'existing_database' : 'new_discovery',
    employee_segment: employeeFit.segment || 'unknown',
  };
}

function daysSince(iso, now = new Date()) {
  if (!iso) return null;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return null;
  return Math.floor((now.getTime() - value.getTime()) / 86400000);
}

/**
 * Pure classification. Context contains booleans and timestamps only; no email
 * address or customer data is copied into the restart evidence ledger.
 */
function classifyRestartCandidate({ tenantId, lead, context = {}, now = new Date() }) {
  const exclude = (reason, evidence = {}) => ({ decision: 'excluded', reason, evidence, policy_version: POLICY_VERSION });
  const needs = (reason, evidence = {}) => ({ decision: 'needs_evidence', reason, evidence, policy_version: POLICY_VERSION });

  if (tenantId !== FGA_TENANT_ID) return exclude('wrong_tenant');
  if (!isProspectSource(lead?.lead_source)) return exclude('not_outbound_prospect');
  if (NEVER_RESTART_STATUSES.has(String(lead?.status || '').toLowerCase())) {
    return exclude('terminal_or_engaged_status', { status: lead.status });
  }
  if (NEVER_RESTART_LIFECYCLES.has(String(lead?.lifecycle_stage || '').toLowerCase())) {
    return exclude('terminal_lifecycle', { lifecycle_stage: lead.lifecycle_stage });
  }

  const employeeFit = evaluateEmployeeFit(lead);
  if (employeeFit.decision === 'needs_evidence') {
    return needs(employeeFit.reason, { employee_source: employeeFit.evidence.source });
  }
  if (!employeeFit.eligible) {
    return exclude(employeeFit.reason, { employee_source: employeeFit.evidence.source });
  }
  if (!context.hasEmail) return needs('email_missing');
  if (context.customerMatch) return exclude('matches_customer');
  if (context.suppressed) return exclude('suppressed');
  if (context.negativeDelivery) return exclude('negative_delivery_history');
  if (context.humanReply) return exclude('human_reply_history');

  const score = Number(lead?.lead_score);
  if (!Number.isFinite(score)) return needs('score_missing');
  if (score < MIN_SCORE || lead?.outreach_ready !== true) {
    return exclude('below_outreach_threshold', { score });
  }

  const dormantDays = daysSince(context.lastAcceptedAt, now);
  if (dormantDays !== null && dormantDays < MIN_DORMANT_DAYS) {
    return exclude('cooldown_active', { dormant_days: dormantDays, required_days: MIN_DORMANT_DAYS });
  }

  const priority = restartPriority({ lead, employeeFit, dormantDays });
  return {
    decision: 'eligible',
    reason: dormantDays === null ? 'fresh_qualified_prospect' : 'dormant_qualified_prospect',
    evidence: {
      employee_source: employeeFit.evidence.source,
      employee_max: employeeFit.evidence.max,
      score,
      dormant_days: dormantDays,
      had_prior_accepted_send: dormantDays !== null,
      ...priority,
    },
    policy_version: POLICY_VERSION,
  };
}

module.exports = {
  POLICY_VERSION,
  MIN_DORMANT_DAYS,
  MIN_SCORE,
  NEVER_RESTART_STATUSES,
  classifyRestartCandidate,
  daysSince,
  restartPriority,
};
