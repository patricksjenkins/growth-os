/**
 * Revenue & Sales — Seven-touch sequence continuity recovery.
 *
 * The legacy campaign retirement correctly stopped unsafe old enrollments, but
 * it left provider-accepted prospects in `contacted` with no current follow-up
 * owner. This FGA-only agent repairs that discontinuity without repeating the
 * first email. It enrolls a small daily cohort at touch 2 (Day 3) of the
 * canonical plan; the ordinary drip sender later performs every send-time
 * customer, suppression, reply, identity, and provider check again.
 *
 * It never sends an email. Default-off flag: sequence_recovery_enabled.
 */
'use strict';

const { getServiceClient, fetchAllRows } = require('../../db/client');
const { FGA_TENANT_ID, getConfig } = require('../../core/config');
const { createLogger } = require('../../core/logger');
const { isProspectSource } = require('../../core/lead-sources');
const { evaluateEmployeeFit } = require('../../core/growth/eligibility');
const { isSyntheticGrowthLead } = require('../../core/growth/production-evidence');
const {
  normalizeEmail,
  normalizeDomain,
  normalizeName,
} = require('../../core/growth/suppression');
const {
  loadProtectedOrganizationIndex,
  matchProtectedOrganization,
} = require('../../core/growth/customer-boundary');
const drip = require('../../core/drip-campaign');
const sevenTouch = require('../../core/growth/seven-touch-plan');
const {
  REPAIR_TASK,
  persistContinuity,
  linkRestartEnrollment,
} = require('../../core/revenue/first-touch-continuity');

const DEFAULT_DAILY_LIMIT = 5;
const MAX_DAILY_LIMIT = 25;
const OPEN_ENROLLMENT_STATUSES = new Set(['active', 'paused', 'review']);
const NEGATIVE_DELIVERY_EVENTS = new Set(['bounced', 'complained', 'failed', 'suppressed']);
const HUMAN_REPLY_CLASSES = new Set(['genuine_reply', 'ambiguous', 'unsubscribe']);

function etDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function dailyRecoveryBudget(enrollments = [], { limit = DEFAULT_DAILY_LIMIT, now = new Date() } = {}) {
  const today = etDateKey(now);
  const recoveredToday = enrollments.filter((row) =>
    row.enrolled_by === 'sequence-recovery' && etDateKey(row.created_at) === today).length;
  return {
    daily_limit: limit,
    recovered_today: recoveredToday,
    remaining: Math.max(0, limit - recoveredToday),
  };
}

function providerFirstTouch(sequence = {}) {
  if (sequence.sequence_status !== 'sent') return null;
  const delivered = sequence.metadata?.delivered;
  if (!delivered?.provider_id || !delivered?.at) return null;
  const at = new Date(delivered.at);
  if (Number.isNaN(at.getTime())) return null;
  const recipient = normalizeEmail(delivered.recipient);
  return { at: at.toISOString(), ...(recipient ? { recipient } : {}) };
}

function classifyContinuityCandidate({
  tenantId,
  lead,
  providerAcceptedFirstTouch = null,
  hasOpenEnrollment = false,
  protectedCustomer = false,
  suppressed = false,
  negativeDelivery = false,
  humanReply = false,
} = {}) {
  const reject = (reason) => ({ eligible: false, reason });
  if (tenantId !== FGA_TENANT_ID) return reject('wrong_tenant');
  if (!lead || isSyntheticGrowthLead(lead)) return reject('synthetic_or_missing');
  if (!isProspectSource(lead.lead_source)) return reject('not_outbound_prospect');
  if (lead.status !== 'contacted') return reject('not_contacted');
  if (['customer', 'unqualified'].includes(lead.lifecycle_stage)) return reject('terminal_lifecycle');
  if (['bounced', 'unsubscribed', 'blocked_suppressed'].includes(lead.automation_status)) {
    return reject('negative_automation_state');
  }
  if (hasOpenEnrollment) return reject('already_enrolled');
  if (protectedCustomer) return reject('protected_customer');
  if (suppressed) return reject('suppressed');
  if (negativeDelivery) return reject('negative_delivery');
  if (humanReply) return reject('human_reply');
  if (!normalizeEmail(lead.email)) return reject('email_missing');
  if (!providerAcceptedFirstTouch) return reject('first_touch_not_provider_proven');

  const fit = evaluateEmployeeFit(lead);
  if (!fit.eligible) return reject(fit.decision === 'needs_evidence' ? 'employee_evidence_missing' : 'employee_fit_excluded');
  if (Number(lead.lead_score) < 60 || lead.outreach_ready !== true) return reject('below_quality_threshold');

  return {
    eligible: true,
    reason: 'provider_proven_contact_needs_current_sequence',
    original_first_touch_at: providerAcceptedFirstTouch.at,
  };
}

async function allRows(db, table, fields, build = (query) => query) {
  const result = await fetchAllRows((from, to) => build(
    db.from(table).select(fields).eq('tenant_id', FGA_TENANT_ID),
  ).order('id', { ascending: true }).range(from, to), { cap: 10000 });
  if (result.error || result.truncated) {
    throw result.error || new Error(`${table}_inventory_truncated`);
  }
  return result.data;
}

/**
 * Repair one provider-accepted first touch immediately. This path is invoked
 * only by the send choke point after its enrollment write could not be
 * verified. It performs database reads/writes only, has no daily catch-up cap,
 * and always anchors Day 3 to the original provider timestamp.
 */
async function reconcileFirstTouch(db, tenant, payload, campaign, log, deps = {}) {
  const loadProtected = deps.loadProtectedOrganizationIndex || loadProtectedOrganizationIndex;
  const readSuppression = deps.isSuppressed || drip.isSuppressed;
  const enroll = deps.enrollLead || drip.enrollLead;
  const persist = deps.persistContinuity || persistContinuity;
  const linkRestart = deps.linkRestartEnrollment || linkRestartEnrollment;
  if (tenant?.id !== FGA_TENANT_ID) {
    return { success: true, skipped: true, reason: 'not_fga_tenant', sends_messages: false };
  }
  const leadId = payload.lead_id;
  const sequenceId = payload.sequence_id;
  if (!leadId || !sequenceId) {
    return { success: false, error: 'targeted continuity repair requires lead_id and sequence_id' };
  }

  const [sequenceResult, leadResult, openResult] = await Promise.all([
    db.from('outreach_sequences').select('id, lead_id, sequence_status, metadata')
      .eq('tenant_id', FGA_TENANT_ID).eq('id', sequenceId).eq('lead_id', leadId)
      .maybeSingle(),
    db.from('leads')
      .select('id, company_name, domain, email, lead_source, status, lifecycle_stage, automation_status, employee_count_actual, size, lead_score, outreach_ready, metadata, created_at')
      .eq('tenant_id', FGA_TENANT_ID).eq('id', leadId).maybeSingle(),
    db.from('drip_enrollments').select('id, status')
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', leadId)
      .in('status', ['active', 'paused', 'review']).limit(1).maybeSingle(),
  ]);
  if (sequenceResult.error || leadResult.error || openResult.error) {
    return { success: false, error: 'targeted continuity evidence unavailable' };
  }
  const sequence = sequenceResult.data;
  const lead = leadResult.data;
  if (!sequence || !lead) return { success: false, error: 'targeted continuity identity not found' };

  const providerEvidence = providerFirstTouch(sequence);
  if (!providerEvidence) return { success: false, error: 'first touch is not provider proven' };
  const effectiveEmail = normalizeEmail(lead.email) || providerEvidence.recipient;
  const candidateLead = { ...lead, email: effectiveEmail };

  if (openResult.data?.id) {
    const state = {
      status: 'enrolled_existing',
      enrollment_id: openResult.data.id,
      reason: 'already_enrolled',
    };
    await persist(db, { sequenceId, metadata: sequence.metadata, state });
    await linkRestart(db, {
      restartBatchId: sequence.metadata?.restart_batch_id || null,
      leadId,
      sequenceId,
      enrollmentId: openResult.data.id,
    });
    return { success: true, repaired: false, already_enrolled: true, sends_messages: false };
  }

  const [protectedIndex, suppressionReason, inboundResult, deliveryResult] = await Promise.all([
    loadProtected(db),
    readSuppression(db, effectiveEmail, candidateLead),
    db.from('drip_inbound').select('id')
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', leadId)
      .in('classification', [...HUMAN_REPLY_CLASSES]).limit(1),
    effectiveEmail
      ? db.from('email_events').select('id')
        .eq('tenant_id', FGA_TENANT_ID).eq('recipient', effectiveEmail)
        .in('event', [...NEGATIVE_DELIVERY_EVENTS]).limit(1)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (inboundResult.error || deliveryResult.error) {
    return { success: false, error: 'targeted continuity safety evidence unavailable' };
  }
  const protectedCustomer = matchProtectedOrganization(protectedIndex, {
    email: effectiveEmail,
    companyName: lead.company_name,
  }).protected;
  const verdict = classifyContinuityCandidate({
    tenantId: tenant.id,
    lead: candidateLead,
    providerAcceptedFirstTouch: providerEvidence,
    hasOpenEnrollment: false,
    protectedCustomer,
    suppressed: Boolean(suppressionReason),
    negativeDelivery: Boolean(deliveryResult.data?.length),
    humanReply: Boolean(inboundResult.data?.length),
  });
  if (!verdict.eligible) {
    const terminalReasons = new Set(['protected_customer', 'suppressed', 'negative_delivery', 'human_reply', 'terminal_lifecycle', 'negative_automation_state']);
    const status = terminalReasons.has(verdict.reason) ? 'terminal' : 'pending_reconciliation';
    await persist(db, {
      sequenceId,
      metadata: sequence.metadata,
      state: { status, enrollment_id: null, reason: verdict.reason },
    });
    return {
      success: status === 'terminal',
      repaired: false,
      terminal: status === 'terminal',
      reason: verdict.reason,
      sends_messages: false,
      ...(status === 'terminal' ? {} : { error: `continuity held:${verdict.reason}` }),
    };
  }

  const result = await enroll(db, {
    leadId,
    email: effectiveEmail,
    day1At: providerEvidence.at,
    enrolledBy: 'first-touch-reconciliation',
    tenant,
    lead: candidateLead,
  });
  if (!result.enrolled || !result.enrollment?.id) {
    await persist(db, {
      sequenceId,
      metadata: sequence.metadata,
      state: {
        status: 'pending_reconciliation',
        enrollment_id: null,
        reason: result.skipped_reason || 'enrollment_failed',
      },
    });
    return {
      success: false,
      repaired: false,
      sends_messages: false,
      error: `continuity enrollment failed:${result.skipped_reason || 'unknown'}`,
    };
  }

  const state = { status: 'enrolled', enrollment_id: result.enrollment.id, reason: null };
  await persist(db, { sequenceId, metadata: sequence.metadata, state });
  await linkRestart(db, {
    restartBatchId: sequence.metadata?.restart_batch_id || null,
    leadId,
    sequenceId,
    enrollmentId: result.enrollment.id,
  });
  log.success(`Reconciled seven-touch enrollment for provider-accepted sequence ${sequenceId}`);
  return {
    success: true,
    repaired: true,
    sends_messages: false,
    next_touch_day: 3,
    original_first_touch_at: providerEvidence.at,
    campaign_id: campaign.id,
  };
}

async function run(tenant, payload = {}) {
  const log = createLogger('sequence-recovery', tenant?.slug || 'unknown');
  if (tenant?.id !== FGA_TENANT_ID) {
    return { success: true, skipped: true, reason: 'not_fga_tenant' };
  }
  if (String(getConfig(tenant, 'sequence_recovery_enabled', 'false')) !== 'true') {
    return { success: true, skipped: true, reason: 'feature_disabled' };
  }
  if (!drip.isDripEnabled(tenant)) {
    return { success: true, skipped: true, reason: 'drip_disabled' };
  }

  const requested = Number(payload.limit || getConfig(tenant, 'sequence_recovery_daily_limit', DEFAULT_DAILY_LIMIT));
  const limit = Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, MAX_DAILY_LIMIT)
    : DEFAULT_DAILY_LIMIT;
  const db = getServiceClient();

  const campaign = await db.from('drip_campaigns')
    .select('id, plan_key, status').eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'active').eq('plan_key', drip.PLAN_KEY).limit(1).maybeSingle();
  if (campaign.error || !campaign.data?.id) {
    throw campaign.error || new Error('canonical_seven_touch_campaign_not_active');
  }

  if (payload.task === REPAIR_TASK) {
    return reconcileFirstTouch(db, tenant, payload, campaign.data, log);
  }

  const [leads, sequences, enrollments, leadSuppressions, dripSuppressions, inbound, emailEvents, dripSends, protectedIndex] = await Promise.all([
    allRows(db, 'leads', 'id, company_name, domain, email, lead_source, status, lifecycle_stage, automation_status, employee_count_actual, size, lead_score, outreach_ready, metadata, created_at', q => q.eq('status', 'contacted')),
    allRows(db, 'outreach_sequences', 'id, lead_id, sequence_status, metadata, created_at', q => q.eq('sequence_status', 'sent')),
    allRows(db, 'drip_enrollments', 'id, lead_id, status, campaign_id, enrolled_by, created_at'),
    allRows(db, 'lead_suppressions', 'id, lead_id, email, domain, company_name, channel'),
    allRows(db, 'drip_suppressions', 'id, email'),
    allRows(db, 'drip_inbound', 'id, lead_id, classification'),
    allRows(db, 'email_events', 'id, recipient, event'),
    allRows(db, 'drip_sends', 'id, lead_id, status'),
    loadProtectedOrganizationIndex(db),
  ]);

  const firstTouch = new Map();
  for (const sequence of sequences) {
    const evidence = providerFirstTouch(sequence);
    if (!evidence || !sequence.lead_id) continue;
    const previous = firstTouch.get(sequence.lead_id);
    if (!previous || evidence.at > previous.at) {
      firstTouch.set(sequence.lead_id, {
        ...evidence,
        sequence_id: sequence.id,
        sequence_metadata: sequence.metadata || {},
      });
    }
  }
  const openEnrollments = new Set(enrollments
    .filter(row => OPEN_ENROLLMENT_STATUSES.has(row.status))
    .map(row => row.lead_id));
  const emailSuppressionRows = leadSuppressions.filter(row => !row.channel || row.channel === 'all' || row.channel === 'email');
  const suppressedLeads = new Set(emailSuppressionRows.map(row => row.lead_id).filter(Boolean));
  const suppressedEmails = new Set([
    ...emailSuppressionRows.map(row => normalizeEmail(row.email)),
    ...dripSuppressions.map(row => normalizeEmail(row.email)),
  ].filter(Boolean));
  const suppressedDomains = new Set(emailSuppressionRows
    .map(row => normalizeDomain(row.domain)).filter(Boolean));
  const suppressedCompanies = new Set(emailSuppressionRows
    .map(row => normalizeName(row.company_name)).filter(Boolean));
  const replyLeads = new Set(inbound
    .filter(row => HUMAN_REPLY_CLASSES.has(row.classification))
    .map(row => row.lead_id));
  const negativeEmails = new Set(emailEvents
    .filter(row => NEGATIVE_DELIVERY_EVENTS.has(row.event))
    .map(row => normalizeEmail(row.recipient)).filter(Boolean));
  const priorFollowups = new Map();
  for (const send of dripSends) {
    if (send.status !== 'sent' || !send.lead_id) continue;
    priorFollowups.set(send.lead_id, (priorFollowups.get(send.lead_id) || 0) + 1);
  }

  const reasonCounts = {};
  const eligible = [];
  for (const lead of leads) {
    const evidence = firstTouch.get(lead.id) || null;
    const email = normalizeEmail(lead.email) || evidence?.recipient || null;
    const candidateLead = { ...lead, email };
    const domain = normalizeDomain(lead.domain || (email ? email.split('@')[1] : null));
    const companyName = normalizeName(lead.company_name);
    const verdict = classifyContinuityCandidate({
      tenantId: tenant.id,
      lead: candidateLead,
      providerAcceptedFirstTouch: evidence,
      hasOpenEnrollment: openEnrollments.has(lead.id),
      protectedCustomer: matchProtectedOrganization(protectedIndex, {
        email,
        companyName: lead.company_name,
      }).protected,
      suppressed: suppressedLeads.has(lead.id) || suppressedEmails.has(email) ||
        suppressedDomains.has(domain) || suppressedCompanies.has(companyName),
      negativeDelivery: negativeEmails.has(email),
      humanReply: replyLeads.has(lead.id),
    });
    if (verdict.eligible) eligible.push({ lead: candidateLead, verdict, evidence });
    else reasonCounts[verdict.reason] = (reasonCounts[verdict.reason] || 0) + 1;
  }

  // Existing inventory first, then the oldest proven first touch. This gives
  // dormant prospects continuity before newly contacted prospects while never
  // changing the send-time safety boundary.
  eligible.sort((a, b) => {
    const oldA = Date.parse(a.lead.created_at || '') < Date.parse(sevenTouch.DATABASE_FIRST_CUTOFF) ? 0 : 1;
    const oldB = Date.parse(b.lead.created_at || '') < Date.parse(sevenTouch.DATABASE_FIRST_CUTOFF) ? 0 : 1;
    return oldA - oldB || a.verdict.original_first_touch_at.localeCompare(b.verdict.original_first_touch_at);
  });

  const recoveryBudget = dailyRecoveryBudget(enrollments, { limit });
  const selected = eligible.slice(0, recoveryBudget.remaining);
  if (payload.dry_run) {
    return {
      success: true,
      skipped: true,
      reason: 'dry_run',
      dry_run: true,
      sends_messages: false,
      inspected: leads.length,
      eligible: eligible.length,
      would_enroll: selected.length,
      deferred: Math.max(0, eligible.length - selected.length),
      recovery_budget: recoveryBudget,
      excluded_by_reason: reasonCounts,
      next_touch_day: 3,
      plan_key: drip.PLAN_KEY,
    };
  }
  if (recoveryBudget.remaining <= 0) {
    return {
      success: true,
      skipped: true,
      reason: 'daily_recovery_cap_reached',
      sends_messages: false,
      inspected: leads.length,
      eligible: eligible.length,
      deferred: eligible.length,
      recovery_budget: recoveryBudget,
      next_touch_day: 3,
      plan_key: drip.PLAN_KEY,
    };
  }
  const recoveredAt = new Date().toISOString();
  let enrolled = 0;
  let raced = 0;
  const failures = [];
  for (const { lead, verdict, evidence } of selected) {
    const result = await drip.enrollLead(db, {
      leadId: lead.id,
      email: lead.email,
      // Legacy continuity recovery deliberately starts a fresh Day-3 clock
      // from the bounded recovery date. Only the immediate targeted repair
      // above preserves the original provider timestamp; applying that rule
      // to months-old legacy contacts would make their first follow-up due
      // immediately and create an unsafe catch-up burst.
      day1At: recoveredAt,
      startAtDay: 3,
      catchUp: true,
      enrolledBy: 'sequence-recovery',
      tenant,
      lead,
    });
    if (result.enrolled && result.enrollment?.id) {
      const metadata = {
        ...(result.enrollment.metadata || {}),
        continuity_recovery: {
          policy: 'provider-proven-seven-touch-v1',
          recovered_at: recoveredAt,
          original_first_touch_at: verdict.original_first_touch_at,
          prior_followups: priorFollowups.get(lead.id) || 0,
          repeats_first_touch: false,
        },
      };
      const evidenceWrite = await db.from('drip_enrollments').update({ metadata })
        .eq('tenant_id', FGA_TENANT_ID).eq('id', result.enrollment.id)
        .eq('status', 'active').select('id').maybeSingle();
      if (evidenceWrite.error || !evidenceWrite.data?.id) {
        failures.push('enrollment_evidence_write_failed');
      } else {
        try {
          await persistContinuity(db, {
            sequenceId: evidence.sequence_id,
            metadata: evidence.sequence_metadata,
            state: { status: 'enrolled', enrollment_id: result.enrollment.id, reason: null },
          });
          await linkRestartEnrollment(db, {
            restartBatchId: evidence.sequence_metadata?.restart_batch_id || null,
            leadId: lead.id,
            sequenceId: evidence.sequence_id,
            enrollmentId: result.enrollment.id,
          });
          enrolled += 1;
        } catch (_) {
          failures.push('continuity_receipt_write_failed');
        }
      }
    } else if (result.skipped_reason === 'already_enrolled') {
      raced += 1;
    } else {
      failures.push(String(result.skipped_reason || 'enrollment_failed').split(':')[0]);
    }
  }

  const summary = {
    success: failures.length === 0,
    sends_messages: false,
    inspected: leads.length,
    eligible: eligible.length,
    enrolled,
    deferred: Math.max(0, eligible.length - selected.length),
    raced,
    excluded_by_reason: reasonCounts,
    failures: failures.length,
    recovery_budget: {
      ...recoveryBudget,
      recovered_after_run: recoveryBudget.recovered_today + enrolled,
      remaining_after_run: Math.max(0, recoveryBudget.remaining - enrolled),
    },
    next_touch_day: 3,
    plan_key: drip.PLAN_KEY,
  };
  log.info('Sequence continuity recovery complete', summary);
  if (failures.length) summary.error = 'sequence recovery was incomplete';
  return summary;
}

module.exports = run;
module.exports._test = {
  classifyContinuityCandidate,
  providerFirstTouch,
  dailyRecoveryBudget,
  etDateKey,
  DEFAULT_DAILY_LIMIT,
  MAX_DAILY_LIMIT,
  reconcileFirstTouch,
};
