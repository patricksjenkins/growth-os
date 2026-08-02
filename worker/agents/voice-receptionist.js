/**
 * Growth OS — Voice Receptionist Agent (Module 9)
 *
 * Processes the Vapi end-of-call payload that arrives via the
 * /webhooks/voice-receptionist/complete endpoint. The webhook enqueues
 * this agent fast (so Vapi doesn't retry); this agent does the actual
 * work:
 *
 *  1. Persist the call to voice_calls (transcript only — never audio).
 *  2. If the AI captured lead structure, insert a lead with
 *     lead_source='voice_receptionist' and enqueue the downstream
 *     pipeline (speed-to-lead + enrichment + scoring + follow-up).
 *  3. Increment tenant_usage.voice_minutes_used by the call duration.
 *  4. Text the owner the transcript summary; bump priority + URGENT
 *     prefix when emergency_detected is true.
 *
 * Idempotent on call_sid — Vapi's webhook is at-least-once.
 *
 * @param {Object} tenant
 * @param {Object} payload — {
 *    call_sid, vapi_call_id, caller_phone,
 *    duration_seconds, transcript, extracted
 * }
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, A2PUnregisteredError } = require('../../integrations/telnyx');
const { sendEmail } = require('../../integrations/email');
const { sendPushToTenant } = require('../../integrations/push');

const EMERGENCY_CLASSIFICATIONS = new Set(['emergency']);
const LEAD_CLASSIFICATIONS = new Set(['new_lead', 'existing_customer', 'emergency']);

async function run(tenant, payload = {}) {
  const log = createLogger('voice-receptionist', tenant.slug);

  const {
    call_sid: callSid,
    vapi_call_id: vapiId,
    caller_phone: callerPhone,
    duration_seconds: duration = 0,
    transcript = '',
    extracted = {},
  } = payload;

  if (!callSid) {
    log.warn('voice-receptionist agent called without call_sid');
    return { success: true, skipped: true, reason: 'no_call_sid' };
  }

  // Idempotency — call_sid is UNIQUE on voice_calls.
  const { data: existing } = await db
    .from('voice_calls')
    .select('id, captured_lead_id')
    .eq('call_sid', callSid)
    .maybeSingle();
  if (existing) {
    log.info(`Already processed call ${callSid}; skipping`);
    return { success: true, skipped: true, reason: 'duplicate' };
  }

  const classification = String(extracted.classification || 'other');
  const emergency = !!extracted.emergency_detected
    || EMERGENCY_CLASSIFICATIONS.has(classification);

  // Insert the lead first (if applicable) so we can back-reference it
  // from the voice_calls row.
  let capturedLeadId = null;
  if (LEAD_CLASSIFICATIONS.has(classification) && extracted.callback_phone) {
    const leadInsert = {
      tenant_id: tenant.id,
      name: extracted.caller_name || 'Voice caller',
      phone: extracted.callback_phone || callerPhone,
      status: 'new_lead',
      lifecycle_stage: emergency ? 'engaged' : 'new',
      lead_source: 'voice_receptionist',
      service_type: extracted.service_type || null,
      address: extracted.address || null,
      notes: extracted.notes || (transcript ? `Voice receptionist transcript:\n\n${transcript.slice(0, 1500)}` : null),
      metadata: {
        call_sid: callSid,
        vapi_call_id: vapiId,
        urgency: extracted.urgency || null,
        emergency_detected: emergency,
      },
    };
    const { data: lead, error: leadErr } = await db
      .from('leads')
      .insert(leadInsert)
      .select('id')
      .single();
    if (leadErr) {
      log.error(`Lead insert failed for call ${callSid}: ${leadErr.message}`);
    } else {
      capturedLeadId = lead.id;
      // Fire the full downstream pipeline — same chain as the website
      // lead capture path.
      try {
        await db.from('agent_jobs').insert([
          { tenant_id: tenant.id, agent_name: 'speed-to-lead', payload: { lead_id: capturedLeadId }, status: 'pending', priority: 10 },
          { tenant_id: tenant.id, agent_name: 'enrichment',    payload: { lead_id: capturedLeadId }, status: 'pending', priority: 7 },
          { tenant_id: tenant.id, agent_name: 'scoring',       payload: { lead_id: capturedLeadId }, status: 'pending', priority: 5 },
          { tenant_id: tenant.id, agent_name: 'follow-up',     payload: { lead_id: capturedLeadId }, status: 'pending', priority: 5 },
        ]);
      } catch (queueErr) {
        log.warn(`Downstream pipeline enqueue failed for lead ${capturedLeadId}: ${queueErr.message}`);
      }
    }
  }

  // Persist the call record (transcript-only — no audio fields).
  const { error: callErr } = await db.from('voice_calls').insert({
    tenant_id: tenant.id,
    call_sid: callSid,
    vapi_call_id: vapiId || null,
    caller_phone: callerPhone || extracted.callback_phone || 'unknown',
    duration_seconds: Math.round(Number(duration) || 0),
    transcript: transcript || null,
    classification,
    captured_lead_id: capturedLeadId,
    emergency_flagged: emergency,
    owner_notified: false,
  });
  if (callErr) {
    log.error(`voice_calls insert failed for ${callSid}: ${callErr.message}`);
    // Still try to text the owner — losing the log row is recoverable.
  }

  // Bump per-tenant usage:
  //   voice_minutes_used         — AI-answered minutes only (Vapi)
  //   voice_minutes_total — counts toward the broader carrier
  //                                voice cap (AI + dial leg combined)
  try {
    const minutes = Math.ceil((Number(duration) || 0) / 60);
    if (minutes > 0) {
      const { incrementUsage } = require('../../core/usage-caps');
      await Promise.allSettled([
        incrementUsage(tenant.id, 'voice_minutes_used', minutes),
        incrementUsage(tenant.id, 'voice_minutes_total', minutes),
      ]);
    }
  } catch (usageErr) {
    log.warn(`Voice usage increment failed: ${usageErr.message}`);
  }

  // Text the owner the transcript summary.
  const ownerNotified = await notifyOwner(tenant, {
    classification,
    emergency,
    extracted,
    transcript,
    capturedLeadId,
    callSid,
  }, log);

  if (ownerNotified) {
    await db.from('voice_calls')
      .update({ owner_notified: true })
      .eq('call_sid', callSid)
      .eq('tenant_id', tenant.id);
  }

  log.success(`Processed voice call ${callSid} — classification=${classification}, lead=${capturedLeadId || 'none'}, emergency=${emergency}`);
  return {
    success: true,
    voice_call_sid: callSid,
    captured_lead_id: capturedLeadId,
    classification,
    emergency,
  };
}

async function notifyOwner(tenant, ctx, log) {
  // Try BOTH channels independently — owner gets a notification as long
  // as one path succeeds. Email is the more reliable backbone (Resend
  // doesn't have A2P 10DLC compliance issues); SMS is the instant
  // alert when carriers cooperate. Historically this was SMS-only,
  // which silently failed when the tenant's number wasn't
  // A2P-registered (fixed 2026-05-21).
  const ownerPhone = getConfig(tenant, 'owner_phone', null)
    || getConfig(tenant, 'voice_receptionist_forward_to', null);
  const ownerEmail = getConfig(tenant, 'owner_email', null)
    || tenant.owner_email
    || null;

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Your business');
  const callerName = ctx.extracted?.caller_name || 'a caller';
  const callerPhone = ctx.extracted?.callback_phone || null;
  const service = ctx.extracted?.service_type ? ` about ${ctx.extracted.service_type}` : '';
  const callbackBlurb = callerPhone ? ` Callback: ${callerPhone}.` : '';
  const prefix = ctx.emergency ? '🚨 URGENT — ' : '';
  const leadBlurb = ctx.capturedLeadId ? ' Lead is in your CRM.' : '';

  const summary = ctx.extracted?.notes
    ? ctx.extracted.notes.slice(0, 200)
    : (ctx.transcript || '').slice(0, 200);

  // ── SMS branch ───────────────────────────────────────────────
  let smsOk = false;
  if (ownerPhone) {
    const smsBody = `${prefix}${businessName}: ${callerName} called${service}.${callbackBlurb}${leadBlurb}\n\n${summary}${summary.length >= 200 ? '…' : ''}`;
    try {
      await sendSms(tenant.integrations, ownerPhone, smsBody, {
        tenantSlug: tenant.slug,
        tenant,
      });
      smsOk = true;
    } catch (err) {
      if (err instanceof A2PUnregisteredError) {
        log.warn(`Owner SMS skipped — A2P 10DLC unregistered for ${err.from}. Email will still go out.`);
      } else {
        log.warn(`Owner transcript SMS failed: ${err.message}`);
      }
    }
  } else {
    log.info('No owner_phone configured — skipping SMS branch');
  }

  // ── Email branch (always tried, regardless of SMS outcome) ───
  let emailOk = false;
  if (ownerEmail) {
    const subject = ctx.emergency
      ? `🚨 URGENT call from ${callerName}${service.replace(' about ', ' — ')}`
      : `${callerName} called${service.replace(' about ', ' — ')}`;
    const fullTranscript = (ctx.transcript || '').trim();
    const summaryLine = ctx.extracted?.notes || (fullTranscript.length > 240 ? fullTranscript.slice(0, 240) + '…' : fullTranscript);

    // Plain-text-with-newlines email body. Keeps it scannable on mobile
    // (the owner is opening this on a phone between jobs).
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111">
        <h1 style="font-size:18px;margin:0 0 4px;color:${ctx.emergency ? '#b91c1c' : '#0f172a'}">${ctx.emergency ? '🚨 URGENT — ' : ''}${escapeHtml(businessName)}</h1>
        <p style="margin:0 0 16px;color:#64748b;font-size:13px">AI Voice Receptionist call summary</p>

        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <tr><td style="padding:6px 0;color:#64748b;font-size:13px;width:120px">Caller</td><td style="padding:6px 0;font-weight:600">${escapeHtml(callerName)}</td></tr>
          ${callerPhone ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px">Callback</td><td style="padding:6px 0;font-weight:600"><a href="tel:${escapeAttr(callerPhone)}" style="color:#0ea5e9">${escapeHtml(callerPhone)}</a></td></tr>` : ''}
          ${ctx.extracted?.service_type ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px">About</td><td style="padding:6px 0;font-weight:600">${escapeHtml(ctx.extracted.service_type)}</td></tr>` : ''}
          ${ctx.extracted?.address ? `<tr><td style="padding:6px 0;color:#64748b;font-size:13px">Address</td><td style="padding:6px 0">${escapeHtml(ctx.extracted.address)}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#64748b;font-size:13px">Classification</td><td style="padding:6px 0">${escapeHtml(ctx.classification || 'inquiry')}${ctx.capturedLeadId ? ' · <span style="color:#16a34a">lead captured</span>' : ''}</td></tr>
        </table>

        ${summaryLine ? `<div style="background:#f8fafc;border-left:3px solid ${ctx.emergency ? '#dc2626' : '#0ea5e9'};padding:12px 14px;border-radius:4px;margin-bottom:16px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:6px">Summary</div><div style="font-size:14px;line-height:1.5">${escapeHtml(summaryLine).replace(/\n/g, '<br>')}</div></div>` : ''}

        ${fullTranscript ? `<details style="margin-bottom:16px"><summary style="cursor:pointer;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Full transcript</summary><pre style="font-family:-apple-system,sans-serif;font-size:13px;line-height:1.55;background:#f8fafc;padding:12px;border-radius:4px;white-space:pre-wrap;margin-top:8px">${escapeHtml(fullTranscript)}</pre></details>` : ''}

        <p style="font-size:12px;color:#94a3b8;margin:24px 0 0">No audio is ever recorded — transcript only.</p>
      </div>`;
    try {
      await sendEmail(ownerEmail, subject, html, {
        tenant,
        replyTo: callerPhone ? undefined : (getConfig(tenant, 'support_email', null) || undefined),
      });
      emailOk = true;
    } catch (err) {
      log.warn(`Owner transcript email failed: ${err.message}`);
    }
  } else {
    log.info('No owner_email configured — skipping email branch');
  }

  // ── Push branch (always tried — adds a third independent channel) ──
  // SMS and email are great when carriers + inbox cooperate, but the
  // push lands on the lock screen instantly even if the phone is on
  // silent. Best channel for "I just got a call and didn't know."
  let pushOk = false;
  try {
    const title = ctx.emergency
      ? `🚨 Urgent call — ${callerName}`
      : `📞 ${callerName} called`;
    const body = (() => {
      const parts = [];
      if (service.trim()) parts.push(service.replace(/^ about /, ''));
      if (callerPhone) parts.push(`Callback: ${callerPhone}`);
      if (summary) parts.push(summary.length > 100 ? summary.slice(0, 100) + '…' : summary);
      return parts.join(' · ').slice(0, 200);
    })();
    const result = await sendPushToTenant(tenant.id, {
      title,
      body,
      data: {
        route: '/voice',
        type: 'call_completed',
        call_sid: ctx.callSid,
        captured_lead_id: ctx.capturedLeadId || null,
        emergency: ctx.emergency || false,
      },
    });
    pushOk = result.sent > 0;
  } catch (err) {
    log.warn(`Owner push notification failed: ${err.message}`);
  }

  if (!ownerPhone && !ownerEmail && !pushOk) {
    log.warn('No owner_phone OR owner_email configured AND push failed — owner will not be notified of this call');
  }

  return smsOk || emailOk || pushOk;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return String(s || '').replace(/[^0-9+\-() ]/g, '');
}

module.exports = run;
