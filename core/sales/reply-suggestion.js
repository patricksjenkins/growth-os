/**
 * Suggested replies for interested/question prospects (2026-07-21,
 * Patrick-approved with explicit safety review).
 *
 * When reply-classification hands a prospect to the human lane, this module
 * drafts a SUGGESTED response so Patrick can review, edit, and send in one
 * tap from LeadDetail. Autonomy boundary — hard, by construction:
 *
 *   - NOTHING here sends. The draft is stored on the lead
 *     (metadata.suggested_reply) and the attention item; the ONLY send path
 *     is POST /api/admin/pipeline/:id/reply, which requires the
 *     authenticated admin (Patrick) to click.
 *   - Grounded in core/fga-knowledge.js — the same fact-gated knowledge the
 *     inbound chat/voice agents use. Real pricing may be stated if the
 *     prospect asked (inbound-honesty rule); the prompt forbids discounts,
 *     custom pricing, invented capabilities, scheduling/dispatch promises,
 *     and legal commitments.
 *   - Claude access goes through integrations/claude (chokepoint + pace
 *     gate + ai-safety guard). Output passes the stripAiTells sanitizer.
 *   - Best-effort: any failure returns null and the human handoff proceeds
 *     without a draft — a missing suggestion must never delay the handoff.
 */

const { createLogger } = require('../logger');

const log = createLogger('reply-suggestion');

const MAX_REPLY_CONTEXT = 1500;

/**
 * Generate a suggested reply for a classified inbound message.
 * Returns { subject, body } or null. Never throws.
 */
async function generateReplySuggestion(tenant, { lead, replyText, classification, originalSubject }) {
  try {
    const { askClaudeJSON } = require('../../integrations/claude');
    const { buildFgaKnowledgePrompt } = require('../fga-knowledge');
    const { stripAiTells, NO_DASH_PROMPT_RULE } = require('../text-style');

    const knowledge = buildFgaKnowledgePrompt();
    const systemPrompt = `You draft a SUGGESTED email reply for Patrick (founder of First Gen Automate) to send to a prospect who just replied to his outreach. Patrick will review and edit before sending — write it ready-to-send in his voice.

${knowledge}

HARD RULES (violating any of these makes the draft unusable):
- NEVER offer a discount, custom pricing, or payment terms of any kind.
- NEVER promise a capability that is not in the knowledge above. First Gen Automate has NO scheduling, dispatch, calendar, or booking capability — never imply it does.
- NEVER make legal or contractual commitments.
- Pricing: only state it if the prospect explicitly asked, and only the standard published terms from the knowledge above.
- Keep it SHORT (60-120 words), plain-spoken, warm, zero jargon, no bullet lists.
- Primary goal: move toward a 15-minute call. Offer 2 concrete times or ask what works.
- Answer their actual question first if they asked one. Honestly — if the answer is "we don't do that," say so plainly.
- Sign off as "Patrick".
${NO_DASH_PROMPT_RULE}

Return JSON: {"subject": "Re: ...", "body": "..."} — body is plain text with normal line breaks. Valid JSON only, no markdown.`;

    const userMessage = `Prospect: ${lead.name || 'the owner'} at ${lead.company_name || 'their business'} (${lead.industry || 'unknown industry'}${lead.city ? `, ${lead.city}` : ''}).
Classification of their reply: ${classification}.
Original outreach subject: ${originalSubject || '(unknown)'}

Their reply:
"""
${String(replyText || '').slice(0, MAX_REPLY_CONTEXT)}
"""`;

    const result = await askClaudeJSON(systemPrompt, userMessage, {
      maxTokens: 700,
      tenantSlug: tenant.slug,
    });
    if (!result || !result.body) return null;

    const body = stripAiTells(String(result.body)).trim();
    const subject = stripAiTells(String(result.subject || `Re: ${originalSubject || 'your reply'}`)).trim().slice(0, 140);
    if (!body || body.length < 20) return null;

    // Belt over braces: a dollar figure is allowed ONLY when the prospect's
    // own message contains one or asks about price/cost. Otherwise strip the
    // draft rather than risk violating the no-unprompted-pricing rule.
    const asked = /\$\s?\d|price|pricing|cost|how much|charge/i.test(String(replyText || ''));
    if (!asked && /\$\s?\d/.test(body)) {
      log.warn('Suggested reply volunteered pricing unprompted — discarding draft');
      return null;
    }

    return { subject, body };
  } catch (err) {
    log.warn(`Reply suggestion failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Persist a suggestion: merge into leads.metadata.suggested_reply and, when
 * an open sales attention item exists for the lead, into its payload (so the
 * mobile card can show it later). Best-effort; never throws.
 */
async function storeReplySuggestion(db, tenantId, leadId, suggestion, extra = {}) {
  if (!suggestion) return false;
  try {
    const { data: leadRow } = await db.from('leads')
      .select('metadata').eq('id', leadId).eq('tenant_id', tenantId).maybeSingle();
    const metadata = {
      ...(leadRow?.metadata || {}),
      suggested_reply: {
        subject: suggestion.subject,
        body: suggestion.body,
        generated_at: new Date().toISOString(),
        ...extra,
      },
    };
    const { error } = await db.from('leads').update({ metadata })
      .eq('id', leadId).eq('tenant_id', tenantId);
    if (error) throw error;

    await db.from('attention_queue')
      .select('id, payload').eq('tenant_id', tenantId).eq('entity_id', leadId)
      .like('type', 'sales_reply_%').is('resolved_at', null).limit(1)
      .then(async ({ data }) => {
        if (data && data[0]) {
          await db.from('attention_queue')
            .update({ payload: { ...(data[0].payload || {}), suggested_reply: suggestion } })
            .eq('id', data[0].id);
        }
      }, () => {});
    return true;
  } catch (err) {
    log.warn(`Could not store reply suggestion (non-fatal): ${err.message}`);
    return false;
  }
}

module.exports = { generateReplySuggestion, storeReplySuggestion };
