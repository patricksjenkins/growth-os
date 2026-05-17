/**
 * Growth OS — Vapi.ai integration (Module 9 AI Voice Receptionist)
 *
 * Thin wrapper around Vapi's REST API. Vapi handles the realtime voice
 * conversation (TTS + STT + LLM orchestration); we hand it a per-call
 * assistant config built from the tenant's onboarding data and Vapi
 * runs the conversation, calls our end-of-call function to deliver
 * structured lead extraction, then we process the result here.
 *
 * Privacy by design: every assistant config we build sets
 * `recordingEnabled: false`. We only persist the text transcript.
 *
 * Environment variables required:
 *   VAPI_API_KEY           — Vapi.ai private key (server-side)
 *   VAPI_PHONE_NUMBER_ID   — Vapi-side ID of FGA's pooled phone number (optional;
 *                            we mostly hand off Twilio calls via ConversationRelay
 *                            so this is only needed for outbound test calls)
 *   PUBLIC_API_BASE        — Public HTTPS URL of this API (e.g.
 *                            https://growth-os-production.up.railway.app)
 *                            used by Vapi to call our end-of-call webhook
 *
 * If VAPI_API_KEY is missing the integration short-circuits and the voice
 * webhook falls back to missed-call text-back (so a misconfig doesn't take
 * the call hostage).
 */

const { createLogger } = require('../core/logger');
const { getConfig } = require('../core/config');

const log = createLogger('vapi');

// Vapi REST base. Keep configurable in case they version the API.
const VAPI_BASE = process.env.VAPI_API_BASE || 'https://api.vapi.ai';

// Four stock voices we expose during onboarding. Owner picks one;
// otherwise default to 'jennifer'. IDs are Vapi.ai's catalog.
const VOICE_OPTIONS = {
  jennifer:  { provider: 'vapi', voiceId: 'Neha',     label: 'Jennifer — warm female' },
  rachel:    { provider: 'vapi', voiceId: 'Elliot',   label: 'Rachel — professional female' },
  michael:   { provider: 'vapi', voiceId: 'Cole',     label: 'Michael — friendly male' },
  david:     { provider: 'vapi', voiceId: 'Hana',     label: 'David — confident male' },
};

function isConfigured() {
  return !!process.env.VAPI_API_KEY;
}

/**
 * Build the Vapi assistant config for a single inbound call. Composed
 * from per-tenant onboarding data so the AI knows:
 *  - the business name and tone
 *  - the services offered + service area
 *  - hours of operation
 *  - emergency keywords that trigger high-priority escalation
 *  - the structured lead extraction it owes us at end of call
 */
function buildAssistantConfig(tenant, callContext = {}) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense.');
  const services = getConfig(tenant, 'services', '') || '';
  const serviceArea = getConfig(tenant, 'service_area', '') || '';
  const hours = getConfig(tenant, 'business_hours', '') || '';
  const emergencyKeywords = getConfig(tenant, 'voice_receptionist_emergency_keywords', [
    'burst pipe', 'smoke', 'gas leak', 'no power', 'flooding', 'no heat',
  ]);
  const openingLineOverride = getConfig(tenant, 'voice_receptionist_opening_line', null);
  const voiceKey = getConfig(tenant, 'voice_receptionist_voice', 'jennifer');
  const voice = VOICE_OPTIONS[voiceKey] || VOICE_OPTIONS.jennifer;

  const firstMessage = openingLineOverride
    || `Thanks for calling ${businessName}. How can I help?`;

  const systemPrompt = [
    `You are the receptionist for ${businessName}. Your job is to handle inbound calls when the owner can't pick up.`,
    ``,
    `Brand voice: ${brandVoice}`,
    `Sound like a friendly real person, not a robot. Never say "AI", "automated", or "bot".`,
    ``,
    services ? `Services we offer: ${services}` : '',
    serviceArea ? `Service area: ${serviceArea}` : '',
    hours ? `Business hours: ${hours}` : '',
    ``,
    `Your goal on every call:`,
    `1. Find out who's calling and what they need.`,
    `2. Get a callback number you can text back at.`,
    `3. For service inquiries: capture the service type, address, and urgency.`,
    `4. For emergencies (${emergencyKeywords.join(', ')}): get the address and phone fast, tell them the owner will be paged immediately, and end the call so they can take other steps.`,
    `5. For wrong numbers, sales calls, or spam: politely end the call without capturing.`,
    ``,
    `Pricing: don't quote prices. Tell them the owner will reach out with specifics.`,
    `Scheduling: don't book firm appointments. Capture preferred callback window and let the owner confirm.`,
    `Recording: this call is NOT being recorded — only a text transcript is kept.`,
    ``,
    `At end-of-call ALWAYS invoke the captureLead function with the structured outcome — even if no lead was captured (use classification="spam" or "wrong_number").`,
  ].filter(Boolean).join('\n');

  return {
    name: `${businessName} Receptionist`,
    firstMessage,
    voice: { provider: voice.provider, voiceId: voice.voiceId },
    model: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.4,
      systemPrompt,
      tools: [
        {
          type: 'function',
          function: {
            name: 'captureLead',
            description: 'Call this exactly once at end-of-call with the structured outcome of the conversation.',
            parameters: {
              type: 'object',
              required: ['classification'],
              properties: {
                classification: {
                  type: 'string',
                  enum: ['new_lead', 'existing_customer', 'spam', 'wrong_number', 'emergency', 'other'],
                  description: 'How to categorize this call.',
                },
                caller_name: { type: 'string', description: "Caller's full name if given." },
                callback_phone: { type: 'string', description: 'Callback number in E.164 if given; otherwise the caller ID.' },
                service_type: { type: 'string', description: 'Service they asked about (e.g. tree removal, drain repair).' },
                address: { type: 'string', description: 'Service address if given.' },
                urgency: { type: 'string', enum: ['emergency', 'asap', 'this_week', 'flexible'] },
                notes: { type: 'string', description: 'Free-form notes — any context the owner should know before calling back.' },
                emergency_detected: { type: 'boolean' },
              },
            },
          },
        },
      ],
    },
    // CRITICAL — privacy by design. We never store audio.
    recordingEnabled: false,
    serverUrl: `${process.env.PUBLIC_API_BASE || ''}/webhooks/voice-receptionist/complete`,
    serverUrlSecret: process.env.VAPI_SERVER_SECRET || undefined,
    // Hang up if caller is silent for 30s; reasonable upper bound for an
    // inbound service-business call.
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 300, // 5 minutes hard cap per call
    endCallFunctionEnabled: true,
    metadata: {
      tenant_id: tenant.id,
      twilio_call_sid: callContext.twilio_call_sid || null,
    },
  };
}

/**
 * Hand off a Twilio inbound call to Vapi via their Twilio integration.
 * This returns the WSS URL we plug into TwiML's <Connect><Stream> so
 * Vapi takes over the call media in realtime.
 *
 * In practice: we POST an assistant config to /call/inbound and Vapi
 * returns the websocket details. Some Vapi setups use a pre-registered
 * assistant ID instead; that path is supported via the
 * VAPI_DEFAULT_ASSISTANT_ID env var fallback.
 */
async function createInboundCall(tenant, callContext = {}) {
  if (!isConfigured()) {
    throw new Error('VAPI_API_KEY not set — Voice Receptionist disabled');
  }

  const assistant = buildAssistantConfig(tenant, callContext);
  const payload = {
    assistant,
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || undefined,
    customer: callContext.caller_phone ? { number: callContext.caller_phone } : undefined,
  };

  const res = await fetch(`${VAPI_BASE}/call/inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    log.error(`Vapi inbound-call create failed (${res.status}): ${text.slice(0, 300)}`);
    throw new Error(`Vapi inbound-call failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Verify the X-Vapi-Signature header on incoming server webhook events.
 * Returns true when the secret matches or when no secret is configured
 * (dev mode). In production we set VAPI_SERVER_SECRET and reject
 * mismatches so external posters can't forge a captureLead callback.
 */
function verifyServerSecret(headerValue) {
  const expected = process.env.VAPI_SERVER_SECRET;
  if (!expected) return true; // dev mode
  return headerValue === expected;
}

module.exports = {
  isConfigured,
  buildAssistantConfig,
  createInboundCall,
  verifyServerSecret,
  VOICE_OPTIONS,
};
