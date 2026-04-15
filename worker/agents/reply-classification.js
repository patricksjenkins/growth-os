/**
 * Growth OS — Reply Classification Agent (Tenant-Aware)
 * Ported from WellMor reply-classification-agent.js
 *
 * Scans unclassified inbound replies, classifies via AI,
 * and routes to appropriate actions (interested, not now, unsubscribe, etc.)
 */

const axios = require('axios');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

const OPENAI_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'gpt-4.1-mini';

function stripCodeFences(text) {
  if (!text) return text;
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}

/**
 * Classify a reply using GPT
 */
async function classifyReply(replyText, businessName) {
  const systemPrompt = `Classify this email reply from a prospect of ${businessName} into exactly one category:
- interested: wants to learn more, agrees to meet, says call me
- positive_objection: has a provider, recently renewed, not the right time but open later
- firm_no: definitively not interested, please stop
- unsubscribe: explicitly asks to be removed
- out_of_office: automatic OOO reply
- wrong_person: not the right person
- needs_more_info: asks a question before deciding

Return JSON: {classification, confidence (0-1), key_phrases (array), return_date (if OOO, ISO date or null), forwarding_contact (if wrong_person, name/email or null), notes}`;

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Classify this reply:\n\n${replyText}` }
      ]
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(stripCodeFences(raw));
}

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('reply-classify', tenant.slug);

  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const limit = Number(payload.limit || 20);

  // Fetch unclassified inbound conversations
  const { data: replies, error: fetchErr } = await db
    .from('conversations')
    .select('id, lead_id, contact_id, message_body, channel, created_at')
    .eq('tenant_id', tenant.id)
    .eq('direction', 'inbound')
    .is('ai_classification', null)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (fetchErr) throw fetchErr;

  if (!replies || !replies.length) {
    log.info('No unclassified replies');
    return { success: true, classified: 0, message: 'No unclassified replies' };
  }

  let classified = 0;
  const processed = [];
  const errors = [];

  for (const reply of replies) {
    try {
      if (!reply.message_body) continue;

      const result = await classifyReply(reply.message_body, businessName);
      const classification = result.classification || 'unknown';

      // Update conversation with classification
      await db
        .from('conversations')
        .update({
          ai_classification: classification,
          sentiment: result.confidence >= 0.7 ? classification : 'uncertain',
          metadata: { classification_result: result }
        })
        .eq('id', reply.id);

      // Route based on classification
      if (classification === 'interested') {
        await db.from('leads').update({ status: 'contacted', lifecycle_stage: 'interested' }).eq('id', reply.lead_id);
        log.info(`INTERESTED: Lead ${reply.lead_id}`);
      } else if (classification === 'positive_objection') {
        await db.from('leads').update({ lifecycle_stage: 'nurture' }).eq('id', reply.lead_id);
      } else if (classification === 'firm_no' || classification === 'unsubscribe') {
        await db.from('leads').update({ status: 'lost', lifecycle_stage: 'disqualified' }).eq('id', reply.lead_id);
        if (classification === 'unsubscribe' && reply.contact_id) {
          await db.from('contacts').update({ contact_status: 'unsubscribed' }).eq('id', reply.contact_id);
        }
      } else if (classification === 'out_of_office') {
        // Leave as-is, will retry later
      } else if (classification === 'needs_more_info') {
        await db.from('leads').update({ lifecycle_stage: 'engaged' }).eq('id', reply.lead_id);
      }

      // Log activity
      await db.from('activity_log').insert({
        tenant_id: tenant.id,
        agent: 'reply-classification',
        action: `reply_classified_${classification}`,
        entity_type: 'conversation',
        entity_id: reply.id,
        metadata: { classification, confidence: result.confidence, lead_id: reply.lead_id }
      });

      classified++;
      processed.push({ reply_id: reply.id, lead_id: reply.lead_id, classification, confidence: result.confidence });
    } catch (err) {
      log.error(`Classification failed for reply ${reply.id}`, err);
      errors.push({ reply_id: reply.id, error: err.message });
    }
  }

  log.success(`Classified ${classified} replies`);
  return { success: true, classified, processed, errors };
}

module.exports = run;
