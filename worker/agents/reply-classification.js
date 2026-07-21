/**
 * Growth OS — Reply Classification Agent (Tenant-Aware)
 * Ported from WellMor reply-classification-agent.js
 *
 * Scans unclassified inbound replies, classifies via Claude,
 * and routes to appropriate actions (interested, not now, unsubscribe, etc.)
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

/**
 * Classify a reply using Claude
 */
async function classifyReply(replyText, businessName, tenantSlug) {
  const systemPrompt = `Classify this email reply from a prospect of ${businessName} into exactly one category:
- interested: wants to learn more, agrees to meet, says call me
- positive_objection: has a provider, recently renewed, not the right time but open later
- firm_no: definitively not interested, please stop
- unsubscribe: explicitly asks to be removed
- out_of_office: automatic OOO reply
- wrong_person: not the right person
- needs_more_info: asks a question before deciding

Return JSON: {classification, confidence (0-1), key_phrases (array), return_date (if OOO, ISO date or null), forwarding_contact (if wrong_person, name/email or null), notes}

Respond with valid JSON only. No markdown.`;

  return await askClaudeJSON(systemPrompt, `Classify this reply:\n\n${replyText}`, {
    maxTokens: 800,
    tenantSlug
  });
}

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('reply-classify', tenant.slug);

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');

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

      const result = await classifyReply(reply.message_body, businessName, tenant.slug);
      const classification = result.classification || 'unknown';

      // Update conversation with classification (tenant-scoped)
      await db
        .from('conversations')
        .update({
          ai_classification: classification,
          sentiment: result.confidence >= 0.7 ? classification : 'uncertain',
          metadata: { classification_result: result }
        })
        .eq('id', reply.id)
        .eq('tenant_id', tenant.id);

      // Module 7.4 / 7.5 — Review-request sentiment routing.
      // If the most recent outbound message to this lead was a review
      // request AND the inbound reply reads negative (firm_no,
      // unsubscribe, or contains complaint language detected by the
      // classifier), notify the owner privately BEFORE the customer
      // walks over to Google and leaves a 1-star. Module 7 sales claim:
      // "anything that reads negative gets routed to you privately first."
      try {
        const { data: lastOutbound } = await db
          .from('conversations')
          .select('id, metadata, created_at')
          .eq('tenant_id', tenant.id)
          .eq('lead_id', reply.lead_id)
          .eq('direction', 'outbound')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const wasReviewRequest = !!(lastOutbound && lastOutbound.metadata && lastOutbound.metadata.review_request_sent);
        const negativeSignal = ['firm_no', 'unsubscribe'].includes(classification)
          || (result.confidence >= 0.6 && /complain|terrible|awful|never|refund|1-?star|disappoint|frustrat/i.test(reply.message_body || ''));

        if (wasReviewRequest && negativeSignal) {
          // Insert a high-priority notification for the owner. notifications
          // table is processed by worker/agents/notifications.js which
          // dispatches push + email + webhook.
          await db.from('notifications').insert({
            tenant_id: tenant.id,
            category: 'review_negative_sentiment',
            priority: 'high',
            title: 'Negative review-request reply — intervene before they leave a public review',
            message: `${reply.lead_id ? `Lead ${reply.lead_id}` : 'A customer'} replied negatively to a review request. Reach out personally before they post a 1-star: "${String(reply.message_body || '').slice(0, 240)}"`,
            metadata: {
              lead_id: reply.lead_id,
              conversation_id: reply.id,
              classification,
              confidence: result.confidence,
            },
            status: 'pending',
          });
          log.warn(`Negative review-request reply detected — owner notified for lead ${reply.lead_id}`);
        }
      } catch (sentimentErr) {
        // Don't let the sentiment-routing step block the rest of
        // classification — just log and continue.
        log.warn(`Review-request sentiment routing failed (non-fatal): ${sentimentErr.message}`);
      }

      // Route based on classification (all writes tenant-scoped)
      const lastReply = { last_reply_at: reply.created_at || new Date().toISOString() };
      if (classification === 'interested') {
        await db.from('leads')
          .update({ status: 'contacted', lifecycle_stage: 'interested', ...lastReply })
          .eq('id', reply.lead_id)
          .eq('tenant_id', tenant.id);
        log.info(`INTERESTED: Lead ${reply.lead_id}`);

        // Sales-department human handoff (2026-07-21): an interested prospect
        // is THE moment the human takes over. Red owner action + push + due
        // date on the lead, and a meeting brief prepared before the call.
        // All best-effort — classification is already written above.
        if (reply.lead_id) {
          try {
            const { markHumanHandoff } = require('../../core/sales/coordination');
            await markHumanHandoff(db, tenant.id, reply.lead_id, {
              reason: 'interested_reply',
              action: 'sales_call',
              severity: 'red',
              attentionType: 'sales_reply_interested',
              summary: `"${String(reply.message_body || '').slice(0, 240)}"`,
              conversationId: reply.id,
              producedBy: 'reply-classification',
            });
            // Brief Patrick before the call — meeting-prep reads payload.lead_id.
            const { data: leadRow } = await db.from('leads')
              .select('briefing_generated').eq('id', reply.lead_id)
              .eq('tenant_id', tenant.id).maybeSingle();
            if (!leadRow?.briefing_generated) {
              await db.from('agent_jobs').insert({
                tenant_id: tenant.id,
                agent_name: 'meeting-prep',
                payload: { lead_id: reply.lead_id },
                status: 'pending',
                priority: 7,
              });
            }
          } catch (handoffErr) {
            log.warn(`Human handoff surfacing failed (non-fatal): ${handoffErr.message}`);
          }
        }
      } else if (classification === 'positive_objection') {
        await db.from('leads')
          .update({ lifecycle_stage: 'nurture', ...lastReply })
          .eq('id', reply.lead_id)
          .eq('tenant_id', tenant.id);
      } else if (classification === 'firm_no' || classification === 'unsubscribe') {
        await db.from('leads')
          .update({ status: 'lost', lifecycle_stage: 'disqualified', ...lastReply })
          .eq('id', reply.lead_id)
          .eq('tenant_id', tenant.id);
        if (classification === 'unsubscribe' && reply.contact_id) {
          await db.from('contacts')
            .update({ contact_status: 'unsubscribed' })
            .eq('id', reply.contact_id)
            .eq('tenant_id', tenant.id);
        }
      } else if (classification === 'out_of_office') {
        // Leave as-is, will retry later
      } else if (classification === 'needs_more_info') {
        await db.from('leads')
          .update({ lifecycle_stage: 'engaged', ...lastReply })
          .eq('id', reply.lead_id)
          .eq('tenant_id', tenant.id);

        // A substantive question also summons the human — amber, not red.
        if (reply.lead_id) {
          try {
            const { markHumanHandoff } = require('../../core/sales/coordination');
            await markHumanHandoff(db, tenant.id, reply.lead_id, {
              reason: 'question_reply',
              action: 'answer_question',
              severity: 'amber',
              attentionType: 'sales_reply_question',
              summary: `"${String(reply.message_body || '').slice(0, 240)}"`,
              conversationId: reply.id,
              producedBy: 'reply-classification',
            });
          } catch (handoffErr) {
            log.warn(`Question handoff surfacing failed (non-fatal): ${handoffErr.message}`);
          }
        }
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

      // Module 13.3 — re-score the lead now that we have a new signal
      // (their reply changes urgency, response speed, lifecycle stage).
      // Enqueueing instead of running inline keeps this loop fast.
      if (reply.lead_id) {
        try {
          await db.from('agent_jobs').insert({
            tenant_id: tenant.id,
            agent_name: 'scoring',
            payload: { lead_id: reply.lead_id },
            status: 'pending',
            priority: 5,
          });
        } catch (rescoreErr) {
          log.warn(`Could not enqueue re-scoring for lead ${reply.lead_id}: ${rescoreErr.message}`);
        }
      }

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
