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

    // Always log the raw inbound in `messages` (general message log).
    await db.from('messages').insert({
      tenant_id: req.tenantId,
      contact_id: contactId,
      channel: 'sms',
      direction: 'inbound',
      body,
      external_id: sid,
      sent_at: new Date().toISOString()
    });

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

    // Respond with empty TwiML (acknowledge receipt)
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
 */
router.post('/status', async (req, res) => {
  const { MessageSid: sid, MessageStatus: status } = req.body;

  if (sid && status) {
    // Update message status
    await db.from('messages')
      .update({ status })
      .eq('external_id', sid);
  }

  res.sendStatus(200);
});

module.exports = router;
