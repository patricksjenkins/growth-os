'use strict';

/**
 * Revenue & Sales — Owner Handoff Agent
 *
 * Recovery sweep for genuine warm/replied prospects. Reply classifiers route
 * these events immediately; this worker proves the handoff state exists and
 * repairs a missing owner assignment. It never contacts a prospect, never
 * reads another tenant, and never promotes a synthetic/quarantined intake.
 */

const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const { getServiceClient, fetchAllRows } = require('../../db/client');
const { markHumanHandoff } = require('../../core/sales/coordination');
const { isSyntheticGrowthLead } = require('../../core/growth/production-evidence');

const OWNER_ATTENTION_TYPES = Object.freeze([
  'sales_reply_interested',
  'sales_reply_question',
  'sales_reply_review',
]);

function planOwnerHandoff(lead, { ownerAttentionKeys = null } = {}) {
  if (!lead || isSyntheticGrowthLead(lead)) return null;
  const status = String(lead.status || '').toLowerCase();
  const stage = String(lead.lifecycle_stage || '').toLowerCase();

  let plan = null;
  if (status === 'interested' || stage === 'interested') {
    plan = {
      action: 'sales_call',
      reason: 'warm_reply_requires_owner',
      attentionType: 'sales_reply_interested',
      severity: 'red',
      summary: 'A warm prospect reply is ready for Patrick to review and continue.',
    };
  } else if (stage === 'engaged') {
    plan = {
      action: 'answer_question',
      reason: 'prospect_question_requires_owner',
      attentionType: 'sales_reply_question',
      severity: 'red',
      summary: 'A prospect question is ready for Patrick to answer.',
    };
  } else if (status === 'replied' || stage === 'replied') {
    plan = {
      action: 'review_reply',
      reason: 'human_reply_requires_owner_review',
      attentionType: 'sales_reply_review',
      severity: 'amber',
      summary: 'A human prospect reply needs Patrick\'s review and next-step decision.',
    };
  }
  if (!plan) return null;

  const leadLooksRouted = lead.next_action_owner === 'owner'
    && lead.next_best_action === plan.action
    && lead.handoff_at;
  // The lead fields are only half of the handoff contract. A previous write
  // can fail after those fields change but before Patrick's durable attention
  // item exists. Only skip recovery when BOTH sides are present.
  const hasOwnerAttention = ownerAttentionKeys instanceof Set
    && ownerAttentionKeys.has(`${plan.attentionType}:${lead.id}`);
  return {
    ...plan,
    leadLooksRouted: Boolean(leadLooksRouted),
    hasOwnerAttention,
    alreadyRouted: Boolean(leadLooksRouted && hasOwnerAttention),
  };
}

async function run(tenant) {
  const log = createLogger('owner-handoff', tenant?.slug || 'unknown');
  if (!tenant || tenant.id !== FGA_TENANT_ID) {
    return {
      success: true,
      skipped: true,
      reason: 'fga_only',
      outcome_contract: {
        result_state: 'succeeded', output_state: 'no_op',
        business_outcome_state: 'not_applicable', reason_code: 'fga_only',
      },
    };
  }

  const db = getServiceClient();
  const leadRows = await fetchAllRows((from, to) => db.from('leads')
    .select('id, email, lead_source, metadata, status, lifecycle_stage, next_best_action, next_action_owner, handoff_at')
    .eq('tenant_id', FGA_TENANT_ID)
    .or('status.in.(replied,interested),lifecycle_stage.in.(replied,interested,engaged)')
    .order('id', { ascending: true })
    .range(from, to), { cap: 10000 });
  if (leadRows.error || leadRows.truncated) {
    throw leadRows.error || new Error('owner_handoff_inventory_exceeded_safe_bound');
  }
  const data = leadRows.data;

  const attentionRows = await fetchAllRows((from, to) => db.from('attention_queue')
    .select('id, type, entity_id')
    .eq('tenant_id', FGA_TENANT_ID)
    .in('type', OWNER_ATTENTION_TYPES)
    .is('resolved_at', null)
    .order('id', { ascending: true })
    .range(from, to), { cap: 10000 });
  if (attentionRows.error || attentionRows.truncated) {
    throw attentionRows.error || new Error('owner_handoff_attention_inventory_exceeded_safe_bound');
  }
  const ownerAttentionKeys = new Set((attentionRows.data || [])
    .filter((row) => row.entity_id && OWNER_ATTENTION_TYPES.includes(row.type))
    .map((row) => `${row.type}:${row.entity_id}`));

  let handedOff = 0;
  let alreadyRouted = 0;
  let excluded = 0;
  for (const lead of data || []) {
    const plan = planOwnerHandoff(lead, { ownerAttentionKeys });
    if (!plan) {
      excluded++;
      continue;
    }
    if (plan.alreadyRouted) {
      alreadyRouted++;
      continue;
    }
    await markHumanHandoff(db, FGA_TENANT_ID, lead.id, {
      reason: plan.reason,
      action: plan.action,
      summary: plan.summary,
      severity: plan.severity,
      attentionType: plan.attentionType,
      dueHours: 24,
      producedBy: 'owner-handoff',
    });
    handedOff++;
  }

  log.info('Owner handoff sweep complete', {
    examined: (data || []).length,
    handed_off: handedOff,
    already_routed: alreadyRouted,
    excluded,
  });
  return {
    success: true,
    examined: (data || []).length,
    handed_off: handedOff,
    already_routed: alreadyRouted,
    excluded,
    outcome_contract: {
      result_state: 'succeeded',
      output_state: handedOff ? 'produced' : 'no_op',
      business_outcome_state: handedOff ? 'owner_handoff_created' : 'not_applicable',
      reason_code: handedOff ? 'warm_relationship_routed' : 'no_unrouted_relationships',
      evidence: { examined: (data || []).length, handed_off: handedOff },
    },
  };
}

module.exports = run;
module.exports.planOwnerHandoff = planOwnerHandoff;
module.exports.OWNER_ATTENTION_TYPES = OWNER_ATTENTION_TYPES;
