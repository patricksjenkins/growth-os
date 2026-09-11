/**
 * Revenue & Sales — Existing Prospect Restart Agent
 *
 * Converts the reviewed FGA restart manifest into one bounded daily drafting
 * cohort. It never calls an email provider. The autonomous sender remains the
 * only first-touch dispatch authority and re-runs every safety/quality gate.
 *
 * Existing customer and customer-tenant identities fail closed. Historical
 * enrollments are stopped, not deleted; the new seven-touch campaign starts
 * only after a provider-accepted first touch.
 */
'use strict';

const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID, getConfig } = require('../../core/config');
const { normalizeEmail } = require('../../core/growth/suppression');
const { classifyRestartCandidate } = require('../../core/growth/restart-policy');
const {
  loadProtectedOrganizationIndex,
  matchProtectedOrganization,
} = require('../../core/growth/customer-boundary');
const { guardedEnqueue } = require('../../core/ai-safety/guarded-enqueue');
const sevenTouch = require('../../core/growth/seven-touch-plan');
const { createLogger } = require('../../core/logger');

const DAILY_LIMIT = sevenTouch.VOLUME.initial_daily_cap;
const MAX_REVALIDATIONS = DAILY_LIMIT * 4;

async function required(builder, label) {
  const result = await builder;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

async function revalidate(db, lead, protectedOrganizations) {
  const contacts = await required(db.from('contacts').select('email')
    .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id)
    .not('email', 'is', null).limit(5), 'contacts');
  const email = normalizeEmail(lead.email)
    || (contacts || []).map(row => normalizeEmail(row.email)).find(Boolean)
    || null;
  const [leadSupp, dripSupp, inbound, negative, sent] = await Promise.all([
    required(db.from('lead_suppressions').select('id')
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).limit(1), 'lead_suppressions'),
    required(db.from('drip_suppressions').select('id')
      .eq('tenant_id', FGA_TENANT_ID).eq('email', email || '__missing__').limit(1), 'drip_suppressions'),
    required(db.from('drip_inbound').select('id, classification')
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id)
      .in('classification', ['genuine_reply', 'ambiguous', 'unsubscribe']).limit(1), 'drip_inbound'),
    required(db.from('email_events').select('id')
      .eq('tenant_id', FGA_TENANT_ID).eq('recipient', email || '__missing__')
      .in('event', ['bounced', 'complained', 'suppressed', 'failed']).limit(1), 'email_events'),
    required(db.from('outreach_sequences').select('created_at, metadata')
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id)
      .eq('sequence_status', 'sent').order('created_at', { ascending: false }).limit(1), 'outreach_sequences'),
  ]);
  const latest = sent?.[0];
  const lastAcceptedAt = latest?.metadata?.delivered?.at
    || latest?.metadata?.sent_at || latest?.created_at || null;
  return classifyRestartCandidate({
    tenantId: FGA_TENANT_ID,
    lead,
    context: {
      hasEmail: Boolean(email),
      customerMatch: matchProtectedOrganization(protectedOrganizations, {
        email, companyName: lead.company_name,
      }).protected,
      suppressed: Boolean(leadSupp?.length || dripSupp?.length),
      humanReply: Boolean(inbound?.length),
      negativeDelivery: Boolean(negative?.length),
      lastAcceptedAt,
    },
  });
}

async function run(tenant, payload = {}) {
  const log = createLogger('growth-restart', tenant.slug);
  if (tenant.id !== FGA_TENANT_ID) {
    return { success: true, skipped: true, reason: 'not_fga_tenant' };
  }
  if (String(getConfig(tenant, 'autonomous_outreach_enabled', 'false')) !== 'true') {
    return { success: true, skipped: true, reason: 'autonomous_outreach_disabled' };
  }

  const requested = Number(payload.limit || DAILY_LIMIT);
  const limit = Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, DAILY_LIMIT) : DAILY_LIMIT;
  const db = getServiceClient();
  const batch = await required(db.from('growth_restart_batches').select('id, status, sequence_plan_key')
    .eq('tenant_id', FGA_TENANT_ID).eq('status', 'completed')
    .eq('sequence_plan_key', sevenTouch.PLAN_KEY)
    .order('created_at', { ascending: false }).limit(1).maybeSingle(), 'restart_batch');
  if (!batch?.id) return { success: true, skipped: true, reason: 'no_reviewed_restart_manifest' };

  const campaign = await required(db.from('drip_campaigns').select('id')
    .eq('tenant_id', FGA_TENANT_ID).eq('status', 'active')
    .eq('plan_key', sevenTouch.PLAN_KEY).limit(1).maybeSingle(), 'canonical_campaign');
  if (!campaign?.id) throw new Error('canonical seven-touch campaign is not active');

  // Never stack a second cohort while any prior authorization is unconsumed.
  const pending = await db.from('growth_restart_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', FGA_TENANT_ID).eq('batch_id', batch.id)
    .not('authorized_at', 'is', null).is('first_touch_sent_at', null);
  if (pending.error) throw new Error(`pending_restart_inventory:${pending.error.message}`);
  if ((pending.count || 0) > 0) {
    return { success: true, skipped: true, reason: 'prior_cohort_not_consumed', pending: pending.count };
  }

  const candidates = await required(db.from('growth_restart_candidates')
    .select('id, lead_id, evidence').eq('tenant_id', FGA_TENANT_ID)
    .eq('batch_id', batch.id).eq('decision', 'eligible')
    .is('authorized_at', null).order('id', { ascending: true })
    .limit(MAX_REVALIDATIONS), 'restart_candidates');
  if (!candidates?.length) {
    return { success: true, skipped: true, reason: 'reviewed_manifest_exhausted', remaining: 0 };
  }

  candidates.sort((a, b) => Number(b.evidence?.priority_score || 0)
    - Number(a.evidence?.priority_score || 0));
  const protectedOrganizations = await loadProtectedOrganizationIndex(db);
  const selected = [];
  const invalid = [];
  for (const candidate of candidates) {
    const lead = await required(db.from('leads')
      .select('id, company_name, lead_source, status, lifecycle_stage, employee_count_actual, size, lead_score, outreach_ready, email, metadata, created_at')
      .eq('tenant_id', FGA_TENANT_ID).eq('id', candidate.lead_id).maybeSingle(), 'lead');
    if (!lead) {
      invalid.push({ candidate, reason: 'lead_missing' });
      continue;
    }
    const verdict = await revalidate(db, lead, protectedOrganizations);
    if (verdict.decision === 'eligible' && selected.length < limit) {
      selected.push({ candidate, lead });
    } else if (verdict.decision !== 'eligible') {
      invalid.push({ candidate, reason: verdict.reason });
    }
    if (selected.length >= limit) break;
  }

  for (const row of invalid) {
    const { error } = await db.from('growth_restart_candidates').update({
      decision: 'excluded', reason: `daily_revalidation:${row.reason}`,
    }).eq('tenant_id', FGA_TENANT_ID).eq('id', row.candidate.id).is('authorized_at', null);
    if (error) throw new Error(`candidate_exclusion:${error.message}`);
  }
  if (!selected.length) {
    return { success: true, skipped: true, reason: 'no_candidates_survived_revalidation', excluded: invalid.length };
  }

  const now = new Date().toISOString();
  for (const { candidate, lead } of selected) {
    let result = await db.from('drip_enrollments').update({
      status: 'stopped', stopped_reason: `approved_restart:${batch.id}`,
      stopped_by: 'growth-restart', next_step_day: null, next_send_at: null, updated_at: now,
    }).eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id)
      .in('status', ['active', 'paused', 'review']);
    if (result.error) throw new Error(`old_enrollment_stop:${result.error.message}`);
    result = await db.from('outreach_sequences').update({ sequence_status: 'superseded', updated_at: now })
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', lead.id).eq('sequence_status', 'draft');
    if (result.error) throw new Error(`old_draft_supersede:${result.error.message}`);
    result = await db.from('leads').update({
      status: 'new_lead', lifecycle_stage: 'scored', automation_status: 'restart_queued',
      metadata: { ...(lead.metadata || {}), growth_restart: { batch_id: batch.id, authorized_at: now } },
      updated_at: now,
    }).eq('tenant_id', FGA_TENANT_ID).eq('id', lead.id).select('id').maybeSingle();
    if (result.error || !result.data?.id) throw result.error || new Error('lead reset did not persist');
    result = await db.from('growth_restart_candidates').update({ authorized_at: now, applied_at: now })
      .eq('tenant_id', FGA_TENANT_ID).eq('id', candidate.id)
      .is('authorized_at', null).select('id').maybeSingle();
    if (result.error || !result.data?.id) throw result.error || new Error('candidate authorization did not persist');
  }

  const queue = await guardedEnqueue({
    tenantId: FGA_TENANT_ID,
    agentName: 'outreach',
    items: selected.map(({ lead }) => ({
      lead_id: lead.id,
      limit: 1,
      restart_batch_id: batch.id,
      skip_recycle: true,
      skip_send_handoff: true,
    })),
    source: 'growth_restart_agent',
    reason: `daily_existing_prospect_cohort:${batch.id}`,
    createdBy: 'growth-restart',
    priority: 7,
  });
  if (!queue.ok || queue.pendingApproval || queue.enqueued !== selected.length) {
    throw new Error(`restart draft queue incomplete:${queue.enqueued}/${selected.length}`);
  }

  await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'growth-restart',
    action: 'daily_restart_cohort_authorized',
    entity_type: 'growth_restart_batch',
    entity_id: batch.id,
    level: 'info',
    metadata: {
      sequence_plan_key: sevenTouch.PLAN_KEY,
      authorized: selected.length,
      revalidation_excluded: invalid.length,
      sends_messages: false,
    },
  }).then(() => {}, error => log.warn(`restart evidence write failed:${error.message}`));

  return {
    success: true,
    authorized: selected.length,
    queued_draft_jobs: queue.enqueued,
    revalidation_excluded: invalid.length,
    sends_messages: false,
    outcome_contract: {
      result_state: 'succeeded',
      output_state: 'produced',
      business_outcome_state: 'in_progress',
      reason_code: 'existing_prospect_cohort_prepared',
      evidence: { authorized: selected.length, plan_key: sevenTouch.PLAN_KEY },
    },
  };
}

module.exports = run;
module.exports._test = { revalidate, DAILY_LIMIT, MAX_REVALIDATIONS };
