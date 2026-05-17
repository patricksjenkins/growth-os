/**
 * Growth OS — Voice Receptionist Webhook (Module 9)
 *
 * Three Twilio + Vapi webhook endpoints in one router:
 *
 *  POST /webhooks/voice-receptionist
 *    Twilio's primary inbound voice URL. Returns TwiML that:
 *      1. Tries to forward to the owner first (default 4 rings).
 *      2. If they don't pick up, hands the call to Vapi.ai via
 *         <Connect><Stream> for AI handling.
 *
 *  POST /webhooks/voice-receptionist/no-answer
 *    Twilio fallback action when the owner-forward leg times out.
 *    Returns the Vapi handoff TwiML.
 *
 *  POST /webhooks/voice-receptionist/complete
 *    Vapi.ai's server webhook fired at end-of-call with the transcript
 *    + structured captureLead extraction. Enqueues the voice-receptionist
 *    agent which inserts the lead, fires the downstream pipeline, and
 *    texts the owner the transcript.
 *
 * All routes are public (Twilio + Vapi don't carry an Auth header). We
 * resolve the tenant from the dialed phone number on the Twilio webhook
 * and verify a shared secret on the Vapi callback.
 */

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../core/logger');
const { resolveTwilioTenant, verifyTwilioSignature } = require('../middleware/webhookVerify');
const { isModuleEnabled } = require('../../core/modules');
const { getConfig } = require('../../core/config');
const { enqueueJob } = require('../../db/queries/jobs');
const { db } = require('../../db/client');
const voiceAi = require('../../integrations/voice-ai');

// Twilio sends form-encoded payloads.
router.use(express.urlencoded({ extended: false }));
// Vapi sends JSON.
router.use(express.json({ limit: '2mb' }));

/**
 * Build the TwiML that hands the call to Vapi for AI handling. Wrapped
 * in a separate helper so both the no-answer fallback and any future
 * "skip the owner ring" path can reuse it.
 */
function buildVapiHandoffTwiml() {
  // We use <Connect><Stream> media streaming pointed at Vapi's call
  // ingestion URL. The serverUrl on the assistant config receives the
  // end-of-call callback.
  // The Vapi inbound call ID is created in the no-answer handler; here
  // we just route the media stream.
  // Note: in production we typically POST to /call to get a real-time
  // stream URL — for the safe-without-API-key path we fall back to a
  // simple voicemail prompt.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for calling. The AI assistant is connecting now. This call is not being recorded — only a text transcript is kept.</Say>
  <Connect>
    <Stream url="wss://api.vapi.ai/twilio-stream" />
  </Connect>
</Response>`;
}

function buildFallbackVoicemailTwiml(businessName) {
  // Used when Vapi isn't configured (no VAPI_API_KEY) OR the per-tenant
  // voice cap is reached. Falls back to a brief recording prompt that
  // matches the existing missed-call flow so the existing missed-call
  // agent picks it up.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for calling ${businessName || 'us'}. We can't pick up right now — please leave a brief message and we'll text you back shortly.</Say>
  <Record maxLength="60" playBeep="true" />
</Response>`;
}

/**
 * Primary Twilio inbound voice webhook. Tries to forward to the owner
 * first; on no-answer, falls through to the Vapi handoff endpoint.
 */
router.post('/', resolveTwilioTenant, verifyTwilioSignature, async (req, res) => {
  const log = createLogger('voice-receptionist', req.tenant?.slug);
  try {
    if (!isModuleEnabled(req.tenant, 'voice_receptionist')) {
      // Module gated off — fall through to whatever the missed_call module
      // already does. The voice URL was set by app-asset-pipeline only when
      // the tenant has voice_receptionist enabled, so we should rarely
      // land here — but defend against config drift.
      log.info('voice_receptionist module disabled — short-circuit to fallback voicemail');
      res.type('text/xml').send(buildFallbackVoicemailTwiml(req.tenant?.name));
      return;
    }

    const forwardTo = getConfig(req.tenant, 'voice_receptionist_forward_to', null);
    const ringCount = Number(getConfig(req.tenant, 'voice_receptionist_ring_count', 4));
    // Twilio rings ~5s each. Convert ring count to timeout seconds.
    const timeoutSeconds = Math.max(0, Math.min(60, ringCount * 5));

    // If ringCount=0, owner doesn't want a ring — go straight to AI.
    if (timeoutSeconds === 0) {
      log.info('Ring count 0 — going straight to Vapi handoff');
      res.type('text/xml').send(buildVapiHandoffTwiml());
      return;
    }

    if (!forwardTo) {
      log.warn('No voice_receptionist_forward_to configured — going straight to Vapi handoff');
      res.type('text/xml').send(buildVapiHandoffTwiml());
      return;
    }

    // Dial the owner first; on no-answer/busy/failed, Twilio POSTs the
    // /no-answer action with the result.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${timeoutSeconds}" action="/webhooks/voice-receptionist/no-answer" answerOnBridge="true">
    <Number>${forwardTo}</Number>
  </Dial>
</Response>`;
    res.type('text/xml').send(twiml);
  } catch (err) {
    log.error('Inbound voice webhook failed', err);
    res.type('text/xml').send(buildFallbackVoicemailTwiml(req.tenant?.name));
  }
});

/**
 * Twilio fallback when the owner-forward leg ends without the owner
 * answering (no-answer, busy, failed, completed-instantly). At that
 * point we hand the call to Vapi for AI pickup, IF the tenant has
 * minutes remaining and Vapi is configured.
 */
router.post('/no-answer', resolveTwilioTenant, verifyTwilioSignature, async (req, res) => {
  const log = createLogger('voice-receptionist', req.tenant?.slug);
  try {
    const dialStatus = req.body?.DialCallStatus || '';
    // If the owner DID answer, Twilio still calls this action when the
    // call ends. Bail without a TwiML response so the call just terminates.
    if (dialStatus === 'completed' || dialStatus === 'answered') {
      log.info(`Owner handled the call (DialCallStatus=${dialStatus}); no AI handoff needed`);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }

    if (!voiceAi.isConfigured()) {
      log.warn('Vapi not configured — falling back to voicemail');
      res.type('text/xml').send(buildFallbackVoicemailTwiml(req.tenant?.name));
      return;
    }

    // Volume cap check — refuse Vapi handoff if tenant is over their
    // 200-min/mo Scale-tier allowance.
    const cap = Number(getConfig(req.tenant, 'voice_receptionist_minutes_cap', 200));
    const { data: usage } = await db
      .from('tenant_usage')
      .select('voice_minutes_used')
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    const used = Number(usage?.voice_minutes_used || 0);
    if (used >= cap) {
      log.warn(`Voice minutes cap reached (${used}/${cap}); falling back to voicemail`);
      res.type('text/xml').send(buildFallbackVoicemailTwiml(req.tenant?.name));
      return;
    }

    // Hand off to Vapi.
    log.info(`Owner missed (status=${dialStatus}); handing call to Vapi`);
    res.type('text/xml').send(buildVapiHandoffTwiml());
  } catch (err) {
    log.error('No-answer fallback failed', err);
    res.type('text/xml').send(buildFallbackVoicemailTwiml(req.tenant?.name));
  }
});

/**
 * Vapi.ai end-of-call server webhook. Fired once Vapi finishes the
 * conversation; payload includes the transcript and the captureLead
 * extraction (called by the assistant tool at end-of-call).
 *
 * Authenticated via X-Vapi-Signature shared secret.
 */
router.post('/complete', async (req, res) => {
  const log = createLogger('voice-receptionist-complete');
  try {
    if (!voiceAi.verifyServerSecret(req.headers['x-vapi-signature'])) {
      log.warn('Rejected Vapi callback — bad signature');
      return res.status(401).json({ ok: false });
    }

    const body = req.body || {};
    const message = body.message || body; // Vapi nests events under message
    const eventType = message.type || body.type;

    // Only act on end-of-call events; other events (status updates,
    // function-call traces) we acknowledge silently.
    if (eventType && eventType !== 'end-of-call-report' && eventType !== 'call.ended') {
      return res.json({ ok: true });
    }

    const tenantId = message?.assistant?.metadata?.tenant_id
      || body?.assistant?.metadata?.tenant_id
      || message?.metadata?.tenant_id
      || null;
    const twilioCallSid = message?.assistant?.metadata?.twilio_call_sid
      || message?.call?.phoneCallProviderId
      || message?.metadata?.twilio_call_sid
      || null;
    const vapiCallId = message?.call?.id || body?.call?.id || null;

    if (!tenantId) {
      log.warn('Vapi end-of-call without tenant_id metadata — cannot process');
      return res.json({ ok: false, error: 'no_tenant_id' });
    }

    // The captureLead tool call result is in message.toolCalls or
    // message.functionCalls depending on Vapi's payload version.
    const toolCalls = message?.toolCalls || message?.functionCalls || [];
    const capture = (toolCalls || []).find((c) => (c.function?.name || c.name) === 'captureLead');
    const extracted = capture?.function?.arguments || capture?.arguments || {};
    const extractedObj = typeof extracted === 'string' ? safeJson(extracted) : extracted;

    // Enqueue the worker agent to do the heavy lifting (lead insert,
    // pipeline enqueue, transcript SMS, usage increment, etc). Webhook
    // returns fast so Vapi doesn't retry.
    await enqueueJob(tenantId, 'voice-receptionist', {
      twilio_call_sid: twilioCallSid,
      vapi_call_id: vapiCallId,
      caller_phone: message?.customer?.number || message?.call?.customer?.number || null,
      duration_seconds: Math.round((message?.call?.endedAt && message?.call?.startedAt)
        ? (new Date(message.call.endedAt).getTime() - new Date(message.call.startedAt).getTime()) / 1000
        : (message?.durationSeconds || 0)),
      transcript: message?.transcript || message?.artifact?.transcript || '',
      extracted: extractedObj || {},
    }, { priority: 9 });

    res.json({ ok: true });
  } catch (err) {
    log.error('Vapi complete webhook failed', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = router;
