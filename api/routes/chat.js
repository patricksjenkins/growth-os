/**
 * Growth OS — Marketing-Site Chat (v1, 2026-05-14)
 *
 * POST /api/chat — single-turn endpoint that takes a conversation history
 * and returns Claude's next reply. Designed for the floating chat widget
 * on firstgenautomate.com.
 *
 * This route is PUBLIC (mounted before authMiddleware) — anonymous
 * visitors on the marketing site can hit it without a token. Rate-limited
 * by the app-wide /api/ limiter and by a stricter per-IP limit below.
 *
 * Lead capture: the system prompt instructs Claude to emit a marker line
 * `[CAPTURE_LEAD: name=..., email=..., note=...]` when a visitor shares
 * contact info and demonstrates buying intent. The endpoint parses that
 * marker, strips it from the user-facing reply, and inserts a row in the
 * FGA tenant's `leads` table tagged lead_source='web_chat'. The existing
 * speed-to-lead cron sweeps these and fires SMS/email follow-up — no
 * separate plumbing needed.
 *
 * Persistence: every visitor session writes its messages to the
 * `conversations` table (channel='web_chat', tenant_id=FGA). Patrick can
 * read the conversations in Supabase later for prompt-tuning and to see
 * what real prospects ask.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { buildFgaKnowledgePrompt } = require('../../core/fga-knowledge');

// V1 hardening (2026-05-24): per-tenant chat widgets on customer DFY sites
// must pass a signed widget token that proves the tenant_id wasn't forged.
// Without this, an attacker can target any tenant by name — draining their
// chat_msg_count cap, polluting their conversation log, or injecting a
// fabricated lead via the CAPTURE_LEAD marker.
//
// Token format: HMAC-SHA256(tenant_id, origin). DFY website build embeds
// the token in the page when we generate the customer's branded site, so
// only widgets we issued can authenticate.
//
// The FGA marketing-site widget (firstgenautomate.com) is special — it
// uses the FGA_TENANT_ID with no token because it serves anonymous
// visitors. We accept that traffic only when the Origin header is the
// marketing site itself.
const CHAT_WIDGET_ALLOWED_ORIGINS = (process.env.CHAT_WIDGET_ALLOWED_ORIGINS
  || 'https://firstgenautomate.com,https://www.firstgenautomate.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// V1 hardening (2026-05-24): widget token helpers extracted to
// core/chat-widget-token.js so this verify path and the DFY-build mint
// path can never drift apart. Both call the same HMAC + secret.
const { verifyWidgetToken, getWidgetSecret } = require('../../core/chat-widget-token');

const log = createLogger('chat');

// V1 hardening (2026-05-24): centralized constant.
const { FGA_TENANT_ID } = require('../../core/config');

// Per-IP rate limit on top of the global /api/ limiter — tighter because
// each call costs Claude tokens. 20 messages per 5 min per IP is plenty
// for genuine prospects and cheap for us.
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Slow down — try again in a few minutes.' },
});

// System prompt — composed at boot from the shared FGA knowledge base
// (single source of truth for positioning, pricing, modules, FAQs,
// tier rules, and founder bio — see core/fga-knowledge.js) plus a
// chat-widget-specific wrapper covering voice rules, module URLs,
// the lead-capture marker, and proactive PDF offers.
//
// Adding a new FAQ or changing pricing? Edit core/fga-knowledge.js —
// the voice receptionist, SMS responder, and this chat bot will all
// pick it up automatically. The wrapper below should only change
// when the chat *channel itself* needs different behavior (e.g.
// changing the lead marker format or adding a new module URL).
const CHAT_WRAPPER = `=== ROLE ===
You are the website assistant on firstgenautomate.com. You answer prospect questions about FGA, capture leads when visitors show buying intent, and refuse to invent anything not in your knowledge base above.

=== VOICE (mandatory) ===
- Plain-spoken. Like a real person at a coffee shop. Not corporate, not salesy, not techy.
- Short sentences. Concrete outcomes. Real numbers.
- Second person ("you", "your business"). 70%+ of sentences.
- No jargon: avoid "leverage", "optimize", "scale", "synergy", "ROI", "KPI", "AI-powered", "next-level", "game-changing".
- Keep replies SHORT — 2-4 short paragraphs max. People skim chat.

=== WHO FGA IS FOR (CRITICAL — overrides any softer wording above) ===
- FGA works for ANY business with 10 or fewer people. Service businesses, retail, professional services, creative studios, fitness, food, e-commerce, real estate, consulting — whatever they do.
- Examples that come up often: plumbers, electricians, tree service, landscapers, HVAC, cleaning, roofers, art galleries, fitness studios, retail shops, accountants, consultants, photographers, salons, dental offices, law firms — but DO NOT treat the list as exhaustive.
- NEVER tell a visitor "we focus on X" or "we only serve Y" or "we may not be the right fit for your industry." Those phrases are FORBIDDEN.
- The only disqualifier is headcount: more than 10 people = not our target. Everything else gets captured as a lead and Patrick decides on the demo.
- If a visitor's industry isn't in the examples above, just say "yes, that works — let me ask a couple of questions" and capture the lead.

=== MODULE PAGE + PDF LINKS ===
Every module has a dedicated page and a one-pager PDF. When a visitor wants more detail on a specific module, give them the page URL. When they ask for "a brochure", "info to share", "something to email", "a PDF", or "something to read later" — give them the PDF link.

- Lead Capture & CRM — Page: /modules/lead-capture-crm · PDF: /downloads/lead-capture-crm.pdf
- Speed-to-Lead — Page: /modules/speed-to-lead · PDF: /downloads/speed-to-lead.pdf
- Missed Call Text-Back — Page: /modules/missed-call-text-back · PDF: /downloads/missed-call-text-back.pdf
- Follow-Up Sequences — Page: /modules/follow-up-sequences · PDF: /downloads/follow-up-sequences.pdf
- Content Engine — Page: /modules/content-engine · PDF: /downloads/content-engine.pdf
- Content Approval & Scheduling — Page: /modules/content-approval-scheduling · PDF: /downloads/content-approval-scheduling.pdf
- Review Requests — Page: /modules/review-requests · PDF: /downloads/review-requests.pdf
- Branded Mobile App — Page: /modules/branded-mobile-app · PDF: /downloads/branded-mobile-app.pdf
- AI Voice Receptionist (Scale only) — Page: /modules/ai-voice-receptionist · PDF: /downloads/ai-voice-receptionist.pdf
- Referral Engine — Page: /modules/referral-engine · PDF: /downloads/referral-engine.pdf
- Referral Partner Outreach — Page: /modules/referral-partner-outreach · PDF: /downloads/referral-partner-outreach.pdf
- Prospecting Engine — Page: /modules/prospecting-engine · PDF: /downloads/prospecting-engine.pdf
- Lead Scoring — Page: /modules/lead-scoring · PDF: /downloads/lead-scoring.pdf
- Done-For-You Website — Page: /modules/done-for-you-website · PDF: /downloads/done-for-you-website.pdf
- AI Chat Agent — Page: /modules/ai-chat-agent · PDF: /downloads/ai-chat-agent.pdf

GENERAL BROCHURE: There's also a single-page overview at firstgenautomate.com/downloads/brochure.pdf. Offer it when the visitor asks for "a brochure", "something to share with my partner/spouse/team", or "info to look at later" without mentioning a specific module.

PROACTIVE PDF OFFERS: After you've answered 2-3 substantive questions, naturally offer the relevant PDF — e.g., "Want me to send over the one-pager on Speed-to-Lead so you have it handy?" or "I can give you the brochure if you want to share it with your business partner." Don't push it more than once per conversation. When linking a PDF, just paste the URL — the widget makes URLs clickable automatically.

=== WHAT YOU MUST NEVER DO ===
- Quote a price not in the PRICING section of your knowledge base. If asked about discounts, say honestly that Patrick handles pricing exceptions on a demo call.
- Invent a feature, integration, or guarantee.
- Name another client by name. You may say "we have clients in [industry]" generically.
- Give technical support to existing clients — direct them to email patrick@firstgenautomate.com.
- Pretend to schedule a demo yourself. You can capture their info and tell them Patrick will reach out, but you don't have a calendar.
- Disqualify a visitor based on industry.

=== BOOKING A DEMO (lead capture flow) ===
- If a visitor asks how to sign up, get started, see a demo, or otherwise expresses buying intent, ask for their name and email.
- Once they give you BOTH a name and an email, emit a SINGLE-LINE marker at the END of your reply on its own line, EXACTLY in this format:
  [CAPTURE_LEAD: name=Their Name, email=their@email.com, note=Brief context about what they asked]
- After the marker, the user does NOT see it (the system strips it). So your visible reply should end with a natural confirmation like "Got it — Patrick will reach out within 24 hours. Anything else you want to know?"
- If they only give one of the two (name OR email), ask politely for the missing piece before emitting the marker.
- Never emit the marker without both a name and a valid-looking email.

=== OFF-TOPIC ===
- Politely redirect. Example: "I'm only set up to answer questions about First Gen Automate. Want me to walk you through what it does?"`;

// Composed once at module load. Knowledge module is statically required,
// so this is safe — no async, no DB hit, no surprise per-request cost.
const SYSTEM_PROMPT = `${buildFgaKnowledgePrompt()}\n\n${CHAT_WRAPPER}`;

// Lead-marker regex — Claude is instructed to put this on its own line.
// We strip it from the visible reply, parse the fields, and create the lead.
// Fields are extracted individually so order is flexible and phone/email/note
// are each optional (the capture guard requires name + a phone OR email).
const LEAD_MARKER_RE = /\[CAPTURE_LEAD:\s*([^\]]+)\]/i;

function markerField(block, key) {
  const m = block.match(new RegExp(key + '\\s*=\\s*([^,\\]]+)', 'i'));
  return m ? m[1].trim() : '';
}

function parseLeadMarker(text) {
  const m = text.match(LEAD_MARKER_RE);
  if (!m) return { lead: null, cleaned: text };
  const block = m[1];
  return {
    lead: {
      name: markerField(block, 'name'),
      phone: markerField(block, 'phone'),
      email: markerField(block, 'email'),
      note: markerField(block, 'note') || null,
    },
    cleaned: text.replace(LEAD_MARKER_RE, '').trim(),
  };
}

function isPlausibleEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function digitsOnly(s) {
  return (String(s || '').match(/\d/g) || []).join('');
}

function isPlausiblePhone(p) {
  return digitsOnly(p).length >= 7;
}

/**
 * Build the system prompt for a specific tenant. When the tenant has the
 * chat_agent module enabled with module_chat_agent_config saved (from the
 * onboarding intake), this returns a per-tenant prompt that knows THEIR
 * pricing, FAQs, services-not-offered, etc. — not FGA's defaults.
 *
 * When called without a tenant_id (default: the FGA marketing widget),
 * returns the FGA prompt unchanged.
 */
async function buildSystemPromptForTenant(tenantId) {
  if (!tenantId || tenantId === FGA_TENANT_ID) return SYSTEM_PROMPT;
  try {
    const { data: rows } = await db
      .from('tenant_config')
      .select('key, value')
      .eq('tenant_id', tenantId)
      .in('key', ['business_name', 'industry', 'service_area', 'business_hours', 'brand_voice', 'module_chat_agent_config']);
    if (!rows || rows.length === 0) return SYSTEM_PROMPT;
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let agentCfg = {};
    try {
      agentCfg = cfg.module_chat_agent_config ? JSON.parse(cfg.module_chat_agent_config) : {};
    } catch {
      agentCfg = {};
    }
    return `You are the website assistant for ${cfg.business_name || 'this small service business'}.

VOICE: ${cfg.brand_voice || 'Direct, warm, plain-spoken. Like a contractor talking to another contractor.'}

INDUSTRY: ${cfg.industry || 'service business'}
SERVICE AREA: ${cfg.service_area || 'local area'}
HOURS: ${cfg.business_hours || 'Business hours not specified — say "I can confirm hours with the owner"'}

PRICING (the ONLY pricing you may quote):
${agentCfg.chat_pricing_structure || 'No pricing has been configured — say "I\'ll have the owner reach out with a quote."'}

AFTER-HOURS / EMERGENCY POLICY:
${agentCfg.chat_after_hours_policy || 'Not specified — say "I\'ll check with the owner on after-hours availability."'}

WHAT WE DO NOT DO (refuse if asked):
${agentCfg.chat_services_not_offered || 'Not specified — when in doubt, say "I\'m not sure — let me have the owner confirm."'}

HOW TO BOOK:
${agentCfg.chat_booking_process || 'Not specified — point them to phone/email above.'}

COMMON Q&A (use these answers verbatim when they match):
${agentCfg.chat_common_faqs || 'No FAQs configured.'}

HARD RULES:
- Do NOT invent prices, features, hours, or service areas. If unsure, say so and offer to take their info.
- Do NOT name other clients or vendors.
- Keep replies SHORT — 1-2 sentences. Do NOT interrogate with many questions; if they ask something, answer in one short sentence then move to collecting their contact info.
- LEAD CAPTURE: Once you know what they need AND have their name plus a phone number (email is fine too), end your reply with a single-line marker on its own line, EXACTLY in this format:
  [CAPTURE_LEAD: name=Their Name, phone=their phone, email=their email if given, note=what they need + their address]
  Include whatever they actually gave — a phone OR an email is enough; put the service they want and their address in note. Only include a phone/email the visitor actually typed. The user does NOT see the marker — it's stripped before the reply renders. After it, close with a short line like "Got it — someone from the office will reach out shortly."`;
  } catch {
    return SYSTEM_PROMPT;
  }
}

router.post('/', chatLimiter, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const { messages, session_id, tenant_id: explicitTenantId, widget_token } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // V1 hardening (2026-05-24): determine + verify the tenant_id.
    //
    //   1. No tenant_id in body → marketing-site widget path.
    //      Require Origin header to match firstgenautomate.com.
    //      Tenant becomes FGA_TENANT_ID.
    //
    //   2. tenant_id === FGA_TENANT_ID → same as (1). Forbid this from
    //      arbitrary origins to keep customer DFY sites from spoofing
    //      the marketing widget and draining FGA's own cap.
    //
    //   3. Any other tenant_id → require widget_token that HMAC-verifies
    //      against the tenant_id. Customer DFY website builds embed the
    //      token at render time. No token = 403, regardless of who's calling.
    let tenantId;
    if (!explicitTenantId || explicitTenantId === FGA_TENANT_ID) {
      const origin = String(req.headers.origin || req.headers.referer || '');
      const okOrigin = CHAT_WIDGET_ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed));
      if (!okOrigin) {
        return res.status(403).json({ error: 'origin_not_allowed' });
      }
      tenantId = FGA_TENANT_ID;
    } else {
      if (!verifyWidgetToken(widget_token, explicitTenantId)) {
        return res.status(403).json({ error: 'invalid_widget_token' });
      }
      tenantId = explicitTenantId;
    }

    // Normalize: only keep the last 20 turns; drop anything that isn't a
    // {role, content} pair. Chat sessions don't need infinite memory.
    const cleanMessages = messages
      .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    if (cleanMessages.length === 0) {
      return res.status(400).json({ error: 'no valid messages' });
    }

    // Per-tenant monthly chat cap — defense against targeted abuse of a
    // single tenant's widget. The existing per-IP rate limiter is local;
    // this is the per-tenant ceiling that protects from distributed abuse.
    const { db: dbClient } = require('../../db/client');
    const { checkUsageOrThrow, incrementUsage, UsageCapExceededError } = require('../../core/usage-caps');
    let tenantForCap = null;
    try {
      const { data: tenantRow } = await dbClient
        .from('tenants')
        .select('id, status, subscription_tier, tier')
        .eq('id', tenantId)
        .maybeSingle();
      tenantForCap = tenantRow;
      if (tenantForCap) {
        await checkUsageOrThrow(tenantForCap, 'chat_msg_count', 1);
      }
    } catch (capErr) {
      if (capErr instanceof UsageCapExceededError) {
        return res.status(429).json({
          reply: "I've handled a lot of conversations this month and need to take a breather. Please email us at info@firstgenautomate.com and we'll respond personally.",
          session_id: session_id || `s_${Date.now()}`,
        });
      }
      // Non-cap error — let the existing error path handle it
      console.warn('chat cap check failed:', capErr.message);
    }

    const systemPrompt = await buildSystemPromptForTenant(tenantId);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: cleanMessages,
    });

    // Increment chat counter (fire-and-forget)
    if (tenantForCap) {
      incrementUsage(tenantId, 'chat_msg_count', 1).catch(() => {});
    }

    const rawReply = (response.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const { lead, cleaned } = parseLeadMarker(rawReply);

    // Persist the conversation turn to Supabase for review later.
    // Each user message and each assistant reply gets its own row, tied
    // together by session_id stored in metadata.
    const sid = String(session_id || '').slice(0, 64) || null;
    const lastUser = cleanMessages[cleanMessages.length - 1];
    try {
      if (lastUser?.role === 'user') {
        // V1 hardening (2026-05-24): hash the IP before persisting. Raw
        // IPs are PII in EU/CA — a salted hash still groups same-visitor
        // turns for analysis but isn't a direct identifier.
        const ipHash = req.ip
          ? crypto.createHmac('sha256', getWidgetSecret()).update(req.ip).digest('hex').slice(0, 16)
          : null;
        await db.from('conversations').insert({
          tenant_id: tenantId,
          channel: 'web_chat',
          direction: 'inbound',
          message_body: lastUser.content,
          metadata: { session_id: sid, ip_hash: ipHash },
        });
      }
      await db.from('conversations').insert({
        tenant_id: tenantId,
        channel: 'web_chat',
        direction: 'outbound',
        message_body: cleaned,
        metadata: { session_id: sid, lead_captured: !!lead },
      });
    } catch (persistErr) {
      log.warn(`Chat persistence failed (non-fatal): ${persistErr.message}`);
    }

    // If Claude emitted a valid CAPTURE_LEAD marker, create the lead.
    //
    // V1 hardening (2026-05-24): prompt-injection guard. The marker is
    // generated by Claude based on the visitor's messages. A motivated
    // attacker can craft a prompt that tricks Claude into emitting the
    // marker with a third party's email (spam them, mass-text a
    // competitor's customers, etc.). Mitigate by requiring the captured
    // email to literally appear in one of the visitor's own messages —
    // i.e. the visitor must have typed it themselves at some point in
    // this session.
    let leadCreated = null;
    const userMessageCorpus = cleanMessages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n')
      .toLowerCase();
    // Anti-fabrication: the contact value must actually appear in what the
    // visitor typed. Accept an email OR a phone (intake bots collect phone).
    const emailOK = lead?.email && isPlausibleEmail(lead.email) && userMessageCorpus.includes(lead.email.toLowerCase());
    const phoneOK = lead?.phone && isPlausiblePhone(lead.phone) && digitsOnly(userMessageCorpus).includes(digitsOnly(lead.phone));

    if (lead && lead.name && (emailOK || phoneOK)) {
      try {
        const { data: newLead } = await db.from('leads').insert({
          tenant_id: tenantId,
          name: lead.name,
          email: emailOK ? lead.email : null,
          phone: phoneOK ? lead.phone : null,
          status: 'new_lead',
          lead_source: 'web_chat',
          notes: lead.note || `Web chat lead — session ${sid || 'anon'}`,
        }).select('id').single();
        leadCreated = newLead?.id || null;
        log.info(`Captured web-chat lead: ${lead.name} (${emailOK ? lead.email : ''}${phoneOK ? ' ' + lead.phone : ''}) → ${leadCreated}`);

        // Trigger the full downstream agent pipeline on the freshly
        // captured lead — same as a website form submission via
        // /api/leads/capture. Module 15 sales copy: "Triggers
        // Speed-to-Lead / Follow-Up / Lead Scoring on capture." Each
        // agent checks its own module flag at run time and no-ops if
        // disabled, so we can enqueue all of them safely.
        if (leadCreated) {
          try {
            await db.from('agent_jobs').insert([
              { tenant_id: tenantId, agent_name: 'speed-to-lead', payload: { lead_id: leadCreated }, status: 'pending', priority: 10 },
              { tenant_id: tenantId, agent_name: 'enrichment',    payload: { lead_id: leadCreated }, status: 'pending', priority: 7  },
              { tenant_id: tenantId, agent_name: 'scoring',       payload: { lead_id: leadCreated }, status: 'pending', priority: 5  },
              { tenant_id: tenantId, agent_name: 'follow-up',     payload: { lead_id: leadCreated }, status: 'pending', priority: 5  },
            ]);
            log.info(`Enqueued downstream agents for chat lead ${leadCreated}`);
          } catch (e) {
            log.warn(`Could not enqueue downstream agents for chat lead: ${e.message}`);
          }
        }
      } catch (leadErr) {
        log.warn(`Lead insert failed: ${leadErr.message}`);
      }
    }

    res.json({
      reply: cleaned,
      session_id: sid,
      lead_captured: !!leadCreated,
    });
  } catch (err) {
    log.error(`Chat error: ${err.message}`);
    res.status(500).json({ error: 'Sorry — something went wrong. Try again in a moment.' });
  }
});

module.exports = router;
