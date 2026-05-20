/**
 * Growth OS — Conversation Responder Agent
 *
 * Keeps multi-turn SMS conversations going on the lead side. Triggered by
 * an inbound SMS from a known lead/contact, reads the conversation
 * history, generates the next reply via Claude in the tenant's brand
 * voice, and sends via Twilio.
 *
 * This is what backs the Module 2 / Module 3 marketing claim that the
 * system "keeps the conversation moving" — not just a single text-back.
 *
 * Hard guardrails:
 *  - never auto-reply if the contact is unsubscribed / opted_out / bounced
 *  - never auto-reply if the lead is won/lost (closed deals get human follow-up only)
 *  - never auto-reply if the latest reply-classification was firm_no/unsubscribe
 *    (the classifier will have already flipped the lead to lost; this is belt+braces)
 *  - cap AI-handled turns per lead at MAX_AI_TURNS — beyond that we escalate
 *    to the owner via a high-priority notification and stop replying so we
 *    don't loop forever on a confused prospect
 *  - respects the tenant's monthly SMS volume cap (Twilio integration enforces)
 *
 * Idempotent: keyed on the inbound message_sid so the same job can be
 * safely retried.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendSms, SmsCapExceededError } = require('../../integrations/twilio');
const { checkIdempotency, recordIdempotency } = require('../../db/queries/jobs');
const { claudeHaiku } = require('../../integrations/claude');

// How many round-trip AI turns we'll handle on a single lead before
// escalating to the owner. Past this we'd rather wake the owner than
// have an LLM ramble at a confused prospect.
const MAX_AI_TURNS = 6;
const HISTORY_LIMIT = 10;

function looksBlocked(contactStatus) {
  return ['unsubscribed', 'opted_out', 'do_not_contact', 'bounced'].includes(contactStatus || '');
}

async function generateReply(tenant, lead, history, inbound, log) {
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Team');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Friendly, professional, no-nonsense. Sounds like a real person.');
  const services = getConfig(tenant, 'services', '');

  // Render the last N turns oldest-first for Claude.
  const transcript = history
    .slice()
    .reverse()
    .map((m) => `${m.direction === 'outbound' ? 'You' : 'Customer'}: ${m.message_body}`)
    .join('\n');

  const systemPrompt = `You are continuing an SMS conversation with a prospect of ${businessName}. The voice and tone must match this brand voice: ${brandVoice}

Rules:
- Output ONLY the SMS body. No greeting prefix, no signature.
- Single SMS, under 320 characters. Plain text only.
- Move the conversation toward booking or quoting.
- If they asked a question, answer it directly using the services context.
- If they gave times/availability, propose a specific next step (call, estimate, visit).
- If they sound hesitant, acknowledge and offer one concrete next step.
- Never make pricing promises or guarantees unless the prior messages already did.
- Never say "AI" or "automated" or "bot" — speak as a real teammate.
${services ? `\nServices offered: ${services}` : ''}`;

  const userPrompt = `Conversation so far:
${transcript}
Customer: ${inbound}

Write the next reply.`;

  try {
    const text = await claudeHaiku(systemPrompt, userPrompt, {
      maxTokens: 200,
      tenantSlug: tenant.slug,
    });
    const cleaned = String(text || '').trim().replace(/^["']|["']$/g, '');
    // Sanity-check: not empty, not absurdly long (Claude sometimes ignores limits).
    if (!cleaned || cleaned.length < 5 || cleaned.length > 480) {
      log.warn(`Reply generation returned unusable text (len=${cleaned.length}); falling back to escalation`);
      return null;
    }
    return cleaned;
  } catch (err) {
    log.warn(`Claude failed for reply generation: ${err.message}`);
    return null;
  }
}

async function escalateToOwner(tenant, lead, contactId, reason, inbound, log) {
  try {
    await db.from('notifications').insert({
      tenant_id: tenant.id,
      category: 'conversation_escalation',
      priority: 'high',
      title: `Conversation needs you — ${lead?.name || 'unknown lead'}`,
      message: `Reason: ${reason}. Latest: "${String(inbound || '').slice(0, 240)}"`,
      metadata: {
        lead_id: lead?.id || null,
        contact_id: contactId || null,
        reason,
      },
      status: 'pending',
    });
    log.warn(`Escalated to owner: ${reason} (lead ${lead?.id})`);
  } catch (err) {
    log.warn(`Could not insert escalation notification: ${err.message}`);
  }
}

/**
 * @param {Object} tenant
 * @param {Object} payload — { lead_id?, contact_id?, inbound_body, message_sid, from }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('convo-responder', tenant.slug);

  const { lead_id, contact_id, inbound_body, message_sid, from } = payload;
  if (!inbound_body) {
    log.info('No inbound_body in payload — nothing to respond to');
    return { success: true, skipped: true, reason: 'no_inbound_body' };
  }

  // Idempotency keyed on the inbound message_sid — if Twilio retries the
  // webhook, we don't fire two outbound replies.
  if (message_sid) {
    const seen = await checkIdempotency(tenant.id, `convo-reply:${message_sid}`);
    if (seen) {
      log.info(`Already responded to inbound ${message_sid} — skipping`);
      return { success: true, skipped: true, reason: 'idempotent' };
    }
  }

  // Resolve the lead. The webhook may give us only a contact_id (B2B
  // outreach path) — pull the lead through contacts.lead_id in that case.
  let lead = null;
  if (lead_id) {
    const { data } = await db
      .from('leads')
      .select('id, name, phone, status, lifecycle_stage')
      .eq('tenant_id', tenant.id)
      .eq('id', lead_id)
      .maybeSingle();
    lead = data;
  }
  if (!lead && contact_id) {
    const { data: contact } = await db
      .from('contacts')
      .select('id, lead_id, phone, contact_status')
      .eq('tenant_id', tenant.id)
      .eq('id', contact_id)
      .maybeSingle();
    if (contact?.lead_id) {
      const { data } = await db
        .from('leads')
        .select('id, name, phone, status, lifecycle_stage')
        .eq('tenant_id', tenant.id)
        .eq('id', contact.lead_id)
        .maybeSingle();
      lead = data;
    }
  }

  if (!lead) {
    log.info(`Inbound from ${from} not tied to a known lead — leaving to reply-classification`);
    return { success: true, skipped: true, reason: 'no_lead' };
  }

  // Guardrail: closed deals get human follow-up only.
  if (lead.status === 'won' || lead.status === 'lost') {
    log.info(`Lead ${lead.id} is ${lead.status} — not auto-responding`);
    return { success: true, skipped: true, reason: `lead_${lead.status}` };
  }

  // Guardrail: opted-out contacts get nothing.
  if (contact_id) {
    const { data: contact } = await db
      .from('contacts')
      .select('contact_status')
      .eq('tenant_id', tenant.id)
      .eq('id', contact_id)
      .maybeSingle();
    if (looksBlocked(contact?.contact_status)) {
      log.info(`Contact ${contact_id} status=${contact.contact_status} — not auto-responding`);
      return { success: true, skipped: true, reason: 'contact_blocked' };
    }
  }

  // Pull recent conversation history. Used both for context and for
  // turn-count guardrails.
  const { data: history } = await db
    .from('conversations')
    .select('id, direction, message_body, created_at, metadata, ai_classification')
    .eq('tenant_id', tenant.id)
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);

  const recentClassification = (history || []).find((h) => h.direction === 'inbound' && h.ai_classification);
  if (recentClassification && ['firm_no', 'unsubscribe'].includes(recentClassification.ai_classification)) {
    log.info(`Lead ${lead.id} most recent classification was ${recentClassification.ai_classification} — not auto-responding`);
    return { success: true, skipped: true, reason: `prior_${recentClassification.ai_classification}` };
  }

  // Turn-count guardrail: count outbound messages whose metadata.agent is
  // either speed-to-lead, missed-call, follow-up, or conversation-responder.
  // Once we've sent MAX_AI_TURNS auto-replies on this lead, escalate.
  const autoSentCount = (history || []).filter((m) => {
    if (m.direction !== 'outbound') return false;
    const agent = m?.metadata?.agent || '';
    return ['speed-to-lead', 'missed-call', 'follow-up', 'conversation-responder'].includes(agent);
  }).length;
  if (autoSentCount >= MAX_AI_TURNS) {
    await escalateToOwner(tenant, lead, contact_id, 'max_ai_turns_reached', inbound_body, log);
    return { success: true, skipped: true, reason: 'max_ai_turns' };
  }

  // We need a phone number to reply to. Prefer the lead's phone (canonical)
  // and fall back to the `from` value from the inbound webhook.
  const to = lead.phone || from;
  if (!to) {
    log.warn(`Lead ${lead.id} has no phone and no inbound from-number — cannot reply`);
    return { success: true, skipped: true, reason: 'no_destination' };
  }

  const replyText = await generateReply(tenant, lead, history || [], inbound_body, log);
  if (!replyText) {
    await escalateToOwner(tenant, lead, contact_id, 'reply_generation_failed', inbound_body, log);
    return { success: true, skipped: true, reason: 'no_generated_reply' };
  }

  let smsResult;
  try {
    smsResult = await sendSms(tenant.integrations, to, replyText, {
      tenantSlug: tenant.slug,
      tenant,
    });
  } catch (err) {
    if (err instanceof SmsCapExceededError) {
      log.warn(`SMS cap reached (${err.count}/${err.cap}); deferring reply`);
      await escalateToOwner(tenant, lead, contact_id, 'sms_cap_reached', inbound_body, log);
      return { success: true, skipped: true, reason: 'sms_cap_reached' };
    }
    throw err;
  }

  // Log outbound to both messages (legacy) and conversations.
  await db.from('messages').insert({
    tenant_id: tenant.id,
    contact_id: contact_id || null,
    channel: 'sms',
    direction: 'outbound',
    body: replyText,
    external_id: smsResult.sid,
    status: 'sent',
    sent_at: new Date().toISOString(),
  });
  try {
    await db.from('conversations').insert({
      tenant_id: tenant.id,
      lead_id: lead.id,
      contact_id: contact_id || null,
      channel: 'sms',
      direction: 'outbound',
      message_body: replyText,
      metadata: {
        external_id: smsResult.sid,
        agent: 'conversation-responder',
        in_reply_to_sid: message_sid || null,
      },
    });
  } catch (convErr) {
    log.warn(`conversations insert failed for convo-responder: ${convErr.message}`);
  }

  // Lifecycle nudge — an active back-and-forth means the lead is engaged.
  if (lead.status === 'new_lead' || lead.status === 'contacted') {
    await db.from('leads')
      .update({ lifecycle_stage: 'engaged', updated_at: new Date().toISOString() })
      .eq('id', lead.id)
      .eq('tenant_id', tenant.id);
  }

  if (message_sid) {
    await recordIdempotency(tenant.id, `convo-reply:${message_sid}`, 'replied', {
      reply_sid: smsResult.sid,
      sent_at: new Date().toISOString(),
    });
  }

  log.success(`Conversation reply sent to lead ${lead.id} (turn ${autoSentCount + 1}/${MAX_AI_TURNS})`);
  return {
    success: true,
    lead_id: lead.id,
    reply_sid: smsResult.sid,
    turn: autoSentCount + 1,
  };
}

module.exports = run;
