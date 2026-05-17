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
 * Idempotent on twilio_call_sid — Vapi's webhook is at-least-once.
 *
 * @param {Object} tenant
 * @param {Object} payload — {
 *    twilio_call_sid, vapi_call_id, caller_phone,
 *    duration_seconds, transcript, extracted
 * }
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms } = require('../../integrations/twilio');

const EMERGENCY_CLASSIFICATIONS = new Set(['emergency']);
const LEAD_CLASSIFICATIONS = new Set(['new_lead', 'existing_customer', 'emergency']);

async function run(tenant, payload = {}) {
  const log = createLogger('voice-receptionist', tenant.slug);

  const {
    twilio_call_sid: callSid,
    vapi_call_id: vapiId,
    caller_phone: callerPhone,
    duration_seconds: duration = 0,
    transcript = '',
    extracted = {},
  } = payload;

  if (!callSid) {
    log.warn('voice-receptionist agent called without twilio_call_sid');
    return { success: true, skipped: true, reason: 'no_call_sid' };
  }

  // Idempotency — twilio_call_sid is UNIQUE on voice_calls.
  const { data: existing } = await db
    .from('voice_calls')
    .select('id, captured_lead_id')
    .eq('twilio_call_sid', callSid)
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
        twilio_call_sid: callSid,
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
    twilio_call_sid: callSid,
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

  // Bump tenant_usage.voice_minutes_used. Use SQL increment to avoid
  // a read-then-write race.
  try {
    const minutes = Math.ceil((Number(duration) || 0) / 60);
    if (minutes > 0) {
      await db.rpc('increment_voice_minutes', {
        p_tenant_id: tenant.id,
        p_minutes: minutes,
      }).catch(async () => {
        // RPC may not exist yet on staging — fall back to read-then-write.
        const { data: u } = await db
          .from('tenant_usage')
          .select('voice_minutes_used')
          .eq('tenant_id', tenant.id)
          .maybeSingle();
        const next = Number(u?.voice_minutes_used || 0) + minutes;
        await db.from('tenant_usage')
          .upsert({ tenant_id: tenant.id, voice_minutes_used: next }, { onConflict: 'tenant_id' });
      });
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
      .eq('twilio_call_sid', callSid)
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
  const ownerPhone = getConfig(tenant, 'owner_phone', null)
    || getConfig(tenant, 'voice_receptionist_forward_to', null);
  if (!ownerPhone) {
    log.warn('No owner_phone configured — skipping transcript SMS');
    return false;
  }

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Your business');
  const callerName = ctx.extracted?.caller_name || 'a caller';
  const service = ctx.extracted?.service_type ? ` about ${ctx.extracted.service_type}` : '';
  const callback = ctx.extracted?.callback_phone ? ` Callback: ${ctx.extracted.callback_phone}.` : '';
  const prefix = ctx.emergency ? '🚨 URGENT — ' : '';
  const lead = ctx.capturedLeadId ? ' Lead is in your CRM.' : '';

  // Keep the SMS tight — owner can open the full transcript in the app.
  const summary = ctx.extracted?.notes
    ? ctx.extracted.notes.slice(0, 200)
    : (ctx.transcript || '').slice(0, 200);

  const body = `${prefix}${businessName}: ${callerName} called${service}.${callback}${lead}\n\n${summary}${summary.length >= 200 ? '…' : ''}`;

  try {
    await sendSms(tenant.integrations, ownerPhone, body, {
      tenantSlug: tenant.slug,
      tenant,
    });
    return true;
  } catch (err) {
    log.warn(`Owner transcript SMS failed: ${err.message}`);
    return false;
  }
}

module.exports = run;
