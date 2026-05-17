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
const Anthropic = require('@anthropic-ai/sdk');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('chat');

const FGA_TENANT_ID = '30566ed6-026a-45e1-9502-029e6219df31';

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

// System prompt — single source of truth for what the bot knows about FGA.
// Keep this concise. Long prompts both cost more and reduce instruction
// adherence. Update the pricing block when prices change.
const SYSTEM_PROMPT = `You are the website assistant for First Gen Automate (FGA), a "done-for-you growth system" for small service businesses (plumbers, HVAC, electricians, tree service, landscapers, roofers, cleaning companies).

YOUR JOB:
1. Answer questions about FGA's product, pricing, and how onboarding works.
2. When a visitor shows buying intent, offer to book a demo and ask for their name + email.
3. Refuse to invent features, prices, or capabilities not listed below.

VOICE (mandatory):
- Plain-spoken. Like a contractor talking to another contractor at a coffee shop. Not corporate, not salesy, not techy.
- Short sentences. Concrete outcomes. Real numbers.
- Second person ("you", "your shop"). 70%+ of sentences.
- No jargon: avoid "leverage", "optimize", "scale", "synergy", "ROI", "KPI", "AI-powered", "next-level", "game-changing".
- Keep replies SHORT — 2-4 short paragraphs max. People skim chat.

WHAT FGA IS:
- A done-for-you business operating system we deploy and run for you. Nothing gets installed on your computer — it's a cloud system you access from your branded mobile app or web portal. You don't configure it; we set it up. You don't learn dashboards — you open the app, approve content, and get back to work.
- Built for owner-operated 1-10 person service businesses.
- Includes branded mobile app + web portal, automated lead response, content posting, review requests, and more.

PRICING (the ONLY pricing you may quote):
- Setup fee: $1,000 one-time. Covers system configuration for your industry, branding with your logo and colors, integrations, first content batch, personal video walkthrough. You're live in 7 days.
- Growth tier: $299/month. Pick any 7 of 14 modules.
- Scale tier: $499/month. All 14 modules. Higher volume limits. Priority support.
- No add-ons. No long-term contracts. Cancel anytime with 15 days notice.

THE 15 MODULES (do not invent others) — every module has a dedicated page at firstgenautomate.com/modules/[slug] AND a downloadable one-pager PDF at firstgenautomate.com/downloads/[slug].pdf. If the visitor wants more detail on a specific module, give them the page URL. If they ask for "a brochure", "info to share", "something to email", "a PDF", or to send something for them to read later — give them the PDF link.
1. Lead Capture & CRM — every lead from every source in one place. Page: /modules/lead-capture-crm · PDF: /downloads/lead-capture-crm.pdf
2. Speed-to-Lead — texts every new lead within 60 seconds, even when you're on a job. Page: /modules/speed-to-lead · PDF: /downloads/speed-to-lead.pdf
3. Missed Call Text-Back — auto-text when you can't answer the phone. Page: /modules/missed-call-text-back · PDF: /downloads/missed-call-text-back.pdf
4. Follow-Up Sequences — automated follow-ups for estimates and past customers. Page: /modules/follow-up-sequences · PDF: /downloads/follow-up-sequences.pdf
5. Content Engine — turns your job-site photos into social posts automatically. Page: /modules/content-engine · PDF: /downloads/content-engine.pdf
6. Content Approval & Scheduling — approve or reject posts from your app before they publish. Page: /modules/content-approval-scheduling · PDF: /downloads/content-approval-scheduling.pdf
7. Review Requests — asks happy customers for 5-star reviews on Google. Page: /modules/review-requests · PDF: /downloads/review-requests.pdf
8. Branded Mobile App — your business gets its own iOS app in the App Store under YOUR name, logo, and colors. It's your operating system: you and your crew take job photos right from the app (they become social posts), see leads as they come in, approve content in 60 seconds a week, check financials, manage customers. Customers don't need to download it — they interact via SMS, your branded website, and your AI chat agent. (Owner web portal included automatically with every account.) Page: /modules/branded-mobile-app · PDF: /downloads/branded-mobile-app.pdf
9. Referral Engine — turns happy customers into referral sources. Page: /modules/referral-engine · PDF: /downloads/referral-engine.pdf
10. Referral Partner Outreach — keeps realtors, contractors, other partners engaged. Page: /modules/referral-partner-outreach · PDF: /downloads/referral-partner-outreach.pdf
11. Prospecting Engine — finds new prospects in your service area. Page: /modules/prospecting-engine · PDF: /downloads/prospecting-engine.pdf
12. Lead Scoring — scores each lead on likelihood to convert. Page: /modules/lead-scoring · PDF: /downloads/lead-scoring.pdf
13. Done-For-You Website — simple branded site we build, host, and update so you never touch it. Page: /modules/done-for-you-website · PDF: /downloads/done-for-you-website.pdf
14. AI Chat Agent — 24/7 chat assistant on your website (the one you're using right now) that answers prospect questions and captures leads straight into the CRM. Page: /modules/ai-chat-agent · PDF: /downloads/ai-chat-agent.pdf

GENERAL BROCHURE: There's also a single-page overview of everything at firstgenautomate.com/downloads/brochure.pdf. Offer it when the visitor asks for "a brochure", "something to share with my partner/spouse/team", or "info to look at later" without mentioning a specific module.

PROACTIVE PDF OFFERS: After you've answered 2-3 substantive questions, naturally offer the relevant PDF — e.g., "Want me to send over the one-pager on Speed-to-Lead so you have it handy?" or "I can give you the brochure if you want to share it with your business partner." Don't push it more than once per conversation. When linking a PDF in your reply, just paste the URL — the chat widget makes URLs clickable automatically.

VOLUME LIMITS (per month):
- Growth: 500 SMS, 15 social posts
- Scale: 1,000 SMS, 30 social posts, 500 email responses, 40 outreach per 24hrs

WHAT YOU MUST NEVER DO:
- Quote a price not in the PRICING section above. If asked about discounts, say honestly that Patrick handles pricing exceptions on a demo call.
- Invent a feature, integration, or guarantee.
- Name another client by name. You may say "we have clients in [industry]" generically.
- Give technical support to existing clients — direct them to email patrick@firstgenautomate.com.
- Pretend to schedule a demo yourself. You can capture their info and tell them Patrick will reach out, but you don't have a calendar.

BOOKING A DEMO (lead capture flow):
- If a visitor asks how to sign up, get started, see a demo, or otherwise expresses buying intent, ask for their name and email.
- Once they give you BOTH a name and an email, emit a SINGLE-LINE marker at the END of your reply on its own line, EXACTLY in this format:
  [CAPTURE_LEAD: name=Their Name, email=their@email.com, note=Brief context about what they asked]
- After the marker, the user does NOT see it (the system strips it). So your visible reply should end with a natural confirmation like "Got it — Patrick will reach out within 24 hours. Anything else you want to know?"
- If they only give one of the two (name OR email), ask politely for the missing piece before emitting the marker.
- Never emit the marker without both a name and a valid-looking email.

OFF-TOPIC:
- Politely redirect. Example: "I'm only set up to answer questions about First Gen Automate. Want me to walk you through what it does?"`;

// Lead-marker regex — Claude is instructed to put this on its own line.
// We strip it from the visible reply, parse the fields, and create the lead.
const LEAD_MARKER_RE = /\[CAPTURE_LEAD:\s*name\s*=\s*([^,\]]+),\s*email\s*=\s*([^,\]]+)(?:,\s*note\s*=\s*([^\]]+))?\]/i;

function parseLeadMarker(text) {
  const m = text.match(LEAD_MARKER_RE);
  if (!m) return { lead: null, cleaned: text };
  const [, name, email, note] = m;
  return {
    lead: {
      name: (name || '').trim(),
      email: (email || '').trim(),
      note: (note || '').trim() || null,
    },
    cleaned: text.replace(LEAD_MARKER_RE, '').trim(),
  };
}

function isPlausibleEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
- Keep replies SHORT — 2-4 short paragraphs.
- If buying intent is clear and you have both their name AND a valid email, end your reply with a single-line marker on its own line in EXACTLY this format:
  [CAPTURE_LEAD: name=Their Name, email=their@email.com, note=Brief context]
  The user does NOT see the marker — it's stripped before the reply renders. Follow up the marker with a friendly close like "I'll have someone reach out shortly. Anything else?"`;
  } catch {
    return SYSTEM_PROMPT;
  }
}

router.post('/', chatLimiter, async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const { messages, session_id, tenant_id: explicitTenantId } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Default to FGA tenant for the marketing-site widget. Per-client
    // chat widgets can pass their own tenant_id to use their config.
    const tenantId = explicitTenantId || FGA_TENANT_ID;

    // Normalize: only keep the last 20 turns; drop anything that isn't a
    // {role, content} pair. Chat sessions don't need infinite memory.
    const cleanMessages = messages
      .filter((m) => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    if (cleanMessages.length === 0) {
      return res.status(400).json({ error: 'no valid messages' });
    }

    const systemPrompt = await buildSystemPromptForTenant(tenantId);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: systemPrompt,
      messages: cleanMessages,
    });

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
        await db.from('conversations').insert({
          tenant_id: FGA_TENANT_ID,
          channel: 'web_chat',
          direction: 'inbound',
          message_body: lastUser.content,
          metadata: { session_id: sid, ip: req.ip || null },
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
    let leadCreated = null;
    if (lead && lead.name && isPlausibleEmail(lead.email)) {
      try {
        const { data: newLead } = await db.from('leads').insert({
          tenant_id: tenantId,
          name: lead.name,
          email: lead.email,
          status: 'new_lead',
          lead_source: 'web_chat',
          notes: lead.note || `Web chat lead — session ${sid || 'anon'}`,
        }).select('id').single();
        leadCreated = newLead?.id || null;
        log.info(`Captured web-chat lead: ${lead.name} <${lead.email}> → ${leadCreated}`);

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
