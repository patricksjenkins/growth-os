#!/usr/bin/env node
'use strict';

/**
 * Apply one previously validated FGA restart manifest. Default is read-only.
 * The write mode resets only still-eligible rows, binds each to a tracked
 * outreach job, and never calls an email provider itself.
 *
 * Operational prerequisite: autonomous outreach must be paused while this
 * script and the resulting draft jobs run. Resume only after reviewing the
 * generated batch and the new seven-touch campaign is active.
 */
require('dotenv').config();

const { getServiceClient, fetchAllRows } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const { resolveTenant } = require('../core/tenant');
const { normalizeEmail } = require('../core/growth/suppression');
const { classifyRestartCandidate } = require('../core/growth/restart-policy');
const { guardedEnqueue } = require('../core/ai-safety/guarded-enqueue');
const { flags, thresholds } = require('../core/ai-safety/flags');
const sevenTouch = require('../core/growth/seven-touch-plan');

const APPLY = process.argv.includes('--apply');
const batchId = process.argv.find((arg) => arg.startsWith('--batch='))?.split('=')[1];
const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-tenant='))?.split('=')[1];

async function required(builder, label) {
  const result = await builder;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function revalidate(db, lead) {
  const contacts = await required(db.from('contacts').select('email')
    .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).not('email', 'is', null).limit(5), 'contacts');
  const email = normalizeEmail(lead.email) || (contacts || []).map((row) => normalizeEmail(row.email)).find(Boolean) || null;
  const [customers, leadSupp, dripSupp, inbound, negative, sent] = await Promise.all([
    required(db.from('customers').select('id').eq('tenant_id', FGA_TENANT_ID).eq('email', email || '__missing__').limit(1), 'customers'),
    required(db.from('lead_suppressions').select('id').eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).limit(1), 'lead_suppressions'),
    required(db.from('drip_suppressions').select('id').eq('tenant_id', FGA_TENANT_ID).eq('email', email || '__missing__').limit(1), 'drip_suppressions'),
    required(db.from('drip_inbound').select('id, classification').eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).in('classification', ['genuine_reply', 'ambiguous', 'unsubscribe']).limit(1), 'drip_inbound'),
    required(db.from('email_events').select('id').eq('tenant_id', FGA_TENANT_ID).eq('recipient', email || '__missing__').in('event', ['bounced', 'complained', 'suppressed', 'failed']).limit(1), 'email_events'),
    required(db.from('outreach_sequences').select('created_at, metadata').eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).eq('sequence_status', 'sent').order('created_at', { ascending: false }).limit(1), 'outreach_sequences'),
  ]);
  const latest = sent?.[0];
  const lastAcceptedAt = latest?.metadata?.delivered?.at || latest?.metadata?.sent_at || latest?.created_at || null;
  return classifyRestartCandidate({
    tenantId: FGA_TENANT_ID,
    lead,
    context: {
      hasEmail: Boolean(email),
      customerMatch: Boolean(customers?.length),
      suppressed: Boolean(leadSupp?.length || dripSupp?.length),
      humanReply: Boolean(inbound?.length),
      negativeDelivery: Boolean(negative?.length),
      lastAcceptedAt,
    },
  });
}

async function main() {
  if (!batchId) throw new Error('--batch is required');
  if (APPLY && confirmation !== FGA_TENANT_ID) throw new Error('Exact FGA tenant confirmation is required');
  const db = getServiceClient();
  const batch = await required(db.from('growth_restart_batches').select('*')
    .eq('tenant_id', FGA_TENANT_ID).eq('id', batchId).maybeSingle(), 'restart batch');
  if (!batch || batch.status !== 'validated') throw new Error('Batch is missing or is not in validated state');
  if (batch.sequence_plan_key !== sevenTouch.PLAN_KEY) throw new Error('Batch does not target the canonical seven-touch plan');

  const campaign = await required(db.from('drip_campaigns').select('id, status, plan_key')
    .eq('tenant_id', FGA_TENANT_ID).eq('status', 'active').eq('plan_key', sevenTouch.PLAN_KEY).limit(1).maybeSingle(), 'active campaign');
  if (!campaign) throw new Error('Canonical seven-touch campaign is not active; restart remains blocked');
  const tenant = await resolveTenant(db, FGA_TENANT_ID);
  if (String(tenant?.config?.autosend_paused) !== 'true') {
    throw new Error('autosend_paused must be true while a restart batch is prepared');
  }

  const candidatesRes = await fetchAllRows((from, to) => db.from('growth_restart_candidates')
    .select('id, lead_id, evidence').eq('tenant_id', FGA_TENANT_ID).eq('batch_id', batchId)
    .eq('decision', 'eligible').order('id', { ascending: true }).range(from, to));
  if (candidatesRes.error || candidatesRes.truncated) throw candidatesRes.error || new Error('Candidate inventory truncated');

  const valid = [];
  const invalid = [];
  for (const candidate of candidatesRes.data) {
    const lead = await required(db.from('leads').select('id, lead_source, status, lifecycle_stage, employee_count_actual, size, lead_score, outreach_ready, email, metadata')
      .eq('tenant_id', FGA_TENANT_ID).eq('id', candidate.lead_id).maybeSingle(), 'lead');
    if (!lead) { invalid.push({ candidate, reason: 'lead_missing' }); continue; }
    const verdict = await revalidate(db, lead);
    if (verdict.decision === 'eligible') valid.push({ candidate, lead, verdict });
    else invalid.push({ candidate, reason: verdict.reason });
  }

  const summary = {
    tenant_scope: 'FGA_ONLY', batch_id: batchId,
    originally_eligible: candidatesRes.data.length,
    still_eligible: valid.length,
    revalidation_excluded: invalid.reduce((out, row) => ({ ...out, [row.reason]: (out[row.reason] || 0) + 1 }), {}),
    sends_messages: false,
    autosend_must_remain_paused: true,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) return;

  // The restart manifest is already an explicit authorization boundary. If a
  // second manual-approval system would hold the jobs after lead state changes,
  // stop before writing anything so the batch cannot become half-applied.
  if (flags.manualBatchApproval() && valid.length >= thresholds.batchApprovalThreshold()) {
    throw new Error('AI manual batch approval would hold the restart jobs; approve or raise that limit before applying this manifest');
  }

  const now = new Date().toISOString();
  const claimed = await required(db.from('growth_restart_batches').update({ status: 'applying' })
    .eq('tenant_id', FGA_TENANT_ID).eq('id', batchId).eq('status', 'validated')
    .select('id, status').maybeSingle(), 'claim batch');
  if (!claimed?.id) throw new Error('Batch claim lost; another operator may already be applying it');

  for (const row of invalid) {
    const excluded = await required(db.from('growth_restart_candidates').update({ decision: 'excluded', reason: `revalidation:${row.reason}` })
      .eq('tenant_id', FGA_TENANT_ID).eq('id', row.candidate.id)
      .select('id').maybeSingle(), 'exclude stale candidate');
    if (!excluded?.id) throw new Error(`Candidate exclusion did not persist: ${row.candidate.id}`);
  }

  for (const { candidate, lead } of valid) {
    await required(db.from('drip_enrollments').update({
      status: 'stopped', stopped_reason: `approved_restart:${batchId}`, stopped_by: 'growth-restart',
      next_step_day: null, next_send_at: null, updated_at: now,
    }).eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).in('status', ['active', 'paused', 'review']), 'stop old enrollment');
    await required(db.from('outreach_sequences').update({ sequence_status: 'superseded', updated_at: now })
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).eq('sequence_status', 'draft'), 'supersede old drafts');
    const resetLead = await required(db.from('leads').update({
      status: 'new_lead', lifecycle_stage: 'scored', automation_status: 'restart_queued',
      metadata: { ...(lead.metadata || {}), growth_restart: { batch_id: batchId, authorized_at: now } },
      updated_at: now,
    }).eq('tenant_id', FGA_TENANT_ID).eq('id', lead.id)
      .select('id').maybeSingle(), 'reset lead');
    if (!resetLead?.id) throw new Error(`Lead reset did not persist: ${lead.id}`);
    const authorized = await required(db.from('growth_restart_candidates').update({ authorized_at: now, applied_at: now })
      .eq('tenant_id', FGA_TENANT_ID).eq('id', candidate.id).is('authorized_at', null)
      .select('id').maybeSingle(), 'authorize candidate');
    if (!authorized?.id) throw new Error(`Candidate authorization did not persist: ${candidate.id}`);
  }

  await required(db.from('growth_restart_batches').update({
    applied_at: now,
    applied_summary: { ...summary, authorized: valid.length, outreach_jobs: 'pending_enqueue' },
  }).eq('tenant_id', FGA_TENANT_ID).eq('id', batchId).eq('status', 'applying'), 'record authorized candidates');

  const queue = await guardedEnqueue({
    tenantId: FGA_TENANT_ID,
    agentName: 'outreach',
    items: valid.map(({ lead }) => ({
      lead_id: lead.id,
      limit: 1,
      restart_batch_id: batchId,
      skip_recycle: true,
      skip_send_handoff: true,
    })),
    source: 'manual_script',
    reason: `approved_growth_restart:${batchId}`,
    createdBy: 'codex:growth-engine-overhaul',
    priority: 7,
  });
  if (!queue.ok || queue.enqueued !== valid.length) {
    await required(db.from('growth_restart_batches').update({ status: 'failed', applied_summary: { ...summary, queue } })
      .eq('tenant_id', FGA_TENANT_ID).eq('id', batchId).eq('status', 'applying'), 'mark failed restart batch');
    throw new Error(`Restart jobs were not fully enqueued (${queue.enqueued}/${valid.length}); autosend remains paused`);
  }
  const completed = await required(db.from('growth_restart_batches').update({
    status: 'completed', applied_at: now,
    applied_summary: { ...summary, authorized: valid.length, queue },
  }).eq('tenant_id', FGA_TENANT_ID).eq('id', batchId).eq('status', 'applying')
    .select('id').maybeSingle(), 'complete restart batch');
  if (!completed?.id) throw new Error('Restart jobs were queued but completion receipt did not persist; autosend must remain paused');
  console.log(JSON.stringify({ applied: true, authorized: valid.length, queued_draft_jobs: queue.enqueued, sends_messages: false }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
