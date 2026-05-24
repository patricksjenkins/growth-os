/**
 * Growth OS — Twilio Webhook Handler
 * Handles inbound SMS and missed calls
 */

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../core/logger');
const { resolveTwilioTenant, verifyTwilioSignature } = require('../middleware/webhookVerify');
const { isModuleEnabled } = require('../../core/modules');
const { enqueueJob } = require('../../db/queries/jobs');
const { db } = require('../../db/client');

// Twilio sends form-encoded data
router.use(express.urlencoded({ extended: false }));

/**
 * Inbound SMS webhook
 * POST /webhooks/twilio/sms
 */
router.post('/sms', resolveTwilioTenant, verifyTwilioSignature, async (req, res) => {
  const log = createLogger('twilio-sms', req.tenant?.slug);

  try {
    const { From: from, Body: body, MessageSid: sid } = req.body;

    log.info(`Inbound SMS from ${from}: "${body.slice(0, 50)}..."`);

    // V1 hardening (2026-05-24): idempotency. Twilio retries 11 times
    // over 24h on any non-2xx response. Without this guard a single
    // inbound SMS would re-fire the push, double-insert messages +
    // conversations, and double-enqueue speed-to-lead /
    // inbound-sms-responder / conversation-responder jobs.
    //
    // The messages table has a unique(tenant_id, external_id) check we
    // exploit: try the insert first; if it conflicts, the duplicate
    // SMS path is short-circuited. Done before any other side effect
    // (push, conversation insert, job enqueue) so retries are a no-op.
    if (sid) {
      const { error: dupErr } = await db.from('messages').insert({
        tenant_id: req.tenantId,
        channel: 'sms',
        direction: 'inbound',
        body,
        external_id: sid,
        sent_at: new Date().toISOString(),
      });
      if (dupErr && /duplicate key|unique/i.test(dupErr.message || '')) {
        log.info(`Duplicate inbound SMS sid=${sid} — Twilio retry ignored`);
        res.type('text/xml');
        return res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      }
      // If it failed for some OTHER reason, fall through to the legacy
      // path so we don't lose the message; that path will try a second
      // insert which will likely also fail but the rest of the work
      // (push, conversation, job enqueue) still happens.
    }

    // Resolve the sender to a contact / lead so the reply can be classified.
    // Prefer contact match (most outreach targets have a contact row); fall
    // back to lead.phone for B2C leads that only created a lead row.
    let contactId = null;
    let leadId = null;

    const { data: contact } = await db
      .from('contacts')
      .select('id, lead_id')
      .eq('tenant_id', req.tenantId)
      .eq('phone', from)
      .maybeSingle();

    if (contact) {
      contactId = contact.id;
      leadId = contact.lead_id;
    } else {
      const { data: lead } = await db
        .from('leads')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('phone', from)
        .maybeSingle();
      if (lead) leadId = lead.id;
    }

    // The messages row was already inserted above (idempotency guard).
    // If we have a contact_id resolved later, patch it onto the row.
    if (sid && contactId) {
      try {
        await db.from('messages')
          .update({ contact_id: contactId })
          .eq('tenant_id', req.tenantId)
          .eq('external_id', sid);
      } catch (_) { /* best-effort — message exists either way */ }
    }

    // Push notification to the tenant owner the instant an SMS lands.
    // Fire-and-forget — doesn't block the TwiML response. Bypasses
    // carrier filtering (push goes through APNs, not 10DLC). Critical
    // for the "I didn't see the text" failure mode.
    try {
      const { sendPushToTenant } = require('../../integrations/push');
      const digits = String(from || '').replace(/\D/g, '');
      const pretty = digits.length === 11 && digits.startsWith('1')
        ? `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
        : digits.length === 10
          ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
          : from;
      const senderLabel = leadId ? `Lead from ${pretty}` : contactId ? `Contact from ${pretty}` : `New text from ${pretty}`;
      sendPushToTenant(req.tenantId, {
        title: `💬 ${senderLabel}`,
        body: (body || '').slice(0, 140),
        data: {
          route: '/voice',  // Voice Calls + Messages live in the same screen group in the mobile app
          type: 'inbound_sms',
          from,
          message_sid: sid,
          lead_id: leadId,
          contact_id: contactId,
        },
      }).catch(() => { /* best-effort */ });
    } catch { /* never block TwiML on push errors */ }

    // Also write to `conversations` when we have a lead/contact match,
    // so the reply-classification agent (which reads from conversations)
    // can pick it up. Without this mirror, inbound SMS replies never get
    // classified.
    if (leadId || contactId) {
      await db.from('conversations').insert({
        tenant_id: req.tenantId,
        lead_id: leadId,
        contact_id: contactId,
        channel: 'sms',
        direction: 'inbound',
        message_body: body,
        metadata: { twilio_sid: sid, from }
      });
    } else {
      log.info(`Inbound SMS from unknown sender ${from} — logged to messages only`);
    }

    // Check if this is a reply to an outreach campaign — enqueue classification
    if (isModuleEnabled(req.tenant, 'outreach_drip')) {
      await enqueueJob(req.tenantId, 'reply-classification', {
        from,
        body,
        channel: 'sms',
        message_sid: sid,
        lead_id: leadId,
        contact_id: contactId
      });
    }

    // Multi-turn lead conversation (Module 2 / 3): if the inbound came
    // from a known lead and either speed-to-lead OR missed-call is
    // enabled, queue the conversation-responder so the AI keeps the
    // back-and-forth going. The agent itself enforces all guardrails
    // (status, opt-out, turn cap, SMS cap) so blanket enqueue is safe.
    if (leadId
      && (isModuleEnabled(req.tenant, 'speed_to_lead') || isModuleEnabled(req.tenant, 'missed_call'))) {
      await enqueueJob(req.tenantId, 'conversation-responder', {
        from,
        inbound_body: body,
        message_sid: sid,
        lead_id: leadId,
        contact_id: contactId
      }, { priority: 9 });
    }

    // Unknown sender (no lead/contact match) → enqueue the AI inbound-sms-responder
    // which uses Claude + the FGA knowledge base to generate a real
    // contextual reply (not just a static acknowledgement). The agent
    // runs asynchronously so we still return TwiML immediately; the
    // SMS reply goes out via Twilio's send API a few seconds later.
    if (!leadId && !contactId) {
      await enqueueJob(req.tenantId, 'inbound-sms-responder', {
        from,
        inbound_body: body,
        message_sid: sid,
      }, { priority: 9 });
      log.info(`Enqueued AI inbound-sms-responder for unknown sender ${from}`);
    }

    // Return empty TwiML — the AI agent sends its own outbound SMS
    // via the Twilio REST API, so we don't need an inline <Message>.
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  } catch (err) {
    log.error('Inbound SMS processing failed', err);
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

/**
 * Missed call webhook
 * POST /webhooks/twilio/voice
 */
router.post('/voice', resolveTwilioTenant, verifyTwilioSignature, async (req, res) => {
  const log = createLogger('twilio-voice', req.tenant?.slug);

  try {
    const { From: from, CallStatus: status, CallSid: sid } = req.body;

    log.info(`Inbound call from ${from} — status: ${status}`);

    // Fire incoming-call push notification immediately. Tenants without
    // voice_receptionist module land here on every inbound call; this
    // mirrors the same push the voice-receptionist webhook fires. Even
    // if the owner has their phone on silent, the push wakes the lock
    // screen. Fire-and-forget — doesn't block the TwiML response.
    if (req.tenant?.id && from) {
      try {
        const { sendPushToTenant } = require('../../integrations/push');
        const digits = String(from).replace(/\D/g, '');
        const pretty = digits.length === 11 && digits.startsWith('1')
          ? `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
          : digits.length === 10
            ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
            : from;
        sendPushToTenant(req.tenant.id, {
          title: status === 'no-answer' || status === 'busy' || status === 'failed' ? '📵 Missed call' : '📞 Incoming call',
          body: `From ${pretty}${status === 'no-answer' ? ' — went to voicemail.' : status === 'busy' ? ' — line was busy.' : ''}`,
          data: { route: '/voice', type: status === 'no-answer' || status === 'busy' || status === 'failed' ? 'missed_call' : 'incoming_call', caller_phone: from, twilio_call_sid: sid },
        }).catch(() => { /* best-effort */ });
      } catch { /* never block TwiML on push errors */ }
    }

    // For missed/no-answer calls, enqueue the missed-call agent
    if (['no-answer', 'busy', 'failed'].includes(status) && isModuleEnabled(req.tenant, 'missed_call')) {
      await enqueueJob(req.tenantId, 'missed-call', {
        from,
        call_status: status,
        call_sid: sid
      }, { priority: 10 });

      log.info('Missed call agent enqueued');
    }

    // Respond with voicemail TwiML
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thank you for calling. We'll get back to you as soon as possible.</Say>
</Response>`);
  } catch (err) {
    log.error('Voice webhook failed', err);
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
});

/**
 * SMS status callback
 * POST /webhooks/twilio/status
 *
 * Twilio POSTs this every time a message moves through the delivery
 * lifecycle: queued → sent → delivered (or undelivered / failed).
 * Captures both the status and any error code/message so that the
 * lead-detail timeline can surface "undelivered (30034 — A2P 10DLC
 * unregistered)" instead of falsely showing "sent" forever.
 */
// Signature-verified now (V1 hardening 2026-05-24). Previously this endpoint
// was open — anyone with a MessageSid could POST and falsify delivery state.
router.post('/status', resolveTwilioTenant, verifyTwilioSignature, async (req, res) => {
  const {
    MessageSid: sid,
    MessageStatus: status,
    ErrorCode: errorCode,
    ErrorMessage: errorMessage,
  } = req.body;

  if (sid && status) {
    // 1. Legacy messages table — scoped to the verified tenant so a stray
    //    forged callback (now blocked by signature check, but defense in
    //    depth) can never touch another tenant's messages.
    try {
      await db.from('messages')
        .update({ status })
        .eq('tenant_id', req.tenantId)
        .eq('external_id', sid);
    } catch (e) {
      console.warn('[twilio/status] messages update failed:', e.message);
    }

    // 2. conversations table — merge delivery status + error code into
    //    the existing metadata JSON so the timeline can surface the
    //    real state. We read-modify-write to avoid clobbering other
    //    metadata fields (agent, step, etc.).
    try {
      const { data: rows } = await db
        .from('conversations')
        .select('id, metadata')
        .eq('tenant_id', req.tenantId)
        .eq('channel', 'sms')
        .filter('metadata->>external_id', 'eq', sid)
        .limit(1);
      const row = rows && rows[0];
      if (row) {
        const merged = {
          ...(row.metadata || {}),
          delivery_status: status,
          ...(errorCode ? { error_code: String(errorCode), error_message: errorMessage || null } : {}),
        };
        await db.from('conversations')
          .update({ metadata: merged })
          .eq('id', row.id);
      }
    } catch (e) {
      console.warn('[twilio/status] conversations update failed:', e.message);
    }

    // 3. Loud log on the dropped-by-carrier cases so they're visible in
    //    Railway logs immediately, not buried in DB rows.
    if (status === 'undelivered' || status === 'failed') {
      console.warn(`[twilio/status] sid=${sid} status=${status} error=${errorCode || 'none'} msg="${errorMessage || ''}"`);
    }
  }

  res.sendStatus(200);
});

module.exports = router;
