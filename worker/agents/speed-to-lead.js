/**
 * Growth OS — Speed-to-Lead Agent
 * Sends an immediate SMS to new leads within minutes of inquiry.
 *
 * Triggered by: lead creation (api/routes/leads.js enqueues job)
 * Requires: speed_to_lead module enabled, Twilio configured, lead has phone
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/telnyx');
const { checkIdempotency, recordIdempotency, enqueueJob } = require('../../db/queries/jobs');
const { claudeHaiku } = require('../../integrations/claude');
const { isInboundLead } = require('../../core/lead-sources');
const { stripAiTells, NO_DASH_PROMPT_RULE } = require('../../core/text-style');

// Sweeper window — look back this far for uncontacted leads
const SWEEPER_WINDOW_MINUTES = 60;
const SWEEPER_LIMIT = 20;

/**
 * Render SMS template with lead data
 */
function renderTemplate(template, lead, tenant) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  return template
    .replace(/{name}/g, lead.name || 'there')
    .replace(/{business_name}/g, businessName)
    .replace(/{service_type}/g, lead.service_type || 'your needs');
}

/**
 * AI-generated personalized speed-to-lead SMS. Uses Claude Haiku (fast,
 * cheap) to write a 1-2 sentence text-back that references the lead's
 * first name, the specific service they asked about, and the business's
 * voice. Falls back to the static template if Claude fails or returns
 * something obviously broken — speed-to-lead must never fail to send.
 *
 * Module 2 sales claim: "the system reads what they sent, generates a
 * personalized text-back in your voice within 60 seconds...references
 * their name, the specific service they asked about, the city or
 * service area they mentioned, and offers a clear next step."
 */
async function generatePersonalizedSms(tenant, lead, fallbackTemplate, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense. Sounds like a real person.');

  const systemPrompt = `You are writing a single SMS reply for ${businessName} to a new prospect who just submitted a lead. The voice and tone must match this brand voice: ${brandVoice}

Rules:
- Output ONLY the SMS body. No greeting prefix like "Hi there!" already implied — go straight to acknowledgment + next step.
- 25-50 words MAX. SMS, not email.
- Use the prospect's first name ONCE if you have it.
- Reference the specific service or question they asked about, briefly.
- End with a clear next step (offer to call, ask a clarifying question, or propose a time window).
- No emoji unless the brand voice says otherwise.
- No links unless absolutely needed.
- No "thanks for choosing us" corporate filler.
- Do NOT include a signature, sign-off, or business name (those land elsewhere).
- Do NOT use quotes around the message.

${NO_DASH_PROMPT_RULE}`;

  // Build a concise context blob from whatever the lead row has.
  const firstName = (lead.name || '').split(/\s+/)[0] || '';
  const context = [
    `From: ${firstName || '(no name)'}`,
    lead.service_type ? `Service requested: ${lead.service_type}` : null,
    lead.city ? `City: ${lead.city}` : null,
    lead.lead_source ? `Source: ${lead.lead_source}` : null,
    lead.notes ? `Note from lead: ${String(lead.notes).slice(0, 400)}` : null,
  ].filter(Boolean).join('\n');

  const userMessage = `New lead context:\n${context}\n\nWrite the SMS reply now. Output the SMS body only.`;

  try {
    const reply = await claudeHaiku(systemPrompt, userMessage, { maxTokens: 200, tenantSlug: tenant.slug });
    const cleaned = stripAiTells(String(reply || '').trim().replace(/^["']|["']$/g, ''));
    // Sanity check — if Claude returned nothing usable, fall back.
    if (!cleaned || cleaned.length < 10 || cleaned.length > 600) {
      log.warn(`Claude returned unusable speed-to-lead body (length=${cleaned.length}), using template`);
      return renderTemplate(fallbackTemplate, lead, tenant);
    }
    return cleaned;
  } catch (err) {
    // Claude unavailable / rate limited / network issue — template ships anyway.
    log.warn(`Claude personalization failed (${err.message}), using template fallback`);
    return renderTemplate(fallbackTemplate, lead, tenant);
  }
}

/**
 * Sweeper mode — find recent uncontacted leads and enqueue per-lead jobs.
 * Runs when the cron fires the agent without a lead_id payload.
 * Acts as a safety net for leads inserted via imports, webhooks, or any path
 * that bypasses POST /api/leads (which enqueues per-lead directly).
 */
async function sweep(tenant, log) {
  const since = new Date(Date.now() - SWEEPER_WINDOW_MINUTES * 60 * 1000).toISOString();

  // Only sweep INBOUND leads — prospected leads must go through the outreach
  // agent (which creates a draft for owner approval). Cold-texting prospected
  // leads without consent is spam.
  const { data: leads, error } = await db
    .from('leads')
    .select('id, name, phone, status, lead_source, created_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'new_lead')
    .not('phone', 'is', null)
    // Prospect-sourced leads are rejected again by the per-lead run this
    // sweeper enqueues (allow-list via isInboundLead); this query-level
    // exclusion just trims the obvious bulk.
    .not('lead_source', 'eq', 'prospecting_agent')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SWEEPER_LIMIT);

  if (error) throw error;

  if (!leads || leads.length === 0) {
    return { success: true, swept: true, enqueued: 0, candidates: 0 };
  }

  let enqueued = 0;
  let alreadyQueued = 0;
  for (const lead of leads) {
    // Skip leads we've already contacted (idempotency record exists)
    const idempKey = `speed-to-lead:${lead.id}`;
    const existing = await checkIdempotency(tenant.id, idempKey);
    if (existing) continue;

    // Skip leads that already have a pending/processing speed-to-lead job
    // to avoid duplicate enqueues from back-to-back cron ticks
    const { data: existingJobs } = await db
      .from('agent_jobs')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('agent_name', 'speed-to-lead')
      .in('status', ['pending', 'processing'])
      .contains('payload', { lead_id: lead.id })
      .limit(1);
    if (existingJobs && existingJobs.length > 0) {
      alreadyQueued++;
      continue;
    }

    await enqueueJob(tenant.id, 'speed-to-lead', { lead_id: lead.id }, { priority: 10 });
    enqueued++;
  }

  log.info('Sweeper result', { candidates: leads.length, enqueued, alreadyQueued });
  return { success: true, swept: true, enqueued, candidates: leads.length, alreadyQueued };
}

/**
 * Twilio is required for this agent. If the tenant doesn't have it
 * configured, there is nothing the agent can usefully do — skip quietly
 * instead of throwing `Twilio integration not configured for this tenant`
 * 500 times a day (one throw per lead in the sweeper loop). This is
 * the single biggest source of noise in the daily digest.
 */
function tenantHasTwilio(tenant) {
  const t = tenant?.integrations?.twilio;
  return !!(t && t.credentials?.account_sid && t.config?.phone_number);
}

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { lead_id } for single-lead mode, {} for sweeper mode
 */
async function run(tenant, payload = {}) {
  const log = createLogger('speed-to-lead', tenant.slug);

  // Pre-flight: if tenant has no Twilio configured, bail gracefully rather
  // than throwing on every lead (which is what produced 259 failures in one
  // sweep on 2026-04-21). The module-gate in the scheduler is SUPPOSED to
  // catch this, but tenants can have the 'speed_to_lead' module enabled
  // without having provisioned Twilio yet — this agent must not assume
  // they match.
  if (!tenantHasTwilio(tenant)) {
    log.info('No Twilio configured for this tenant — skipping');
    return { success: true, skipped: true, reason: 'no_twilio_integration' };
  }

  // Cron-triggered sweeper mode: find uncontacted leads and enqueue per-lead jobs
  if (!payload.lead_id) {
    return await sweep(tenant, log);
  }

  // Idempotency check — don't double-text the same lead
  const idempKey = `speed-to-lead:${payload.lead_id}`;
  const existing = await checkIdempotency(tenant.id, idempKey);
  if (existing) {
    log.info('Already contacted this lead', { lead_id: payload.lead_id });
    return { success: true, skipped: true, reason: 'already_contacted' };
  }

  // Fetch the lead
  const { data: lead, error: leadErr } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('id', payload.lead_id)
    .single();

  if (leadErr || !lead) {
    throw new Error(`Lead not found: ${payload.lead_id}`);
  }

  if (!lead.phone) {
    log.warn('Lead has no phone number, skipping', { lead_id: lead.id });
    return { success: true, skipped: true, reason: 'no_phone' };
  }

  // Never text prospect-sourced leads — they didn't contact us, so a
  // "thanks for reaching out!" message is fabricated warmth (and spam).
  // Allow-list semantics via core/lead-sources.js: only INBOUND leads get
  // the instant text-back. (Was a prospecting_agent-only deny-list, which
  // let manual/targeted-campaign prospects through — 2026-07-14 audit.)
  if (!isInboundLead(lead)) {
    log.warn('Prospect-sourced lead — skipping speed-to-lead (use outreach agent instead)', { lead_id: lead.id, lead_source: lead.lead_source });
    return { success: true, skipped: true, reason: 'prospected_lead' };
  }

  // Get SMS template (used as fallback if AI fails)
  const template = getConfig(tenant, 'sms_templates', {}).speed_to_lead
    || 'Hi {name}, thanks for reaching out to {business_name}! How can we help you?';

  // AI-powered personalization (Module 2 sales claim). Falls back to
  // the static template if Claude fails — speed-to-lead must never
  // fail to send because of a model hiccup. Tenants who explicitly
  // disable AI personalization in tenant_config get the template
  // directly.
  const useAi = getConfig(tenant, 'speed_to_lead_use_ai', true);
  const messageBody = useAi
    ? await generatePersonalizedSms(tenant, lead, template, log)
    : renderTemplate(template, lead, tenant);

  log.info('Sending speed-to-lead SMS', { lead: lead.name, phone: lead.phone.slice(-4), ai: useAi });

  // Send the SMS (with monthly volume cap enforcement)
  let smsResult;
  try {
    smsResult = await sendSms(tenant.integrations, lead.phone, messageBody, {
      tenantSlug: tenant.slug,
      tenant
    });
  } catch (err) {
    if (err instanceof SmsCapExceededError) {
      log.warn(`SMS cap reached (${err.count}/${err.cap}); deferring lead`, { lead_id: lead.id });
      return {
        success: true,
        skipped: true,
        reason: 'sms_cap_reached',
        cap: err.cap,
        count: err.count
      };
    }
    throw err;
  }

  // Log the outbound message — write to BOTH messages (legacy table)
  // and conversations (newer richer schema from migration 013). The
  // mobile app's Lead Detail screen reads conversations to render the
  // full timeline; without this write, speed-to-lead sends were
  // invisible in the per-lead conversation history. Module 1 sales
  // claim: "Full conversation history per lead in one place."
  await db.from('messages').insert({
    tenant_id: tenant.id,
    channel: 'sms',
    direction: 'outbound',
    body: messageBody,
    external_id: smsResult.sid,
    status: 'sent',
    sent_at: new Date().toISOString()
  });
  try {
    await db.from('conversations').insert({
      tenant_id: tenant.id,
      lead_id: lead.id,
      channel: 'sms',
      direction: 'outbound',
      message_body: messageBody,
      metadata: { external_id: smsResult.sid, agent: 'speed-to-lead' },
    });
  } catch (convErr) {
    // Non-fatal — messages table still has the record.
    log.warn(`conversations insert failed for speed-to-lead: ${convErr.message}`);
  }

  // Update lead status if still new
  if (lead.status === 'new_lead') {
    await db.from('leads')
      .update({ status: 'contacted', updated_at: new Date().toISOString() })
      .eq('id', lead.id)
      .eq('tenant_id', tenant.id);
  }

  // Record idempotency
  await recordIdempotency(tenant.id, idempKey, 'sms_sent', {
    message_sid: smsResult.sid,
    sent_at: new Date().toISOString()
  });

  log.success('Speed-to-lead SMS sent', { lead: lead.name });

  return {
    success: true,
    lead_id: lead.id,
    lead_name: lead.name,
    message_sid: smsResult.sid
  };
}

module.exports = run;
