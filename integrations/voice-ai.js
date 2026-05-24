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

// Stock voices we expose during onboarding. Owner picks one; otherwise
// default to 'Kai' (friendly, relaxed American male — natural fit for
// service-business receptionist). Voice IDs are Vapi's current catalog
// — the old Neha/Elliot/Cole/Hana set was retired by Vapi in 2025.
//
// Owners can specify either the short key (e.g. 'Kai') OR the legacy
// label-style key (e.g. 'michael') — both resolve here.
const VOICE_OPTIONS = {
  Clara:    { provider: 'vapi', voiceId: 'Clara',    label: 'Clara — warm professional female (US)' },
  Nico:     { provider: 'vapi', voiceId: 'Nico',     label: 'Nico — young casual male (US)' },
  Kai:      { provider: 'vapi', voiceId: 'Kai',      label: 'Kai — friendly relaxed male (US)' },
  Godfrey:  { provider: 'vapi', voiceId: 'Godfrey',  label: 'Godfrey — young energetic male (US)' },
  Savannah: { provider: 'vapi', voiceId: 'Savannah', label: 'Savannah — straightforward female (US Southern)' },
  // Legacy label aliases — kept so older tenant_config rows still resolve.
  jennifer: { provider: 'vapi', voiceId: 'Clara',    label: 'Jennifer — warm professional female (US)' },
  rachel:   { provider: 'vapi', voiceId: 'Savannah', label: 'Rachel — straightforward female (US)' },
  michael:  { provider: 'vapi', voiceId: 'Kai',      label: 'Michael — friendly relaxed male (US)' },
  david:    { provider: 'vapi', voiceId: 'Godfrey',  label: 'David — energetic male (US)' },
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
  // business_type: 'service' (default) for trade businesses — plumbers, tree
  // care, cleaners, etc. who use FGA to run their ops. 'platform' for FGA
  // itself — a SaaS company where inbound calls are sales inquiries about
  // the platform, NOT requests for trade services. Drives a different
  // system-prompt path that knows FGA's positioning + how to disambiguate
  // when a caller asks for a service FGA doesn't provide.
  const businessType = getConfig(tenant, 'business_type', 'service');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense.');
  const services = getConfig(tenant, 'services', '') || '';
  const serviceArea = getConfig(tenant, 'service_area', '') || '';
  const hours = getConfig(tenant, 'business_hours', '') || '';
  const emergencyKeywords = getConfig(tenant, 'voice_receptionist_emergency_keywords', [
    'burst pipe', 'smoke', 'gas leak', 'no power', 'flooding', 'no heat',
  ]);
  const openingLineOverride = getConfig(tenant, 'voice_receptionist_opening_line', null);
  const voiceKey = getConfig(tenant, 'voice_receptionist_voice', 'Kai');
  const voice = VOICE_OPTIONS[voiceKey] || VOICE_OPTIONS.Kai;

  const firstMessage = openingLineOverride
    || (businessType === 'platform'
        ? `Thanks for calling ${businessName}. Are you a business owner looking to learn more about our platform, or can I help you with something else?`
        : `Thanks for calling ${businessName}. How can I help?`);

  // ── PLATFORM-MODE system prompt (FGA itself) ──
  // FGA is a SaaS company, not a service provider. The receptionist needs
  // to disambiguate inbound callers who may be confused about what we do,
  // qualify them as B2B prospects (small-business owners interested in our
  // platform), and politely route everyone else.
  let systemPrompt;
  if (businessType === 'platform') {
    // Lazy require to avoid loading the knowledge file on every per-tenant
    // service-type call (saves ~3kb of prompt overhead on the common path).
    const { buildFgaKnowledgePrompt } = require('../core/fga-knowledge');
    const knowledge = buildFgaKnowledgePrompt({ includeFaqs: false, includeModules: true, includePricing: true });

    systemPrompt = [
      `You are the receptionist for ${businessName}. Your job is to handle inbound calls when Patrick (the founder) can't pick up.`,
      ``,
      `Brand voice (for tone only): ${brandVoice}`,
      `Sound like a friendly real person, not a robot. Never say "AI", "automated", or "bot".`,
      ``,
      `── BREVITY IS THE #1 RULE ──`,
      `Default response length: ONE short sentence. Talk like a real human receptionist — quick, natural, no preamble.`,
      `Don't pad with "let me help you out" or "I'd be happy to" or "absolutely!" — just ask the next question.`,
      `Example openers in turn 2:`,
      `  - "What kind of service are you looking for?"`,
      `  - "Sure, what's the question about?"`,
      `  - "Got it — what's going on?"`,
      `Only get longer (2-3 short sentences max) when:`,
      `  - You need to explain that we're a platform, not a service provider (one time, when the caller asks for a trade service).`,
      `  - The caller asks a direct question about FGA's platform, pricing, or modules.`,
      `Even then, stay tight — 2 sentences, not a paragraph.`,
      ``,
      `── CRITICAL: FGA IS A SaaS PLATFORM, NOT A TRADE-SERVICE COMPANY ──`,
      `We do NOT do plumbing, cleaning, tree care, painting, electrical, lawn care, grease-trap cleaning, junk removal, HVAC, or any other physical trade service. We are a software platform that small-business OWNERS subscribe to so that THEIR business can do those things more efficiently.`,
      ``,
      `── HOW TO HANDLE INBOUND CALLS ──`,
      ``,
      `Turn 1 (greeting): the opening line is set elsewhere. Don't repeat it.`,
      ``,
      `Turn 2 (caller's first answer):`,
      `  - If they say something vague like "I need a new service" or "I have a question" → ask ONE short follow-up: "What kind of service are you looking for?" or "What's the question about?"`,
      `  - If they immediately ask about FGA/the platform/pricing → answer briefly + ask their name.`,
      `  - Don't pre-emptively explain we're a platform — wait until they describe a need that's actually mismatched.`,
      ``,
      `When the caller describes a TRADE SERVICE need (greasetrap cleaning, plumbing, tree work, painting, etc.):`,
      `  → Pivot once with this EXACT opener phrasing: "Ok, quick clarification — we're a software platform, we don't do [their service] ourselves. Are you running a business that does that work?"`,
      `  → If they're a B2C consumer looking to hire someone → "Got it, we're not the right fit then — best of luck finding someone." End call. classification = "wrong_number".`,
      `  → If they run a business that provides that service → "Great, our platform helps small businesses like yours automate lead follow-up and a few other things. What's your business name?" Capture as B2B lead. classification = "new_lead".`,
      ``,
      `When the caller asks about our PLATFORM directly:`,
      `  → 1-2 short sentence answer using the knowledge below. Don't recite the whole catalog.`,
      `  → Then ask their name + what they want to get out of it. Tell them Patrick will follow up.`,
      `  → On pricing: just say "one-time setup plus a monthly subscription with a 14-day trial — Patrick can walk through the specifics." Don't quote exact dollars unless they push twice.`,
      ``,
      `When the caller is a vendor / agency / ad rep / recruiter:`,
      `  → "Thanks but Patrick handles all vendor stuff by email — patrick@firstgenautomate.com." End call. classification = "spam".`,
      ``,
      `── FGA KNOWLEDGE (reference only, never read verbatim) ──`,
      knowledge,
      ``,
      `── CAPTURE (when it's a real lead) ──`,
      `Name, business name, callback phone (E.164), team size, what they're interested in. Don't book firm appointments — Patrick will confirm.`,
      ``,
      `At end-of-call ALWAYS invoke captureLead. classification = "new_lead" if B2B prospect, "wrong_number" if they wanted a trade service, "spam" for vendor pitches.`,
    ].filter(Boolean).join('\n');
  } else {
    // ── SERVICE-MODE system prompt (default, all client tenants) ──
    systemPrompt = [
      `You are the receptionist for ${businessName}. Your job is to handle inbound calls when the owner can't pick up.`,
      ``,
      `Brand voice (for tone only): ${brandVoice}`,
      `Sound like a friendly real person, not a robot. Never say "AI", "automated", or "bot".`,
      ``,
      `── CRITICAL: NEVER DISQUALIFY A CALLER ──`,
      `Your ONLY job is to capture the lead. You do NOT decide who is or isn't a fit.`,
      `The brand voice above is a TONE guide, not an audience filter. It may mention specific examples like "service businesses" or "plumbers" — those are tonal anchors, NOT a list of who we serve.`,
      `If a caller has any kind of business, residence, project, or need — capture their info. The OWNER decides afterward whether to call them back.`,
      `NEVER say "we focus on" or "we only work with" or "we don't serve" or "we may not be the right fit." Those phrases are forbidden.`,
      `If you genuinely don't know whether the owner handles the caller's need — capture the call anyway and tell them the owner will be in touch to discuss.`,
      ``,
      services ? `Services typically offered (informational only — never use to disqualify): ${services}` : '',
      serviceArea ? `Service area: ${serviceArea}` : '',
      hours ? `Business hours: ${hours}` : '',
      ``,
      `Your goal on every call:`,
      `1. Find out who's calling and what they need.`,
      `2. Get a callback number you can text back at.`,
      `3. Capture the nature of their need, address (if relevant), and urgency.`,
      `4. For emergencies (${emergencyKeywords.join(', ')}): get the address and phone fast, tell them the owner will be paged immediately, and end the call so they can take other steps.`,
      `5. For obvious wrong numbers, sales calls, or spam: politely end the call without capturing.`,
      ``,
      `Pricing: don't quote prices. Tell them the owner will reach out with specifics.`,
      `Scheduling: don't book firm appointments. Capture preferred callback window and let the owner confirm.`,
      `Recording: this call is NOT being recorded — only a text transcript is kept.`,
      ``,
      `At end-of-call ALWAYS invoke the captureLead function with the structured outcome — even if no lead was captured (use classification="spam" or "wrong_number").`,
    ].filter(Boolean).join('\n');
  }

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
 * Hand off a Twilio inbound call to Vapi using their Phone Call Provider
 * Bypass mode. We send the assistant config + customer details to
 * POST /call; Vapi returns TwiML in `phoneCallProviderDetails.twiml`
 * that we return verbatim to Twilio. Twilio then streams the call media
 * directly to Vapi via the WSS URL inside the returned TwiML.
 *
 * Requires:
 *  - VAPI_API_KEY               (private key, server-side)
 *  - VAPI_PHONE_NUMBER_ID       (Vapi-side ID of the imported Twilio number)
 *
 * Reference implementation: https://github.com/VapiAI/advanced-concepts-phone-call-provider-bypass
 *
 * @param {Object} tenant
 * @param {Object} callContext — { caller_phone, twilio_call_sid, twilio_call_token? }
 * @returns {Promise<string>} TwiML XML string to send back to Twilio
 */
async function createInboundCallTwiml(tenant, callContext = {}) {
  if (!isConfigured()) {
    throw new Error('VAPI_API_KEY not set — Voice Receptionist disabled');
  }
  if (!process.env.VAPI_PHONE_NUMBER_ID) {
    throw new Error('VAPI_PHONE_NUMBER_ID not set — Voice Receptionist cannot create inbound call');
  }

  const assistant = buildAssistantConfig(tenant, callContext);
  const payload = {
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
    phoneCallProviderBypassEnabled: true,
    customer: { number: callContext.caller_phone || '+10000000000' },
    assistant,
  };

  const res = await fetch(`${VAPI_BASE}/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errText = JSON.stringify(json).slice(0, 500);
    log.error(`Vapi /call create failed (${res.status}): ${errText}`);
    throw new Error(`Vapi /call failed: ${res.status}`);
  }

  const twiml = json?.phoneCallProviderDetails?.twiml;
  if (!twiml) {
    log.error(`Vapi /call returned no TwiML in phoneCallProviderDetails: ${JSON.stringify(json).slice(0, 400)}`);
    throw new Error('Vapi /call missing phoneCallProviderDetails.twiml');
  }
  return twiml;
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
  if (!headerValue) return false;
  // Timing-safe comparison to prevent side-channel attacks
  const crypto = require('crypto');
  const a = Buffer.from(String(headerValue));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  isConfigured,
  buildAssistantConfig,
  createInboundCallTwiml,
  verifyServerSecret,
  VOICE_OPTIONS,
};
