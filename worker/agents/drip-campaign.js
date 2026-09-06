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

const MAX_SENDS_PER_RUN = 25;
// Scan beyond the send allowance so a poisoned head-of-queue cohort cannot
// occupy every slot forever. Failed rows are deferred/quarantined below; the
// same run can continue to healthy enrollments without exceeding send caps.
const MAX_CANDIDATES_PER_RUN = MAX_SENDS_PER_RUN * 4;
const MAX_FAILURES_PER_TOUCH = 3;

// Per-DAY cap. The cron fires 6x on weekday mornings, so MAX_SENDS_PER_RUN
// alone permits 150 cold follow-ups/day — a volume nobody chose. It only never
// materialized because a backlog could not build up... until one did: a wedged
// batch starved the queue for a month, leaving 100+ overdue touches that would
// otherwise all fire the morning the wedge cleared. Draining a backlog slowly
// is the difference between a resumed campaign and a spam complaint.
const MAX_SENDS_PER_DAY = Number(process.env.DRIP_MAX_SENDS_PER_DAY || 30);

/** Drip touches already delivered today (UTC day, matching sent_at storage). */
async function sentToday(db) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count } = await db
    .from('drip_sends')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'sent')
    .gte('sent_at', startOfDay.toISOString());
  return count || 0;
}

async function run(tenant, payload = {}) {
  const log = createLogger('drip-campaign', tenant.slug);
  if (tenant.id !== FGA_TENANT_ID) {
    return { success: true, skipped: 'not_fga_tenant' };
  }
  const db = getServiceClient();
  const task = payload.task || 'process_sends';

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

  // ---- process_sends ------------------------------------------------------

  // 1. Auto-resume paused enrollments whose pause window has elapsed (OOO).
  const { data: resumable } = await db
    .from('drip_enrollments')
    .select('id')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'paused')
    .not('paused_until', 'is', null)
    .lte('paused_until', new Date().toISOString());
  let resumed = 0;
  for (const r of resumable || []) {
    if (payload.dry_run) { resumed++; continue; }
    const e = await drip.resumeEnrollment(db, r.id, { by: 'scheduler' });
    if (e) resumed++;
  }

  // 2. Due sends.
  const { data: due } = await db
    .from('drip_enrollments')
    .select('*')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('status', 'active')
    .not('next_send_at', 'is', null)
    .lte('next_send_at', new Date().toISOString())
    .order('next_send_at', { ascending: true })
    .limit(MAX_CANDIDATES_PER_RUN);

  const results = { sent: 0, skipped: 0, stopped: 0, failed: 0, rescheduled: 0, details: [] };

  // Daily budget, shared across today's runs. Self-heals and stops still
  // process when the budget is gone — only actual SENDS are withheld, so a
  // backlog keeps unwedging itself while the outbound volume stays sane.
  const alreadySentToday = payload.dry_run ? 0 : await sentToday(db);
  let dailyBudget = Math.max(0, MAX_SENDS_PER_DAY - alreadySentToday);
  if (dailyBudget === 0) {
    log.warn(`Daily drip cap reached (${MAX_SENDS_PER_DAY}); deferring remaining touches to tomorrow`);
  }
  results.daily_cap = MAX_SENDS_PER_DAY;
  results.already_sent_today = alreadySentToday;

  const batch = await processDueBatch(due || [], {
    dryRun: !!payload.dry_run,
    dailyBudget,
    processOne: (enrollment, budget) => processEnrollmentSend(
      db, tenant, enrollment, payload, log, { dailyBudget: budget },
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
    resumed,
    candidates: (due || []).length,
    remaining_daily_budget: dailyBudget,
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

async function processEnrollmentSend(db, tenant, enrollment, payload, log, opts = {}) {
  const stepDay = enrollment.next_step_day;

  // Full pre-send recheck (replies, status, stage, suppression, flag, dupes).
  const check = await drip.preSendCheck(db, enrollment, tenant);
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

  // Outside the send window (e.g. catch-up after downtime landing at night /
  // weekend / holiday)? Reschedule into the next valid window — the touch
  // keeps its day_offset identity.
  if (!drip.isWithinSendWindow(new Date(), fresh.metadata?.timezone || drip.DEFAULT_TZ)) {
    if (payload.dry_run) return { enrollment_id: enrollment.id, bucket: 'rescheduled', day: stepDay, reason: 'outside_send_window' };
    const nextAt = drip.computeSendAt(new Date().toISOString(), 1, fresh.metadata?.timezone || drip.DEFAULT_TZ);
    await db.from('drip_enrollments')
      .update({ next_send_at: nextAt.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', fresh.id).eq('tenant_id', FGA_TENANT_ID);
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
    return { enrollment_id: enrollment.id, bucket: 'sent', day: stepDay, dry_run: true, to: rendered.email, subject: rendered.subject };
  }

  // IDEMPOTENT CLAIM — insert the drip_sends row first. UNIQUE(enrollment_id,
  // day_offset) means exactly one worker wins; a concurrent run errors here
  // and never double-sends.
  const { data: sendRow, error: claimErr } = await db
    .from('drip_sends')
    .insert({
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
    })
    .select()
    .single();
  if (claimErr) {
    return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: `claim_failed:${claimErr.message}` };
  }

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
  await db.from('drip_sends')
    .update({ status: 'sent', sent_at: sentAt, resend_id: sendResult?.id || null, body_html: html, updated_at: sentAt })
    .eq('id', sendRow.id).eq('tenant_id', FGA_TENANT_ID);

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
  log.info(`Day ${stepDay} drip sent to ${rendered.email} (lead ${lead.id})`);
  return {
    enrollment_id: enrollment.id,
    bucket: 'sent',
    day: stepDay,
    to: rendered.email,
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

  const tz = enrollment.metadata?.timezone || drip.DEFAULT_TZ;
  let nextAt = drip.computeSendAt(enrollment.day1_at, nextDay, tz);
  // If we're sending late (catch-up), the next touch's natural date may
  // already be past — schedule it for the next business-day window instead.
  if (nextAt <= new Date()) nextAt = drip.computeSendAt(new Date().toISOString(), 1, tz);

  await db.from('drip_enrollments')
    .update({
      next_step_day: nextDay,
      next_send_at: nextAt.toISOString(),
      metadata: clearFailureMetadata(enrollment.metadata),
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
  failureMetadata,
  clearFailureMetadata,
  MAX_SENDS_PER_RUN,
  MAX_CANDIDATES_PER_RUN,
  MAX_FAILURES_PER_TOUCH,
};
