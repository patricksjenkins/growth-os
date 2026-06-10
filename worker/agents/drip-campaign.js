/**
 * First Gen Automate — Drip Campaign Agent
 *
 * Owns the automated prospect drip campaign end-to-end:
 *   payload.task = 'process_sends' (default)
 *     - auto-resumes OOO-paused enrollments whose paused_until has passed
 *     - finds enrollments with next_send_at <= now and sends the due touch
 *       point (Days 7/17/30/45/60/90/120/150/180 after the approved initial
 *       outreach send), with full pre-send rechecks + idempotent claims
 *     - Day 30 mints the prospect's first-month-free Stripe promo code;
 *       Day 60 reuses it (skips gracefully if redeemed)
 *     - after a successful Day 60 send: lead -> 'long_term_followup'
 *     - after a successful Day 180 send: enrollment completed,
 *       lead -> 'no_response', all automation stops
 *   payload.task = 'sync_replies'
 *     - polls the FGA Gmail inbox, classifies inbound (deterministic-first,
 *       AI fallback) and routes: reply->stop+Replied, OOO->pause,
 *       bounce->suppress+stop, unsubscribe->suppress, ambiguous->review
 *
 * FGA-internal: this agent is a no-op for every tenant except FGA.
 * Feature flag: tenant_config 'drip_campaign_enabled' — when false the agent
 * exits without touching anything (sends pause safely, nothing is lost).
 * payload.dry_run = true renders + reports without sending or mutating.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const drip = require('../../core/drip-campaign');

const MAX_SENDS_PER_RUN = 25;

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
    .limit(MAX_SENDS_PER_RUN);

  const results = { sent: 0, skipped: 0, stopped: 0, failed: 0, rescheduled: 0, details: [] };

  for (const enrollment of due || []) {
    try {
      const outcome = await processEnrollmentSend(db, tenant, enrollment, payload, log);
      results[outcome.bucket] = (results[outcome.bucket] || 0) + 1;
      results.details.push(outcome);
    } catch (err) {
      results.failed++;
      results.details.push({ enrollment_id: enrollment.id, bucket: 'failed', error: err.message });
      log.error(`Drip send failed for enrollment ${enrollment.id}: ${err.message}`);
    }
  }

  log.info(`Drip run: ${results.sent} sent, ${results.skipped} skipped, ${results.stopped} stopped, ${results.failed} failed, ${resumed} resumed${payload.dry_run ? ' [DRY RUN]' : ''}`);
  return { success: true, task, dry_run: !!payload.dry_run, resumed, ...results };
}

async function processEnrollmentSend(db, tenant, enrollment, payload, log) {
  const stepDay = enrollment.next_step_day;

  // Full pre-send recheck (replies, status, stage, suppression, flag, dupes).
  const check = await drip.preSendCheck(db, enrollment, tenant);
  if (!check.ok) {
    if (payload.dry_run) return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: `would_${check.action}:${check.reason}` };
    if (check.action === 'stop') {
      await drip.stopEnrollment(db, enrollment.id, { status: check.stopStatus, reason: check.reason, by: 'scheduler' });
      return { enrollment_id: enrollment.id, bucket: 'stopped', day: stepDay, reason: check.reason };
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
      .eq('id', fresh.id);
    return { enrollment_id: enrollment.id, bucket: 'rescheduled', day: stepDay, next_send_at: nextAt.toISOString() };
  }

  // Approved template for this touch in the enrollment's campaign version.
  const { data: step } = await db
    .from('drip_campaign_steps')
    .select('*')
    .eq('campaign_id', fresh.campaign_id)
    .eq('day_offset', stepDay)
    .maybeSingle();
  if (!step || step.status !== 'approved') {
    return { enrollment_id: enrollment.id, bucket: 'skipped', day: stepDay, reason: 'step_not_approved' };
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

  // Send-time signature refresh, same as the manual outreach path.
  let html = rendered.html;
  try {
    const { applyHtmlSignature } = require('../../core/email-signature');
    html = applyHtmlSignature(html, tenant);
  } catch (_) { /* signature optional */ }

  let sendResult;
  try {
    const { sendEmail } = require('../../integrations/email');
    sendResult = await sendEmail(rendered.email, rendered.subject, html, {
      replyTo: 'patrick@firstgenautomate.com',
      headers: {
        'List-Unsubscribe': `<${rendered.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (sendErr) {
    await db.from('drip_sends')
      .update({ status: 'failed', error: sendErr.message, updated_at: new Date().toISOString() })
      .eq('id', sendRow.id);
    // push the retry into the next run window (next business day)
    const retryAt = drip.computeSendAt(new Date().toISOString(), 1, fresh.metadata?.timezone || drip.DEFAULT_TZ);
    await db.from('drip_enrollments')
      .update({ next_send_at: retryAt.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', fresh.id);
    // a failed touch must be retryable — clear the claim
    await db.from('drip_sends').delete().eq('id', sendRow.id).eq('status', 'failed');
    throw sendErr;
  }

  const sentAt = new Date().toISOString();
  await db.from('drip_sends')
    .update({ status: 'sent', sent_at: sentAt, resend_id: sendResult?.id || null, body_html: html, updated_at: sentAt })
    .eq('id', sendRow.id);

  // Timeline + audit
  await db.from('conversations').insert({
    tenant_id: FGA_TENANT_ID,
    lead_id: lead.id,
    channel: 'email',
    direction: 'outbound',
    message_subject: rendered.subject,
    message_body: rendered.subject,
    metadata: {
      source: 'drip_campaign', drip_day: stepDay, drip_send_id: sendRow.id,
      body_html: html, sent_at: sentAt, send_result: sendResult || null,
    },
  }).catch(() => {});
  await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'drip-campaign',
    action: 'drip_touch_sent',
    entity_type: 'lead',
    entity_id: lead.id,
    level: 'info',
    metadata: { day_offset: stepDay, enrollment_id: fresh.id, subject: rendered.subject, recipient: rendered.email, provider_id: sendResult?.id || null },
  });

  await advanceCursor(db, fresh, stepDay, lead, { sentOk: true });
  log.info(`Day ${stepDay} drip sent to ${rendered.email} (lead ${lead.id})`);
  return { enrollment_id: enrollment.id, bucket: 'sent', day: stepDay, to: rendered.email };
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
 * transitions: successful Day 60 -> Long-Term Follow-Up; after Day 180 the
 * enrollment completes and the lead moves to No Response.
 */
async function advanceCursor(db, enrollment, completedDay, lead, { sentOk }) {
  const idx = drip.TOUCH_DAYS.indexOf(completedDay);
  const nextDay = idx >= 0 && idx < drip.TOUCH_DAYS.length - 1 ? drip.TOUCH_DAYS[idx + 1] : null;

  if (sentOk && completedDay === 60) {
    await db.from('leads')
      .update({ status: 'long_term_followup' })
      .eq('id', lead.id)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', lead.status); // don't clobber a concurrent stage change
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, agent: 'drip-campaign', action: 'drip_stage_long_term_followup',
      entity_type: 'lead', entity_id: lead.id, level: 'info',
      metadata: { enrollment_id: enrollment.id, after_day: 60 },
    });
  }

  if (nextDay === null) {
    // Day 180 done — campaign complete, lead -> No Response.
    await db.from('drip_enrollments')
      .update({ status: 'completed', next_step_day: null, next_send_at: null, updated_at: new Date().toISOString() })
      .eq('id', enrollment.id);
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
    .update({ next_step_day: nextDay, next_send_at: nextAt.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', enrollment.id);
}

module.exports = run;
