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

    // Store the inbound message
    await db.from('messages').insert({
      tenant_id: req.tenantId,
      channel: 'sms',
      direction: 'inbound',
      body,
      external_id: sid,
      sent_at: new Date().toISOString()
    });

    // Check if this is a reply to an outreach campaign — enqueue classification
    if (isModuleEnabled(req.tenant, 'outreach_drip')) {
      await enqueueJob(req.tenantId, 'reply-classification', {
        from,
        body,
        channel: 'sms',
        message_sid: sid
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
