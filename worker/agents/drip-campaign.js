/**
 * First Gen Automate — Drip Campaign Agent
 *
 * Owns the automated prospect drip campaign end-to-end:
 *   payload.task = 'process_sends' (default)
 *     - auto-resumes OOO-paused enrollments whose paused_until has passed
 *     - finds enrollments with next_send_at <= now and sends the due touch
 *       points defined by the enrollment's immutable campaign version, with
 *       full pre-send rechecks + idempotent claims
 *     - the current plan is seven total touches: initial + six follow-ups
 *     - legacy coupon steps remain supported for existing campaign versions
 *     - after the long-term checkpoint: lead -> 'long_term_followup'
 *     - after the campaign's final step: enrollment completed,
 *       lead -> 'no_response', all automation stops
 *   payload.task = 'sync_replies'
 *     - polls the FGA Gmail inbox, classifies inbound (deterministic-first,
 *       AI fallback) and routes: reply->stop+Replied, OOO->pause,
 *       bounce->suppress+stop, unsubscribe->suppress, ambiguous->review
 *
 * FGA-internal: this agent is a no-op for every tenant except FGA.
 * Feature flag: tenant_config 'drip_campaign_enabled' — when false the agent
 * exits without touching anything (sends pause safely, nothing is lost).
 * Operational flag: 'drip_sends_paused' stops outbound follow-ups while reply
 * sync continues. This is the deployment/review containment switch.
 * payload.dry_run = true renders + reports without sending or mutating.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const drip = require('../../core/drip-campaign');
const sevenTouch = require('../../core/growth/seven-touch-plan');
const { loadProtectedOrganizationIndex } = require('../../core/growth/customer-boundary');
const { computeCapState, etDayStartIso } = require('../../core/auto-outreach');

// Eighteen 30-minute dispatch windows run each day so every supported U.S.
// time zone intersects the 09:00–11:30 prospect-local window. Thirty per run
// provides recovery headroom without widening the 150/day safety ceiling.
const MAX_SENDS_PER_RUN = 30;
// Scan beyond the send allowance so a poisoned head-of-queue cohort cannot
// occupy every slot forever. Failed rows are deferred/quarantined below; the
// same run can continue to healthy enrollments without exceeding send caps.
const MAX_CANDIDATES_PER_RUN = MAX_SENDS_PER_RUN * 4;
const MAX_FAILURES_PER_TOUCH = 3;

// Per-DAY cap. With 25 new starts every day and six later touches, the
// seven-touch contract needs 150 follow-up slots/day at steady state. The old
// cap of 30 guaranteed an unbounded backlog beginning with the first overlap
// of Day-3 and Day-7 cohorts. A deployment may lower this ceiling, but cannot
// raise it above the reviewed plan without a code change. The shared rolling
// deliverability breaker still throttles/stops below this ceiling when its
// evidence says sending reputation is at risk.
function configuredFollowupDailyCap(raw = process.env.DRIP_MAX_SENDS_PER_DAY) {
  if (raw == null || String(raw).trim() === '') return sevenTouch.VOLUME.followup_daily_cap;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return sevenTouch.VOLUME.followup_daily_cap;
  return Math.min(value, sevenTouch.VOLUME.followup_daily_cap);
}
const MAX_SENDS_PER_DAY = configuredFollowupDailyCap();

function dailyLimitForDeliverability(capState = {}) {
  if (capState.deliverabilityPaused) return 0;
  if (capState.throttled) {
    return Math.max(0, Math.min(MAX_SENDS_PER_DAY, Number(capState.dailyRemaining) || 0));
  }
  return MAX_SENDS_PER_DAY;
}

function publicDeliverabilityState(capState = {}) {
  return {
    mode: capState.deliverabilityPaused ? 'stop' : capState.throttled ? 'throttle' : 'ok',
    reason: capState.breakerReason || null,
    sent_7d: capState.sent7d ?? null,
    first_touches_7d: capState.firstTouches7d ?? null,
    followups_7d: capState.followups7d ?? null,
    hard_bounces_7d: capState.hardBounces7d ?? null,
    soft_bounces_7d: capState.softBounces7d ?? null,
    complaints_7d: capState.complaints7d ?? null,
    bounce_rate_7d: capState.bounceRate7d ?? null,
  };
}

async function reconcileDeliverabilityAttention(db, capState, log) {
  const type = 'autosend_deliverability';
  const { data: existing, error: readError } = await db.from('attention_queue')
    .select('id').eq('tenant_id', FGA_TENANT_ID).eq('type', type)
    .is('resolved_at', null).limit(1);
  if (readError) throw new Error(`drip_deliverability_attention_read_failed:${readError.message}`);

  if (capState.deliverabilityPaused) {
    const row = {
      severity: 'red',
      title: 'Prospect outreach paused by deliverability safety',
      summary: capState.detail,
      payload: publicDeliverabilityState(capState),
      produced_at: new Date().toISOString(),
    };
    if (existing?.length) {
      const { error } = await db.from('attention_queue').update(row)
        .eq('tenant_id', FGA_TENANT_ID).eq('id', existing[0].id);
      if (error) throw new Error(`drip_deliverability_attention_update_failed:${error.message}`);
    } else {
      const { error } = await db.from('attention_queue').insert({
        tenant_id: FGA_TENANT_ID,
        type,
        ...row,
        produced_by: 'drip-campaign',
      });
      if (error) throw new Error(`drip_deliverability_attention_insert_failed:${error.message}`);
    }
    return;
  }

  if (existing?.length) {
    const { error } = await db.from('attention_queue').update({
      resolved_at: new Date().toISOString(),
      resolution: 'auto_resolved',
      resolved_by_label: 'shared prospect deliverability breaker is clear',
    }).eq('tenant_id', FGA_TENANT_ID).eq('id', existing[0].id);
    if (error) log.warn(`Could not resolve deliverability attention: ${error.message}`);
  }
}

/**
 * Drip touches claimed today in the same ET day the sender uses. A `sending`
 * row may already have reached the provider, so it counts conservatively
 * until reconciled instead of widening the daily cap on uncertainty.
 */
async function claimedToday(db, now = new Date()) {
  const { count, error } = await db
    .from('drip_sends')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', FGA_TENANT_ID)
    .in('status', ['sent', 'sending'])
    .gte('created_at', etDayStartIso(now));
  if (error) throw new Error(`drip_daily_claim_count_failed:${error.message}`);
  return count || 0;
}

function resolveRunClock(payload = {}, fallback = new Date()) {
  if (!payload.as_of) return new Date(fallback);
  if (!payload.dry_run) throw new Error('as_of_requires_dry_run');
  const parsed = new Date(payload.as_of);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_dry_run_as_of');
  return parsed;
}

async function readResumableEnrollments(db, campaignId, now = new Date()) {
  const { data, error } = await db
    .from('drip_enrollments')
    .select('id')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('campaign_id', campaignId)
    .eq('status', 'paused')
    .not('paused_until', 'is', null)
    .lte('paused_until', now.toISOString());
  if (error) throw new Error(`drip_resumable_inventory_failed:${error.message}`);
  return data || [];
}

async function readDueEnrollments(db, campaignId, now = new Date()) {
  const { data, error } = await db
    .from('drip_enrollments')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('campaign_id', campaignId)
    .eq('status', 'active')
    .not('next_send_at', 'is', null)
    .lte('next_send_at', now.toISOString())
    .order('next_send_at', { ascending: true })
    .limit(MAX_CANDIDATES_PER_RUN);
  if (error) throw new Error(`drip_due_inventory_failed:${error.message}`);
  return data || [];
}

function isUniqueClaimConflict(error) {
  return error?.code === '23505'
    || /duplicate key|unique constraint|already exists/i.test(String(error?.message || ''));
}

async function claimDripSend(db, row) {
  const { data, error } = await db.from('drip_sends').insert(row).select().single();
  if (error) {
    if (isUniqueClaimConflict(error)) return { claimed: false, reason: 'touch_already_claimed' };
    throw new Error(`drip_send_claim_failed:${error.message}`);
  }
  if (!data?.id) throw new Error('drip_send_claim_failed:missing_claim_receipt');
  return { claimed: true, row: data };
}

async function persistAcceptedDripReceipt(db, { sendRowId, providerId, html, sentAt }) {
  const { data, error } = await db.from('drip_sends')
    .update({ status: 'sent', sent_at: sentAt, resend_id: providerId, body_html: html, updated_at: sentAt })
    .eq('id', sendRowId)
    .eq('tenant_id', FGA_TENANT_ID)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`drip_provider_receipt_persist_failed:${error.message}`);
  if (!data?.id) throw new Error('drip_provider_receipt_persist_failed:accepted receipt row missing');
  return data;
}

function dripOutcomeContract(results, candidateCount) {
  if (results.failed > 0) {
    return {
      result_state: 'failed',
      output_state: results.sent > 0 ? 'partial' : 'failed',
      business_outcome_state: results.sent > 0 ? 'provider_acceptance_partial' : 'blocked',
      reason_code: 'followup_delivery_failure',
      evidence: { candidates: candidateCount, sent: results.sent, failed: results.failed },
    };
  }
  if (results.sent > 0) {
    return {
      result_state: 'succeeded', output_state: 'produced',
      business_outcome_state: 'followups_provider_accepted', reason_code: 'due_followups_sent',
      evidence: { candidates: candidateCount, sent: results.sent },
    };
  }
  return {
    result_state: 'succeeded', output_state: 'no_op', business_outcome_state: 'not_due',
    reason_code: candidateCount === 0 ? 'no_due_followups' : 'due_followups_safely_withheld',
    evidence: {
      candidates: candidateCount, skipped: results.skipped,
      stopped: results.stopped, rescheduled: results.rescheduled,
    },
  };
}

/**
 * Historical enrollments are evidence, not permission. Resolve the one active
 * seven-touch campaign before any follow-up work; uncertainty fails closed.
 */
async function getCanonicalCampaign(db) {
  const { data, error } = await db.from('drip_campaigns')
    .select('id, version, plan_key, status')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'active')
    .eq('plan_key', drip.PLAN_KEY)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`canonical_drip_campaign_unavailable:${error.message}`);
  if (!data?.id) throw new Error('canonical_drip_campaign_unavailable:not_active');
  return data;
}

/**
 * The paused production backlog contained 553 immediately-due enrollments on
 * obsolete campaign versions. Quarantine them instead of letting a global
 * resume release old copy. Rows remain as history and can be admitted to the
 * new campaign only through the reviewed restart manifest.
 */
async function quarantineLegacyEnrollments(db, canonicalCampaignId, { dryRun = false } = {}) {
  const openStatuses = ['active', 'paused', 'review'];
  const inventory = await db.from('drip_enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', FGA_TENANT_ID)
    .in('status', openStatuses)
    .neq('campaign_id', canonicalCampaignId);
  if (inventory.error) throw new Error(`legacy_drip_inventory_unavailable:${inventory.error.message}`);
  const count = inventory.count || 0;
  if (!count || dryRun) return count;

  const { error } = await db.from('drip_enrollments').update({
    status: 'stopped',
    next_step_day: null,
    next_send_at: null,
    paused_until: null,
    stopped_reason: `legacy_campaign_retired:${drip.PLAN_KEY}`,
    stopped_by: 'drip-campaign',
    updated_at: new Date().toISOString(),
  })
    .eq('tenant_id', FGA_TENANT_ID)
    .in('status', openStatuses)
    .neq('campaign_id', canonicalCampaignId);
  if (error) throw new Error(`legacy_drip_quarantine_failed:${error.message}`);
  return count;
}

async function run(tenant, payload = {}) {
  const log = createLogger('drip-campaign', tenant.slug);
  if (tenant.id !== FGA_TENANT_ID) {
    return { success: true, skipped: 'not_fga_tenant' };
  }
  const db = getServiceClient();
  const task = payload.task || 'process_sends';
  const runClock = resolveRunClock(payload);

  if (!drip.isDripEnabled(tenant)) {
    return { success: true, skipped: 'feature_disabled' };
  }

  if (task === 'sync_replies') {
    const { syncDripReplies } = require('../../core/drip-gmail');
    const result = await syncDripReplies(db);
    if (result.skipped) {
      log.info(`Reply sync skipped: ${result.skipped}`);
    } else {
      log.info(`Reply sync: ${result.processed} new messages, ${result.matched} matched enrollments`);
    }
    return { success: true, task, ...result };
  }

  if (drip.isDripSendsPaused(tenant)) {
    return { success: true, task, skipped: 'send_kill_switch' };
  }

  // Configuration is a cohort-level prerequisite, not a per-recipient
  // delivery error. Fail once before reading or rendering due enrollments so
  // a drift between the API and worker services is visible immediately and
  // cannot create dozens of identical failures.
  const runtimeConfiguration = drip.outboundRuntimeConfiguration();
  if (!runtimeConfiguration.ready) {
    return {
      success: false,
      task,
      dry_run: !!payload.dry_run,
      error: 'drip_outbound_configuration_missing',
      runtime_configuration: runtimeConfiguration,
      outcome_contract: {
        result_state: 'failed',
        output_state: 'blocked',
        business_outcome_state: 'blocked',
        reason_code: 'outbound_configuration_missing',
        evidence: { missing: runtimeConfiguration.missing },
      },
    };
  }

  // First touches and follow-ups share one sending identity, so they must also
  // share one deliverability decision. This check happens before any campaign
  // mutation or provider call and fails closed when its evidence is unreadable.
  const capState = await computeCapState(db, tenant, runClock);
  if (!payload.dry_run) await reconcileDeliverabilityAttention(db, capState, log);
  if (capState.deliverabilityPaused) {
    return {
      success: true,
      task,
      skipped: 'deliverability_circuit_breaker',
      outcome_state: 'blocked',
      runtime_configuration: runtimeConfiguration,
      deliverability: publicDeliverabilityState(capState),
    };
  }

  const canonicalCampaign = await getCanonicalCampaign(db);
  const legacyQuarantined = await quarantineLegacyEnrollments(
    db, canonicalCampaign.id, { dryRun: !!payload.dry_run },
  );

  // ---- process_sends ------------------------------------------------------

  // 1. Auto-resume paused enrollments whose pause window has elapsed (OOO).
  const resumable = await readResumableEnrollments(db, canonicalCampaign.id, runClock);
  let resumed = 0;
  for (const r of resumable || []) {
    if (payload.dry_run) { resumed++; continue; }
    const e = await drip.resumeEnrollment(db, r.id, { by: 'scheduler' });
    if (e) resumed++;
  }

  // 2. Due sends.
  const due = await readDueEnrollments(db, canonicalCampaign.id, runClock);

  const results = { sent: 0, skipped: 0, stopped: 0, failed: 0, rescheduled: 0, details: [] };

  // Daily budget, shared across today's runs. Self-heals and stops still
  // process when the budget is gone — only actual SENDS are withheld, so a
  // backlog keeps unwedging itself while the outbound volume stays sane.
  const alreadySentToday = payload.dry_run ? 0 : await claimedToday(db, runClock);
  const effectiveDailyLimit = dailyLimitForDeliverability(capState);
  let dailyBudget = Math.max(0, effectiveDailyLimit - alreadySentToday);
  if (dailyBudget === 0) {
    log.warn(`Daily drip cap reached (${effectiveDailyLimit}); deferring remaining touches to tomorrow`);
  }
  results.daily_cap = effectiveDailyLimit;
  results.already_sent_today = alreadySentToday;
  results.deliverability = publicDeliverabilityState(capState);
  // Fail before the first follow-up if the current-customer and customer-
  // tenant exclusion boundary cannot be proven.
  const protectedOrganizations = await loadProtectedOrganizationIndex(db);

  const batch = await processDueBatch(due, {
    dryRun: !!payload.dry_run,
    dailyBudget,
    processOne: (enrollment, budget) => processEnrollmentSend(
      db, tenant, enrollment, payload, log, { dailyBudget: budget },
      protectedOrganizations,
      runClock,
    ),
    handleFailure: (enrollment, err) => deferFailedEnrollment(db, enrollment, err, log),
    recordOutcome: (enrollment, outcome) => recordDeliveryAttempt(db, enrollment, outcome, log),
    log,
  });
  Object.assign(results, batch.results);
  dailyBudget = batch.dailyBudget;

  log.info(`Drip run: ${results.sent} sent, ${results.skipped} skipped, ${results.stopped} stopped, ${results.failed} failed, ${resumed} resumed${payload.dry_run ? ' [DRY RUN]' : ''}`);
  const success = results.failed === 0;
  return {
    success,
    ...(success ? {} : { error: `${results.failed} drip enrollment(s) failed; see result.details and drip_delivery_attempts` }),
    task,
    dry_run: !!payload.dry_run,
    canonical_campaign: drip.PLAN_KEY,
    legacy_quarantined: legacyQuarantined,
    resumed,
    candidates: due.length,
    remaining_daily_budget: dailyBudget,
    simulated_as_of: payload.dry_run && payload.as_of ? runClock.toISOString() : null,
    runtime_configuration: runtimeConfiguration,
    outcome_contract: dripOutcomeContract(results, due.length),
    ...results,
  };
}

async function processDueBatch(due, {
  dryRun = false,
  dailyBudget = Infinity,
  processOne,
  handleFailure = async () => null,
  recordOutcome = async () => {},
  log = { error: () => {} },
} = {}) {
  const results = { sent: 0, skipped: 0, stopped: 0, failed: 0, rescheduled: 0, details: [] };
  let budget = dailyBudget;

  for (const enrollment of due) {
    // Failures do not consume send slots. Continue scanning until this run
    // actually sends 25 healthy touches or exhausts the bounded candidate set.
    if (!dryRun && results.sent >= MAX_SENDS_PER_RUN) break;

    let outcome;
    try {
      outcome = await processOne(enrollment, budget);
      if (outcome.bucket === 'sent' && !dryRun) budget--;
    } catch (err) {
      let failureState = null;
      if (!dryRun) {
        try {
          failureState = await handleFailure(enrollment, err);
        } catch (deferErr) {
          log.error(`Could not defer failed drip enrollment ${enrollment.id}: ${deferErr.message}`);
        }
      }
      outcome = {
        enrollment_id: enrollment.id,
        bucket: 'failed',
        day: enrollment.next_step_day,
        reason: 'delivery_error',
        error: String(err.message || err).slice(0, 500),
        ...(failureState || {}),
      };
      log.error(`Drip send failed for enrollment ${enrollment.id}: ${outcome.error}`);
    }

    results[outcome.bucket] = (results[outcome.bucket] || 0) + 1;
    results.details.push(outcome);
    if (!dryRun) {
      try {
        await recordOutcome(enrollment, outcome);
      } catch (recordErr) {
        log.error(`Could not record drip attempt ${enrollment.id}: ${recordErr.message}`);
      }
    }
  }

  return { results, dailyBudget: budget };
}

function failureMetadata(enrollment, err) {
  const metadata = { ...(enrollment.metadata || {}) };
  const sameTouch = Number(metadata.drip_failure_day) === Number(enrollment.next_step_day);
  const count = (sameTouch ? Number(metadata.drip_failure_count || 0) : 0) + 1;
  return {
    ...metadata,
    drip_failure_day: enrollment.next_step_day,
    drip_failure_count: count,
    drip_last_failure_at: new Date().toISOString(),
    drip_last_failure: String(err.message || err).slice(0, 500),
  };
}

async function deferFailedEnrollment(db, enrollment, err, log) {
  const metadata = failureMetadata(enrollment, err);
  const count = metadata.drip_failure_count;
  if (count >= MAX_FAILURES_PER_TOUCH) {
    const { error } = await db.from('drip_enrollments').update({
      status: 'review',
      next_send_at: null,
      paused_reason: 'repeated_delivery_failure',
      metadata,
      updated_at: new Date().toISOString(),
    }).eq('id', enrollment.id).eq('tenant_id', FGA_TENANT_ID).eq('status', 'active');
    if (error) throw error;
    log.warn(`Quarantined drip enrollment ${enrollment.id} after ${count} failures on day ${enrollment.next_step_day}`);
    return { quarantined: true, failure_count: count };
  }

  const retryAt = drip.computeSendAt(
    new Date().toISOString(),
    1,
    enrollment.metadata?.timezone || drip.DEFAULT_TZ,
  );
  const { error } = await db.from('drip_enrollments').update({
    next_send_at: retryAt.toISOString(),
    metadata,
    updated_at: new Date().toISOString(),
  }).eq('id', enrollment.id).eq('tenant_id', FGA_TENANT_ID).eq('status', 'active');
  if (error) throw error;
  return { quarantined: false, failure_count: count, next_send_at: retryAt.toISOString() };
}

async function recordDeliveryAttempt(db, enrollment, outcome, log) {
  const row = {
    tenant_id: FGA_TENANT_ID,
    enrollment_id: enrollment.id,
    lead_id: enrollment.lead_id,
    day_offset: outcome.day ?? enrollment.next_step_day ?? null,
    outcome: outcome.bucket,
    reason: outcome.reason || null,
    error: outcome.error || null,
    next_send_at: outcome.next_send_at || null,
    metadata: {
      quarantined: !!outcome.quarantined,
      failure_count: outcome.failure_count || 0,
      provider_id: outcome.provider_id || null,
    },
  };
  const { error } = await db.from('drip_delivery_attempts').insert(row);
  if (!error) return;

  // Deployment-safe fallback while migration 105 is being applied. This also
  // keeps the reason durable if the evidence table itself ever has an outage.
  log.warn(`drip_delivery_attempts insert failed; using activity_log fallback: ${error.message}`);
  await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'drip-campaign',
    action: 'drip_delivery_attempt',
    entity_type: 'lead',
    entity_id: enrollment.lead_id,
    level: outcome.bucket === 'failed' ? 'error' : 'info',
    metadata: {
      enrollment_id: enrollment.id,
      day_offset: row.day_offset,
      outcome: row.outcome,
      reason: row.reason,
      error: row.error,
      next_send_at: row.next_send_at,
      ...row.metadata,
    },
  }).then(() => {}, () => {});
}

async function processEnrollmentSend(
  db, tenant, enrollment, payload, log, opts = {}, protectedOrganizations = null,
  runClock = new Date(),
) {
  const stepDay = enrollment.next_step_day;

  // Full pre-send recheck (replies, status, stage, suppression, flag, dupes).
  const check = await drip.preSendCheck(db, enrollment, tenant, protectedOrganizations);
  if (!check.ok) {
    if (payload.dry_run) return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: `would_${check.action}:${check.reason}` };
    if (check.action === 'stop') {
      await drip.stopEnrollment(db, enrollment.id, { status: check.stopStatus, reason: check.reason, by: 'scheduler' });
      return { enrollment_id: enrollment.id, bucket: 'stopped', day: stepDay, reason: check.reason };
    }
    if (check.action === 'review') {
      const { error: reviewError } = await db.from('drip_enrollments').update({
        status: 'review',
        next_send_at: null,
        paused_reason: check.reason,
        updated_at: new Date().toISOString(),
      }).eq('id', enrollment.id).eq('tenant_id', FGA_TENANT_ID).eq('status', 'active');
      if (reviewError) throw reviewError;
      await db.from('attention_queue').insert({
        tenant_id: FGA_TENANT_ID,
        type: 'drip_delivery_uncertain',
        severity: 'red',
        title: 'Drip delivery needs reconciliation',
        summary: 'A follow-up may have reached the provider, but its delivery receipt was not persisted. The enrollment is paused; do not resend until reconciled.',
        entity_type: 'lead',
        entity_id: enrollment.lead_id,
        payload: { enrollment_id: enrollment.id, drip_send_id: check.priorSendId, touch_day: stepDay },
        produced_by: 'drip-campaign',
      }).then(() => {}, () => {});
      return { enrollment_id: enrollment.id, bucket: 'failed', day: stepDay, reason: check.reason };
    }

    // SELF-HEAL. `touch_already_sent` means this day's email went out but the
    // cursor never advanced (e.g. a crash between the send and advanceCursor).
    // Skipping without advancing is a permanent wedge: the enrollment stays the
    // oldest due row forever, and since the due query is
    // `order(next_send_at).limit(MAX_SENDS_PER_RUN)`, a batch of wedged rows
    // fills every slot on every run and starves every other prospect.
    //
    // That is exactly what happened: 25 enrollments wedged on 2026-06-10..16,
    // blocking 77 others for a month. The touch is already delivered, so the
    // only correct move is to advance past it.
    // Only 'sent'. `touch_already_sending` means a concurrent worker holds the
    // claim right now — advancing under it would skip a touch that is still
    // in flight. Leave that one to the next run.
    if (check.reason === 'touch_already_sent') {
      const { data: lead } = await db.from('leads').select('*')
        .eq('id', enrollment.lead_id).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
      if (lead) {
        // sentOk: true — the email really did go out, so the Day-60 and Day-180
        // stage transitions inside advanceCursor must still fire.
        await advanceCursor(db, enrollment, stepDay, lead, { sentOk: true });
        log.warn(`Self-healed enrollment ${enrollment.id}: day ${stepDay} already delivered, cursor advanced`);
        return { enrollment_id: enrollment.id, bucket: 'rescheduled', day: stepDay, reason: 'self_healed:touch_already_sent' };
      }
    }

    // skip: leave the enrollment for the next run (or it's already inert)
    return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: check.reason };
  }
  const { lead, email } = check;
  const fresh = check.enrollment;
  const timezoneEvidence = drip.resolveTimezoneForEnrollment(fresh, lead);
  const sendTimezone = timezoneEvidence.timezone;

  // A due Pacific row encountered by the 09:00 ET sweep is still BEFORE its
  // local window. It must remain due for the 12:00 ET sweep, not be pushed to
  // tomorrow. Only rows whose local window is already over are rescheduled.
  const dispatchNow = new Date(runClock);
  const windowPosition = drip.sendWindowPosition(dispatchNow, sendTimezone);
  if (windowPosition === 'before') {
    return {
      enrollment_id: enrollment.id,
      bucket: 'skipped',
      day: stepDay,
      reason: 'awaiting_local_send_window',
    };
  }
  if (windowPosition === 'after') {
    if (payload.dry_run) return { enrollment_id: enrollment.id, bucket: 'rescheduled', day: stepDay, reason: 'local_send_window_elapsed' };
    const nextAt = drip.computeSendAt(dispatchNow.toISOString(), 1, sendTimezone);
    const { error: rescheduleError } = await db.from('drip_enrollments')
      .update({
        next_send_at: nextAt.toISOString(),
        metadata: {
          ...(fresh.metadata || {}),
          timezone: sendTimezone,
          timezone_source: timezoneEvidence.source,
          ...(timezoneEvidence.state ? { timezone_state: timezoneEvidence.state } : {}),
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', fresh.id).eq('tenant_id', FGA_TENANT_ID);
    if (rescheduleError) {
      throw new Error(`local_window_reschedule_failed:${rescheduleError.message}`);
    }
    return { enrollment_id: enrollment.id, bucket: 'rescheduled', day: stepDay, next_send_at: nextAt.toISOString() };
  }

  // Daily cap: withhold the SEND, leave the enrollment due so the next run (or
  // tomorrow's) picks it up unchanged. Deliberately after the self-heal and
  // stop paths above — a capped day must still let the queue unclog.
  if (!payload.dry_run && opts.dailyBudget !== undefined && opts.dailyBudget <= 0) {
    return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: 'daily_cap_reached' };
  }

  // Approved template for this touch in the enrollment's campaign version.
  const { data: step } = await db
    .from('drip_campaign_steps')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('campaign_id', fresh.campaign_id)
    .eq('day_offset', stepDay)
    .maybeSingle();
  if (!step || step.status !== 'approved') {
    throw new Error(`step_not_approved:day_${stepDay}`);
  }

  const rendered = await drip.renderStepEmail(db, {
    step, lead, enrollment: fresh, ensureCoupon: stepDay === 30 && !payload.dry_run,
  });
  if (!rendered.ok) {
    // e.g. coupon redeemed — advance past this touch without sending
    if (payload.dry_run) return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: rendered.reason };
    await recordSkippedSend(db, fresh, stepDay, step.id, rendered.reason);
    await advanceCursor(db, fresh, stepDay, lead, { sentOk: false });
    return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: rendered.reason };
  }

  if (payload.dry_run) {
    return {
      enrollment_id: enrollment.id,
      bucket: 'sent',
      day: stepDay,
      dry_run: true,
      recipient_evidence: 'verified',
      template_rendered: true,
      timezone: sendTimezone,
    };
  }

  // IDEMPOTENT CLAIM — insert the drip_sends row first. UNIQUE(enrollment_id,
  // day_offset) means exactly one worker wins; a concurrent run errors here
  // and never double-sends.
  const claim = await claimDripSend(db, {
      tenant_id: FGA_TENANT_ID,
      enrollment_id: fresh.id,
      lead_id: lead.id,
      step_id: step.id,
      day_offset: stepDay,
      status: 'sending',
      scheduled_for: fresh.next_send_at,
      subject: rendered.subject,
      body_html: rendered.html,
      attempts: 1,
    });
  if (!claim.claimed) {
    return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: claim.reason };
  }
  const sendRow = claim.row;

  // Send-time signature refresh, same as the manual outreach path. The
  // signature is applied to the prose BODY and the shell re-wraps it, so the
  // signature renders inside the card (appending to the shelled html would
  // land it after the closing tags).
  let html = rendered.html;
  try {
    const { applyHtmlSignature } = require('../../core/email-signature');
    const { renderOutreachEmail } = require('../../core/email-shell');
    const signedBody = applyHtmlSignature(rendered.bodyHtml, tenant);
    html = renderOutreachEmail({ ...rendered.shell, bodyHtml: signedBody });
  } catch (_) { /* signature optional; the unsigned shelled html still sends */ }

  // Send the follow-up from the SAME identity as the initial outreach. Without
  // this, a prospect gets touch #1 from the dedicated outreach subdomain and
  // touch #2 from the main domain — inconsistent, breaks threading, and splits
  // the sending reputation the subdomain exists to isolate.
  // Replies still route to patrick@ so the Gmail reply-sync keeps working.
  const fromOverride = tenant?.config?.autosend_from_email || null;

  let sendResult;
  try {
    const { sendEmail } = require('../../integrations/email');
    sendResult = await sendEmail(rendered.email, rendered.subject, html, {
      tenant,
      replyTo: 'patrick@firstgenautomate.com',
      idempotencyKey: `fga-drip-${fresh.id}-${stepDay}`,
      ...(fromOverride ? { from: fromOverride } : {}),
      headers: {
        'List-Unsubscribe': `<${rendered.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (sendErr) {
    await db.from('drip_sends')
      .update({ status: 'failed', error: sendErr.message, updated_at: new Date().toISOString() })
      .eq('id', sendRow.id).eq('tenant_id', FGA_TENANT_ID);
    // a failed touch must be retryable — clear the claim
    await db.from('drip_sends').delete().eq('id', sendRow.id)
      .eq('tenant_id', FGA_TENANT_ID).eq('status', 'failed');
    throw sendErr;
  }

  if (sendResult?.status !== 'sent' || !sendResult?.id) {
    const reason = `provider_not_accepted:${sendResult?.status || 'unknown'}`;
    await db.from('drip_sends')
      .update({ status: 'failed', error: reason, updated_at: new Date().toISOString() })
      .eq('id', sendRow.id).eq('tenant_id', FGA_TENANT_ID);
    await db.from('drip_sends')
      .delete().eq('id', sendRow.id).eq('tenant_id', FGA_TENANT_ID).eq('status', 'failed');
    throw new Error(reason);
  }

  const sentAt = new Date().toISOString();
  try {
    await persistAcceptedDripReceipt(db, {
      sendRowId: sendRow.id,
      providerId: sendResult.id,
      html,
      sentAt,
    });
  } catch (receiptError) {
    const error = receiptError.message;
    log.error(`Provider accepted drip send ${sendRow.id}, but its receipt could not be persisted: ${error}`);
    // Never advance and never retry the provider call on uncertainty. The
    // retained `sending` claim becomes a review item through the existing
    // stale-claim reconciliation path.
    return {
      enrollment_id: enrollment.id,
      bucket: 'failed',
      day: stepDay,
      reason: 'provider_receipt_persist_failed',
      error: String(error).slice(0, 500),
      provider_id: sendResult.id,
    };
  }

  // Timeline + audit
  // NOTE: .then(ok, err) — NOT .catch(). A Supabase query builder is a thenable
  // with then() and no catch(); `.catch(...)` throws `TypeError: .catch is not a
  // function` at runtime. That happened here for a month: the email was already
  // sent, then this line threw, so advanceCursor() below never ran and the
  // enrollment retried the same touch forever. See test/no-builder-catch.test.js.
  await db.from('conversations').insert({
    tenant_id: FGA_TENANT_ID,
    lead_id: lead.id,
    channel: 'email',
    direction: 'outbound',
    message_subject: rendered.subject,
    message_body: rendered.bodyHtml,
    metadata: {
      source: 'drip_campaign', drip_day: stepDay, drip_send_id: sendRow.id,
      body_html: html, sent_at: sentAt, send_result: sendResult || null,
    },
  }).then(() => {}, () => {});
  await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'drip-campaign',
    action: 'drip_touch_sent',
    entity_type: 'lead',
    entity_id: lead.id,
    level: 'info',
    metadata: { day_offset: stepDay, enrollment_id: fresh.id, subject: rendered.subject, recipient: rendered.email, provider_id: sendResult?.id || null },
  }).then(() => {}, () => {});

  // The email is out the door. Advancing the cursor is the ONLY thing that must
  // still happen — bookkeeping above is best-effort and must never block it.
  await advanceCursor(db, fresh, stepDay, lead, { sentOk: true });
  try {
    const { recordGrowthEvent } = require('../../core/growth/events');
    await recordGrowthEvent(db, {
      tenantId: FGA_TENANT_ID,
      leadId: lead.id,
      eventType: 'sequence_touch_provider_accepted',
      stage: 'provider_accepted',
      sourceSystem: 'resend',
      sourceId: sendResult.id,
      actor: 'drip-campaign',
      evidence: { provider_status: sendResult.status, enrollment_id: fresh.id, touch_day: stepDay },
      messageVersion: `campaign-${fresh.campaign_id}-v${fresh.campaign_version}-day-${stepDay}`,
      correlationId: fresh.id,
    });
  } catch (eventErr) {
    log.warn(`Growth event write deferred for drip send ${sendRow.id}: ${eventErr.message}`);
  }
  log.info(`Day ${stepDay} drip provider-accepted for enrollment ${fresh.id}`);
  return {
    enrollment_id: enrollment.id,
    bucket: 'sent',
    day: stepDay,
    recipient_evidence: 'verified',
    provider_id: sendResult?.id || null,
  };
}

async function recordSkippedSend(db, enrollment, stepDay, stepId, reason) {
  await db.from('drip_sends').insert({
    tenant_id: FGA_TENANT_ID,
    enrollment_id: enrollment.id,
    lead_id: enrollment.lead_id,
    step_id: stepId,
    day_offset: stepDay,
    status: 'skipped',
    skip_reason: reason,
    scheduled_for: enrollment.next_send_at,
  }).then(() => {}, () => {});
}

/**
 * Advance the enrollment to the next touch point, and apply the bucket
 * transitions: the long-term checkpoint -> Long-Term Follow-Up; after the
 * campaign's final configured step the lead moves to No Response.
 */
async function advanceCursor(db, enrollment, completedDay, lead, { sentOk }) {
  const nextDay = await drip.nextCampaignStepDay(db, enrollment.campaign_id, completedDay);

  if (sentOk && (completedDay === 60 || completedDay === 90)) {
    await db.from('leads')
      .update({ status: 'long_term_followup' })
      .eq('id', lead.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', lead.status); // don't clobber a concurrent stage change
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: 'drip-campaign', action: 'drip_stage_long_term_followup',
      entity_type: 'lead', entity_id: lead.id, level: 'info',
        metadata: { enrollment_id: enrollment.id, after_day: completedDay },
    });
  }

  if (nextDay === null) {
    // Final configured touch done — campaign complete, lead -> No Response.
    await db.from('drip_enrollments')
      .update({
        status: 'completed', next_step_day: null, next_send_at: null,
        metadata: clearFailureMetadata(enrollment.metadata),
        updated_at: new Date().toISOString(),
      })
      .eq('id', enrollment.id).eq('tenant_id', FGA_TENANT_ID);
    if (sentOk) {
      await db.from('leads')
        .update({ status: 'no_response' })
        .eq('id', lead.id)
        .eq('tenant_id', FGA_TENANT_ID);
      await db.from('activity_log').insert({
        tenant_id: FGA_TENANT_ID, agent: 'drip-campaign', action: 'drip_completed_no_response',
        entity_type: 'lead', entity_id: lead.id, level: 'info',
        metadata: { enrollment_id: enrollment.id },
      });
    }
    return;
  }

  const timezoneEvidence = drip.resolveTimezoneForEnrollment(enrollment, lead);
  const tz = timezoneEvidence.timezone;
  let nextAt = drip.computeSendAt(enrollment.day1_at, nextDay, tz);
  // If we're sending late (catch-up), the next touch's natural date may
  // already be past — schedule it for the next business-day window instead.
  if (nextAt <= new Date()) nextAt = drip.computeSendAt(new Date().toISOString(), 1, tz);

  await db.from('drip_enrollments')
    .update({
      next_step_day: nextDay,
      next_send_at: nextAt.toISOString(),
      metadata: clearFailureMetadata({
        ...(enrollment.metadata || {}),
        timezone: tz,
        timezone_source: timezoneEvidence.source,
        ...(timezoneEvidence.state ? { timezone_state: timezoneEvidence.state } : {}),
      }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', enrollment.id).eq('tenant_id', FGA_TENANT_ID);
}

function clearFailureMetadata(value) {
  const metadata = { ...(value || {}) };
  delete metadata.drip_failure_day;
  delete metadata.drip_failure_count;
  delete metadata.drip_last_failure_at;
  delete metadata.drip_last_failure;
  return metadata;
}

module.exports = run;
module.exports._test = {
  processDueBatch,
  getCanonicalCampaign,
  quarantineLegacyEnrollments,
  failureMetadata,
  clearFailureMetadata,
  MAX_SENDS_PER_RUN,
  MAX_SENDS_PER_DAY,
  MAX_CANDIDATES_PER_RUN,
  MAX_FAILURES_PER_TOUCH,
  dailyLimitForDeliverability,
  configuredFollowupDailyCap,
  publicDeliverabilityState,
  claimedToday,
  resolveRunClock,
  readResumableEnrollments,
  readDueEnrollments,
  isUniqueClaimConflict,
  claimDripSend,
  persistAcceptedDripReceipt,
  dripOutcomeContract,
};
