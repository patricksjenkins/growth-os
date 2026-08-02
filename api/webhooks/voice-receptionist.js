/**
 * Growth OS — Voice Receptionist Webhook (Module 9)
 *
 * Telnyx carries the call; Vapi answers it.
 *
 *  POST /webhooks/voice-receptionist/telnyx
 *    Telnyx's inbound voice URL. Returns TeXML that rings the owner
 *    first, then hands the call to Vapi over SIP if they don't pick up.
 *
 *  POST /webhooks/voice-receptionist/telnyx/after
 *    Telnyx fallback action when the owner-forward leg times out.
 *    Returns the Vapi SIP handoff.
 *
 *  POST /webhooks/voice-receptionist/complete
 *    Vapi's server webhook fired at end-of-call with the transcript
 *    + structured captureLead extraction. Enqueues the voice-receptionist
 *    agent which inserts the lead, fires the downstream pipeline, and
 *    texts the owner the transcript.
 *
 * Routes are public (carriers don't carry an Auth header). The tenant is
 * resolved from the dialed number, and the Vapi callback is verified against
 * a shared secret.
 */

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../core/logger');
const { isModuleEnabled } = require('../../core/modules');
const { getConfig } = require('../../core/config');
const { enqueueJob } = require('../../db/queries/jobs');
const { db } = require('../../db/client');
const voiceAi = require('../../integrations/voice-ai');
const { sendPushToTenant } = require('../../integrations/push');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { verifyTelnyxSignature } = require('./telnyx');
const { requireWebhookRoute } = require('../../core/security/webhook-route-policy');

const requireVapiRoute = requireWebhookRoute('vapi');

/**
 * Format a US 10-digit number as (xxx) xxx-xxxx for push notification
 * readability. Falls back to the raw value if it's not a US-shape number.
 */
function _prettyPhone(raw) {
  if (!raw) return 'Unknown caller';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

/**
 * Fire-and-forget push notification to the tenant owner the instant a
 * call lands at the webhook — BEFORE the TeXML response goes back. This
 * is the headlight: even if the call gets forwarded to voicemail, AI,
 * or the owner has their phone on silent, the push wakes the lock screen.
 *
 * Deliberately not awaited so the TeXML response isn't blocked by a
 * slow Expo Push call. Errors are swallowed — the push is best-effort.
 */
function _pushIncomingCallAsync(tenant, callerPhone, callSid) {
  if (!tenant?.id) return;
  sendPushToTenant(tenant.id, {
    title: '📞 Incoming call',
    body: `From ${_prettyPhone(callerPhone)} — ringing now.`,
    data: {
      route: '/voice',
      type: 'incoming_call',
      caller_phone: callerPhone,
      call_sid: callSid,
    },
    sound: 'default',
  }).catch(() => { /* best-effort */ });
}

// Telnyx TeXML posts form-encoded payloads.
router.use(express.urlencoded({
  extended: false,
  verify: (req, _res, buf) => {
    if (!req.rawBody) req.rawBody = buf;
  },
}));
// Vapi sends JSON.
router.use(express.json({ limit: '2mb' }));

function buildFallbackVoicemailTeXML(businessName) {
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
 * Vapi.ai end-of-call server webhook. Fired once Vapi finishes the
 * conversation; payload includes the transcript and the captureLead
 * extraction (called by the assistant tool at end-of-call).
 *
 * Authenticated via X-Vapi-Signature shared secret.
 */
router.post('/complete', requireVapiRoute, async (req, res) => {
  const log = createLogger('voice-receptionist-complete');
  try {
    // V1 hardening (2026-05-24): prefer HMAC-over-body signature when
    // VAPI_HMAC_SECRET is configured. Falls back to the static-bearer
    // x-vapi-secret check for the existing assistant config. Once the
    // Vapi dashboard is updated to send the HMAC header, the static
    // path can be retired.
    const hmacHeader = req.headers['x-vapi-hmac'];
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const hmacResult = voiceAi.verifyServerSignature(rawBody, hmacHeader);
    let authed = false;
    if (hmacResult === null) {
      // HMAC mode not configured — fall back to static-bearer.
      const vapiSecret = req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'];
      authed = voiceAi.verifyServerSecret(vapiSecret);
    } else {
      authed = !!hmacResult;
    }
    if (!authed) {
      log.warn('Rejected Vapi callback — bad signature', {
        has_secret_header: !!req.headers['x-vapi-secret'],
        has_signature_header: !!req.headers['x-vapi-signature'],
        has_hmac_header: !!hmacHeader,
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

    const claimedTenantId = message?.assistant?.metadata?.tenant_id
      || body?.assistant?.metadata?.tenant_id
      || message?.metadata?.tenant_id
      || null;
    const callSid = message?.assistant?.metadata?.call_sid
      || message?.call?.phoneCallProviderId
      || message?.metadata?.call_sid
      || null;
    const vapiCallId = message?.call?.id || body?.call?.id || null;

    // V1 hardening (2026-05-24): cross-check Vapi-supplied tenant_id
    // against what we stored when initiating the call. The Vapi shared
    // secret is a single env-deployed bearer; anyone who learns it can
    // post a fabricated end-of-call event targeting any tenant.
    // Authoritative tenant comes from voice_calls, keyed by the carrier
    // call id issued at call setup.
    let tenantId = null;
    if (callSid) {
      const { data: callRow } = await db
        .from('voice_calls')
        .select('tenant_id')
        .eq('call_sid', callSid)
        .maybeSingle();
      if (callRow?.tenant_id) tenantId = callRow.tenant_id;
    }
    if (!tenantId) {
      // Fall back to the claimed tenant ONLY if we have no record of the
      // call yet (race: complete arrives before initiate persisted).
      tenantId = claimedTenantId;
    } else if (claimedTenantId && claimedTenantId !== tenantId) {
      log.error(`Vapi tenant_id mismatch: claimed=${claimedTenantId} actual=${tenantId} — rejecting`);
      return res.status(403).json({ ok: false, error: 'tenant_id_mismatch' });
    }

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

    const durationSeconds = Math.round((message?.call?.endedAt && message?.call?.startedAt)
      ? (new Date(message.call.endedAt).getTime() - new Date(message.call.startedAt).getTime()) / 1000
      : (message?.durationSeconds || 0));

    // Record the AI voice-call cost on the usage ledger so the Voice
    // Receptionist shows up in Usage & Costs. Prefer Vapi's actual reported
    // cost; fall back to duration x configurable per-minute rate
    // (VAPI_COST_PER_MINUTE, default $0.13/min). Best-effort, never blocks.
    try {
      const tracker = require('../../core/ai-safety/usage-tracker');
      const reported = Number(message?.cost ?? body?.cost);
      const ratePerMin = Number(process.env.VAPI_COST_PER_MINUTE || 0.13);
      const estimatedCostUsd = Number.isFinite(reported) && reported > 0
        ? reported
        : Math.round((durationSeconds / 60) * ratePerMin * 10000) / 10000;
      tracker.recordUsage({
        tenantId, provider: 'vapi', model: message?.assistant?.model?.model || 'voice-receptionist',
        operationType: 'voice_receptionist', agentName: 'voice-receptionist',
        estimatedCostUsd, isAutomated: true,
        requestSource: 'api/webhooks/voice-receptionist.js:complete',
      }).catch(() => {});
    } catch (_) { /* never let cost tracking break the webhook */ }

    // Enqueue the worker agent to do the heavy lifting (lead insert,
    // pipeline enqueue, transcript SMS, usage increment, etc). Webhook
    // returns fast so Vapi doesn't retry.
    await enqueueJob(tenantId, 'voice-receptionist', {
      call_sid: callSid,
      vapi_call_id: vapiCallId,
      caller_phone: message?.customer?.number || message?.call?.customer?.number || null,
      duration_seconds: durationSeconds,
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

// ---------------------------------------------------------------------------
// TELNYX VOICE FLOW (TeXML) — "ring the owner first, then hand to Vapi via SIP"
//
// FGA's Telnyx number. Telnyx TeXML is
// <Dial> the owner with a timeout; on no-answer the
// /telnyx/after callback <Dial>s Riley's Vapi SIP URI. Config-driven:
//   voice_receptionist_forward_to  — cell to ring first
//   voice_receptionist_ring_count  — rings before AI (Telnyx ~6s/ring)
//   vapi_sip_uri                   — sip:fga-riley@sip.vapi.ai
// Public endpoints (Telnyx fetches them); verified by Telnyx signature.
// NOTE: no AMD yet — with a 3-ring (~18s) timeout the owner's voicemail
// usually picks up later, so the timeout fires first and routes to Riley.
// ---------------------------------------------------------------------------
const { FGA_TENANT_ID } = require('../../core/config');
const { resolveTenant } = require('../../core/tenant');
const { getServiceClient } = require('../../db/client');

async function _resolveTelnyxTenant() {
  // resolveTenant loads the tenant WITH its layered .config (which getConfig reads).
  return resolveTenant(getServiceClient(), FGA_TENANT_ID);
}

function _vapiSipTeXML(sipUri, tenant) {
  if (!sipUri) return buildFallbackVoicemailTeXML(tenant?.name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true"><Sip>${sipUri}</Sip></Dial>
</Response>`;
}

// Inbound: ring the owner's cell first.
router.post('/telnyx', (req, res, next) => {
  if (flags.strictWebhookVerification() && !verifyTelnyxSignature(req)) {
    return res.status(403).json({ error: 'Invalid signature' });
  }
  next();
}, async (req, res) => {
  const log = createLogger('voice-telnyx');
  try {
    const tenant = await _resolveTelnyxTenant();
    _pushIncomingCallAsync(tenant, req.body?.From || req.body?.from, req.body?.CallSid || req.body?.call_control_id);
    const forwardTo = getConfig(tenant, 'voice_receptionist_forward_to', null);
    const ringCount = Number(getConfig(tenant, 'voice_receptionist_ring_count', 3));
    const timeoutSeconds = Math.max(0, Math.min(60, ringCount * 6));
    const sipUri = getConfig(tenant, 'vapi_sip_uri', null);
    if (!forwardTo || timeoutSeconds === 0) {
      return res.type('text/xml').send(_vapiSipTeXML(sipUri, tenant));
    }
    // machineDetection="Enable" so voicemail answering (which otherwise looks
    // like DialCallStatus=completed) is reported as AnsweredBy=machine_* in the
    // action callback, and we route those to Riley instead of leaving the
    // caller in the owner's voicemail.
    const texml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${timeoutSeconds}" answerOnBridge="true" action="/webhooks/voice-receptionist/telnyx/after">
    <Number machineDetection="Enable">${forwardTo}</Number>
  </Dial>
</Response>`;
    res.type('text/xml').send(texml);
  } catch (err) {
    log.error('Telnyx inbound voice failed', err);
    res.type('text/xml').send(buildFallbackVoicemailTeXML());
  }
});

// After the owner-dial leg: owner answered -> done; otherwise -> Riley via SIP.
router.post('/telnyx/after', (req, res, next) => {
  if (flags.strictWebhookVerification() && !verifyTelnyxSignature(req)) {
    return res.status(403).json({ error: 'Invalid signature' });
  }
  next();
}, async (req, res) => {
  const log = createLogger('voice-telnyx');
  try {
    const tenant = await _resolveTelnyxTenant();
    const dialStatus = req.body?.DialCallStatus || req.body?.dial_call_status || '';
    const answeredBy = req.body?.AnsweredBy || req.body?.answered_by || '';

    // Only a LIVE human stops the AI handoff. Voicemail answers as
    // 'completed' but AMD flags it via AnsweredBy=machine_* -> route to Riley.
    if (answeredBy === 'human') {
      log.info('Owner answered live (human); no AI handoff');
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    if (!answeredBy && (dialStatus === 'completed' || dialStatus === 'answered')) {
      // No AMD verdict but call completed normally — assume owner handled.
      log.info(`No AMD verdict, DialCallStatus=${dialStatus}; assuming owner handled`);
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    // Voicemail (machine_*) / no-answer / busy / failed -> hand to Riley.
    const sipUri = getConfig(tenant, 'vapi_sip_uri', null);
    log.info(`Routing to Vapi (DialCallStatus=${dialStatus}, AnsweredBy=${answeredBy || 'none'})`);
    res.type('text/xml').send(_vapiSipTeXML(sipUri, tenant));
  } catch (err) {
    log.error('Telnyx after-dial failed', err);
    res.type('text/xml').send(buildFallbackVoicemailTeXML());
  }
});

// ---------------------------------------------------------------------------
// VAPI DYNAMIC ASSISTANT — point the SIP number's "Server URL" here.
// On inbound, Vapi POSTs an 'assistant-request'; we return the SAME per-tenant
// FGA receptionist config the TeXML flow builds (Clara voice, FGA greeting,
// services/hours/emergency knowledge, captureLead) — so the Telnyx SIP path
// uses the identical assistant instead of a generic saved one.
// ---------------------------------------------------------------------------
router.post('/vapi-assistant', requireVapiRoute, async (req, res) => {
  const log = createLogger('voice-vapi-assistant');
  try {
    if (flags.strictWebhookVerification()) {
      const provided = req.headers['x-vapi-secret'] || req.headers['x-vapi-signature'];
      if (!voiceAi.verifyServerSecret(provided)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
    const tenant = await _resolveTelnyxTenant();
    const assistant = voiceAi.buildAssistantConfig(tenant, {});
    log.info(`Served FGA assistant (voice=${assistant?.voice?.voiceId}) to Vapi`);
    res.json({ assistant });
  } catch (err) {
    log.error('vapi-assistant request failed', err);
    res.status(200).json({ error: 'Assistant temporarily unavailable.' });
  }
});

// ---------------------------------------------------------------------------
// ONE-SHOT SETUP — materialize the FGA receptionist as a SAVED Vapi assistant.
// The Telnyx SIP number REQUIRES a statically-assigned assistant (can't be
// blank, and a static assistant overrides the Server URL/assistant-request).
// Hit this once to create/update a named "First Gen Automate Receptionist"
// assistant (Clara voice, FGA prompt, captureLead) that Patrick then selects
// in the SIP number's Assistant dropdown. Guarded by VAPI_SERVER_SECRET.
//   curl -X POST '<API>/webhooks/voice-receptionist/sync-assistant?secret=<VAPI_SERVER_SECRET>'
// ---------------------------------------------------------------------------
router.post('/sync-assistant', requireVapiRoute, async (req, res) => {
  const log = createLogger('voice-sync-assistant');
  try {
    const provided = req.query.secret || req.headers['x-admin-secret'];
    if (!voiceAi.verifyServerSecret(provided)) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const tenant = await _resolveTelnyxTenant();
    const result = await voiceAi.syncSavedAssistant(tenant);
    log.info(`Saved FGA assistant synced: ${result.id}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    log.error('sync-assistant failed', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
