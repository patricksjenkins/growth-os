#!/usr/bin/env node
'use strict';

/**
 * Replace only the FGA restart cohort's unconsumed first-touch drafts with the
 * current conversation-first creative. This command never calls a provider.
 *
 * Default mode is aggregate-only. Write mode requires the exact FGA tenant
 * confirmation and refuses to run unless first-touch and drip sending are
 * paused. Customer-tenant rows are excluded by every query.
 *
 *   node scripts/refresh-fga-conversation-drafts.js
 *   node scripts/refresh-fga-conversation-drafts.js --apply \
 *     --confirm-tenant=<FGA_TENANT_ID>
 */
require('dotenv').config();

const { getServiceClient } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const { resolveTenant } = require('../core/tenant');
const { guardedEnqueue } = require('../core/ai-safety/guarded-enqueue');
const { loadProtectedOrganizationIndex } = require('../core/growth/customer-boundary');
const { PLAN_KEY } = require('../core/growth/seven-touch-plan');
const { CREATIVE_VERSION } = require('../core/growth/message-experiment');
const { revalidate } = require('../worker/agents/growth-restart')._test;

const APPLY = process.argv.includes('--apply');
const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-tenant='))?.split('=')[1];
const MAX_COHORT = 100;

async function required(builder, label) {
  const result = await builder;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

function classifyRefreshBinding(candidate, sequence, completedBatchIds) {
  if (!candidate?.authorized_at || candidate.first_touch_sent_at) return 'not_unconsumed_authority';
  if (!candidate.first_touch_sequence_id) {
    return candidate.evidence?.draft_refresh?.state === 'pending'
      && candidate.evidence?.draft_refresh?.creative_version === CREATIVE_VERSION
      ? 'resume_pending'
      : 'unbound_without_refresh_receipt';
  }
  if (!sequence) return 'sequence_missing';
  if (!['draft', 'superseded'].includes(sequence.sequence_status)) return `sequence_${sequence.sequence_status || 'unknown'}`;
  if (sequence.metadata?.delivered || sequence.metadata?.sent_at) return 'provider_evidence_present';
  if (sequence.metadata?.restart_batch_id !== candidate.batch_id) return 'restart_batch_mismatch';
  if (sequence.metadata?.message_version !== PLAN_KEY) return 'plan_version_mismatch';
  if (sequence.metadata?.creative_version === CREATIVE_VERSION) return 'already_current';
  if (!completedBatchIds.has(candidate.batch_id)) return 'batch_not_completed';
  return 'refresh';
}

function countBy(rows, key) {
  return rows.reduce((out, row) => {
    const value = row[key] || 'unknown';
    out[value] = (out[value] || 0) + 1;
    return out;
  }, {});
}

async function main() {
  if (APPLY && confirmation !== FGA_TENANT_ID) {
    throw new Error('Exact FGA tenant confirmation is required');
  }
  const db = getServiceClient();
  const tenant = await resolveTenant(db, FGA_TENANT_ID);
  const sendState = {
    autosend_paused: String(tenant?.config?.autosend_paused ?? 'false'),
    drip_sends_paused: String(tenant?.config?.drip_sends_paused ?? 'false'),
  };
  if (APPLY && (sendState.autosend_paused !== 'true' || sendState.drip_sends_paused !== 'true')) {
    throw new Error('FGA first-touch and drip sending must both be paused before refreshing drafts');
  }

  const candidates = await required(db.from('growth_restart_candidates')
    .select('id, batch_id, lead_id, decision, authorized_at, first_touch_sequence_id, first_touch_sent_at, evidence')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('decision', 'eligible')
    .not('authorized_at', 'is', null)
    .is('first_touch_sent_at', null)
    .order('id', { ascending: true })
    .limit(MAX_COHORT), 'restart_candidates');
  if ((candidates || []).length >= MAX_COHORT) throw new Error('Refresh cohort reached its safety cap');

  const sequenceIds = candidates.map((row) => row.first_touch_sequence_id).filter(Boolean);
  const batchIds = [...new Set(candidates.map((row) => row.batch_id).filter(Boolean))];
  const leadIds = [...new Set(candidates.map((row) => row.lead_id).filter(Boolean))];
  const [sequences, batches, leads, protectedOrganizations] = await Promise.all([
    sequenceIds.length
      ? required(db.from('outreach_sequences')
        .select('id, sequence_status, metadata')
        .eq('tenant_id', FGA_TENANT_ID).in('id', sequenceIds), 'restart_sequences')
      : [],
    batchIds.length
      ? required(db.from('growth_restart_batches').select('id, status')
        .eq('tenant_id', FGA_TENANT_ID).in('id', batchIds), 'restart_batches')
      : [],
    leadIds.length
      ? required(db.from('leads')
        .select('id, company_name, lead_source, status, lifecycle_stage, employee_count_actual, size, lead_score, outreach_ready, email, metadata, created_at')
        .eq('tenant_id', FGA_TENANT_ID).in('id', leadIds), 'restart_leads')
      : [],
    loadProtectedOrganizationIndex(db),
  ]);
  const sequenceById = new Map(sequences.map((row) => [row.id, row]));
  const leadById = new Map(leads.map((row) => [row.id, row]));
  const completedBatchIds = new Set(batches.filter((row) => row.status === 'completed').map((row) => row.id));

  const assessed = [];
  for (const candidate of candidates) {
    const sequence = sequenceById.get(candidate.first_touch_sequence_id) || null;
    let reason = classifyRefreshBinding(candidate, sequence, completedBatchIds);
    const lead = leadById.get(candidate.lead_id) || null;
    if (['refresh', 'resume_pending'].includes(reason)) {
      if (!lead) reason = 'lead_missing';
      else {
        try {
          const verdict = await revalidate(db, lead, protectedOrganizations);
          if (verdict.decision !== 'eligible') reason = `revalidation_${verdict.reason}`;
        } catch (_) {
          reason = 'revalidation_unavailable';
        }
      }
    }
    assessed.push({ candidate, sequence, lead, reason });
  }
  const refreshable = assessed.filter((row) => ['refresh', 'resume_pending'].includes(row.reason));
  const summary = {
    tenant_scope: 'FGA_ONLY',
    unconsumed_authorities_examined: candidates.length,
    refreshable: refreshable.length,
    disposition: countBy(assessed, 'reason'),
    send_state: sendState,
    target_creative_version: CREATIVE_VERSION,
    changes_customer_tenants: false,
    sends_messages: false,
    apply: APPLY,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY || !refreshable.length) return;

  const now = new Date().toISOString();
  for (const row of refreshable) {
    if (row.sequence?.sequence_status === 'draft') {
      const retired = await required(db.from('outreach_sequences')
        .update({ sequence_status: 'superseded', updated_at: now })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('id', row.sequence.id)
        .eq('sequence_status', 'draft')
        .select('id').maybeSingle(), 'supersede_old_draft');
      if (!retired?.id) throw new Error('An old draft changed during refresh; sending remains paused');
    }
    const evidence = {
      ...(row.candidate.evidence || {}),
      draft_refresh: { state: 'pending', creative_version: CREATIVE_VERSION, at: now },
    };
    let reset = db.from('growth_restart_candidates').update({
      first_touch_sequence_id: null,
      evidence,
    }).eq('tenant_id', FGA_TENANT_ID).eq('id', row.candidate.id)
      .is('first_touch_sent_at', null);
    if (row.candidate.first_touch_sequence_id) {
      reset = reset.eq('first_touch_sequence_id', row.candidate.first_touch_sequence_id);
    } else {
      reset = reset.is('first_touch_sequence_id', null);
    }
    const candidateReset = await required(reset.select('id').maybeSingle(), 'reset_candidate_binding');
    if (!candidateReset?.id) throw new Error('A restart authority changed during refresh; sending remains paused');

    const leadReset = await required(db.from('leads').update({
      status: 'new_lead',
      lifecycle_stage: 'scored',
      automation_status: 'restart_queued',
      metadata: {
        ...(row.lead.metadata || {}),
        growth_restart: { batch_id: row.candidate.batch_id, authorized_at: row.candidate.authorized_at },
        conversation_refresh: { creative_version: CREATIVE_VERSION, requested_at: now },
      },
      updated_at: now,
    }).eq('tenant_id', FGA_TENANT_ID).eq('id', row.lead.id)
      .select('id').maybeSingle(), 'reset_lead_for_refresh');
    if (!leadReset?.id) throw new Error('Lead reset did not persist; sending remains paused');
  }

  const queue = await guardedEnqueue({
    tenantId: FGA_TENANT_ID,
    agentName: 'outreach',
    items: refreshable.map((row) => ({
      lead_id: row.lead.id,
      limit: 1,
      restart_batch_id: row.candidate.batch_id,
      skip_recycle: true,
      skip_send_handoff: true,
    })),
    source: 'manual_script',
    reason: `conversation_first_refresh:${CREATIVE_VERSION}`,
    createdBy: 'codex:growth-engine-overhaul',
    priority: 7,
  });
  if (!queue.ok || queue.pendingApproval || queue.enqueued !== refreshable.length) {
    throw new Error(`Draft refresh queue incomplete (${queue.enqueued || 0}/${refreshable.length}); sending remains paused`);
  }

  const audit = await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'codex:growth-engine-overhaul',
    action: 'conversation_first_draft_refresh_queued',
    entity_type: 'growth_restart_cohort',
    entity_id: FGA_TENANT_ID,
    level: 'info',
    metadata: {
      refreshed: refreshable.length,
      creative_version: CREATIVE_VERSION,
      customer_tenants_modified: 0,
      sends_messages: false,
      autosend_left_paused: true,
    },
  });
  if (audit.error) throw new Error(`Refresh audit receipt failed:${audit.error.message}`);
  console.log(JSON.stringify({ queued: queue.enqueued, sends_messages: false, autosend_left_paused: true }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { classifyRefreshBinding, countBy, MAX_COHORT };

