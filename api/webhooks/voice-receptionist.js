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
 * Build the TwiML that hands the call off to Vapi for AI handling.
 * Calls Vapi's POST /call endpoint with phoneCallProviderBypassEnabled
 * — Vapi returns ready-to-use TwiML in phoneCallProviderDetails.twiml
 * that we return verbatim to Twilio. Twilio then streams the call
 * media to the WSS URL embedded inside that TwiML.
 *
 * Returns a TwiML string. Throws on Vapi error — caller should catch
 * and fall back to voicemail.
 */
async function buildVapiHandoffTwiml(tenant, callContext = {}) {
  return voiceAi.createInboundCallTwiml(tenant, callContext);
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
    if (timeoutSeconds === 0 || !forwardTo) {
      const reason = timeoutSeconds === 0 ? 'ring count 0' : 'no forward_to configured';
      log.info(`Going straight to Vapi handoff (${reason})`);
      try {
        const twiml = await buildVapiHandoffTwiml(req.tenant, {
          caller_phone: req.body.From,
          twilio_call_sid: req.body.CallSid,
        });
        res.type('text/xml').send(twiml);
      } catch (vapiErr) {
        log.error(`Vapi handoff failed; falling back to voicemail: ${vapiErr.message}`);
        res.type('text/xml').send(buildFallbackVoicemailTwiml(req.tenant?.name));
      }
      return;
    }

    // Dial the owner first WITH machine detection on the forwarded leg.
    // Without AMD, iPhone voicemail picks up faster than our timeout and
    // Twilio reports DialCallStatus=completed (treats voicemail as
    // answered). With machineDetection="Enable" on <Number>, Twilio
    // listens to the answering side and reports AnsweredBy in the
    // action callback — we use that to distinguish human-answered vs
    // voicemail-answered and route to AI on the latter.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${timeoutSeconds}" action="/webhooks/voice-receptionist/no-answer" answerOnBridge="true">
    <Number machineDetection="Enable" machineDetectionTimeout="8">${forwardTo}</Number>
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
    const answeredBy = req.body?.AnsweredBy || '';

    // Honor AMD when present: only treat the call as owner-handled when
    // a real human answered. Voicemail / fax / machine all route to AI.
    //
    //   AnsweredBy values (Twilio): human | machine_start | machine_end_beep
    //                              | machine_end_silence | machine_end_other
    //                              | fax | unknown
    //
    // We deliberately do NOT short-circuit on dialStatus='completed' alone
    // anymore — iPhone voicemail picks up so fast that completed = voicemail
    // half the time. If AnsweredBy is missing (no AMD attempted, edge case),
    // fall back to the old behavior so we don't loop.
    if (answeredBy === 'human') {
      log.info(`Owner picked up live (AnsweredBy=human); no AI handoff`);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }
    if (answeredBy && answeredBy.startsWith('machine')) {
      log.info(`Voicemail detected (AnsweredBy=${answeredBy}); handing call to Vapi`);
      // fall through to handoff path below
    } else if (answeredBy === 'fax') {
      log.info('Fax detected; not routing to AI');
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    } else if (!answeredBy && (dialStatus === 'completed' || dialStatus === 'answered')) {
      // No AMD verdict but call completed normally — assume owner handled.
      log.info(`No AMD verdict, DialCallStatus=${dialStatus}; assuming owner handled`);
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }
    // Otherwise (no-answer / busy / failed / canceled / machine_*) → AI handoff
    log.info(`Routing to AI (DialCallStatus=${dialStatus}, AnsweredBy=${answeredBy || 'none'})`);

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
    const twiml = await buildVapiHandoffTwiml(req.tenant, {
      caller_phone: req.body.From || req.body.Caller,
      twilio_call_sid: req.body.CallSid,
    });
    res.type('text/xml').send(twiml);
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
    // Vapi sends the server secret in x-vapi-secret header (plain token).
    // Also check x-vapi-signature for forward compatibility.
    const vapiSecret = req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'];
    if (!voiceAi.verifyServerSecret(vapiSecret)) {
      log.warn('Rejected Vapi callback — bad signature', {
        has_secret_header: !!req.headers['x-vapi-secret'],
        has_signature_header: !!req.headers['x-vapi-signature'],
      });
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
