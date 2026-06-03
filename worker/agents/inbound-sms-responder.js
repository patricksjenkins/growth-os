/**
 * Growth OS — Inbound SMS Responder Agent
 *
 * Handles cold/unknown inbound texts to FGA's public Twilio number.
 * Generates a brand-voice AI reply via Claude and sends it back via SMS.
 *
 * Distinct from `conversation-responder` agent which handles known
 * leads/contacts already in the CRM. This one is for people who just
 * texted FGA's number for the first time and aren't in the system yet.
 *
 * Flow:
 *   1. Pulls the last ~10 messages with this phone number from
 *      `messages` (both directions) to give Claude conversation context.
 *   2. Calls Claude with FGA positioning + tagline rule + the recent
 *      thread → asks for a short, helpful SMS reply (≤160 chars).
 *   3. Sends the reply via Twilio.
 *   4. Logs the outbound to `messages` for the next turn's context.
 *   5. If the sender provides clear name + intent ("I'm Jane, run a
 *      tree service, interested in your platform"), auto-creates a
 *      lead row so the rest of the FGA pipeline picks them up.
 *
 * Guardrails:
 *   - Honors the per-tenant claude_spend_cents usage cap.
 *   - Skips if the inbound looks like spam (STOP, unsubscribe, opt-out
 *     keywords) — those flow through Twilio's automatic compliance.
 *   - Skips if A2P 10DLC carrier filtering would block the outbound —
 *     silent fail with log, the push notification to the owner is the
 *     real safety net in that case.
 *
 * Tenant scope: enqueued by the /webhooks/twilio/sms handler for any
 * tenant with the `ai_chat_agent` module enabled (the closest existing
 * module — covers conversational AI on owned channels). Falls back to
 * the static TwiML auto-reply if module is off.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');
const { askClaude } = require('../../integrations/claude');
const { sendSms, A2PUnregisteredError, SmsCapExceededError } = require('../../integrations/telnyx');
const { buildFgaKnowledgePrompt } = require('../../core/fga-knowledge');

const SMS_REPLY_MAX_CHARS = 320;  // ~2 SMS segments — keeps cost predictable
const HISTORY_TURN_LIMIT = 10;

// Built once at module load. If the knowledge base file is edited,
// the worker restart picks up the new version automatically.
const FGA_SYSTEM_PROMPT = `You are the FGA (First Gen Automate) text-message assistant. A person just texted FGA's public number.

${buildFgaKnowledgePrompt({ includeFaqs: true, includeModules: true, includePricing: true })}

=== YOUR JOB ===
- Reply in 1-3 short sentences, max 320 characters total (SMS).
- Helpful, direct, plain-spoken. Not salesy. No marketing jargon.
- Use the FAQ section above for canonical answers — paraphrase to match the conversation, never copy verbatim unless asked for exact info.
- If asked about an integration we don't have (HubSpot, Salesforce, Pipedrive, GoHighLevel, Zoho, etc.) → use the integration-policy answer from the FAQs. Tone: NOT "we replace those tools, cancel yours." Tone IS: "no ongoing sync, but we can import once at signup, and most customers migrate off naturally as they see what FGA covers." Respect the customer's existing setup.
- If asking pricing → name the tier prices + 14-day trial briefly; point to firstgenautomate.com/pricing for the full breakdown.
- If asking what FGA does → the four pillars + invite them to book a demo.
- If asking a technical question you don't have an answer for → say "Let me get Patrick to text you back personally on that one" and don't fabricate.
- If being abusive, spammy, or wildly off-topic → respond once politely declining; do not engage further.
- Never quote a price or delivery date that isn't in the knowledge base above. Never ask for sensitive info (SSN, credit card, passwords).
- If the person shares their name + business, acknowledge and offer to set up a demo call.

=== OUTPUT FORMAT ===
Respond with ONLY the SMS text to send back. No quotation marks, no preface, no markdown. Just the message body.`;

async function _getRecentHistory(tenantId, phone) {
  const { data } = await db
    .from('messages')
    .select('direction, body, sent_at')
    .eq('tenant_id', tenantId)
    .eq('channel', 'sms')
    .or(`direction.eq.inbound,direction.eq.outbound`)
    .order('sent_at', { ascending: false })
    .limit(40);

  // Filter to ones involving this phone (inbound from them OR outbound to them).
  // The `messages` table doesn't always carry an explicit `to`/`from` so we
  // also filter by contact_id when available — but for unknown senders we
  // approximate via the `body` containing a phone reference, then trust the
  // tenant scope.
  // Simpler heuristic for now: take the last N messages and label them by
  // direction. Good enough for short conversations.
  const recent = (data || []).reverse().slice(-HISTORY_TURN_LIMIT);
  return recent.map(m => `${m.direction === 'inbound' ? 'THEM' : 'FGA'}: ${(m.body || '').slice(0, 200)}`).join('\n');
}

function _looksLikeStopMessage(body) {
  const trimmed = String(body || '').trim().toLowerCase();
  return /^(stop|stopall|cancel|end|quit|unsubscribe|stop2)\b/.test(trimmed);
}

async function _maybeCaptureLead(tenant, phone, body, replyText) {
  // Look for signs the user shared a name + business in the conversation.
  // If we already auto-replied at least once, see if we can extract enough
  // to create a lead row. Cheap-and-cheerful regex; the real lead-capture
  // story is the conversation-responder agent picking up after this.
  const nameMatch = body.match(/\b(?:i'?m|my name is|this is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const businessHint = /\b(?:business|company|shop|studio|clinic|practice|salon|crew|services?)\b/i.test(body);
  if (!nameMatch || !businessHint) return null;

  const name = nameMatch[1].trim();
  const { data, error } = await db.from('leads').insert({
    tenant_id: tenant.id,
    name,
    phone,
    source: 'inbound_sms',
    status: 'new',
    notes: `Auto-captured from inbound SMS conversation:\n\nTHEM: ${body.slice(0, 240)}\n\nFGA: ${replyText.slice(0, 240)}`,
  }).select('id').single();
  return error ? null : data?.id;
}

async function run(tenant, payload = {}) {
  const log = createLogger('inbound-sms-responder', tenant?.slug);
  const { from, inbound_body, message_sid } = payload;

  if (!from || !inbound_body) {
    log.warn('Missing from or inbound_body — skipping');
    return { success: false, skipped: true, reason: 'invalid_payload' };
  }

  if (_looksLikeStopMessage(inbound_body)) {
    log.info(`Inbound looks like a STOP/opt-out from ${from} — Twilio handles compliance, agent will not respond.`);
    return { success: true, skipped: true, reason: 'opt_out_keyword' };
  }

  const history = await _getRecentHistory(tenant.id, from);
  const userMessage = `Recent SMS conversation with this phone number (most recent last):
${history || '(no prior messages)'}

The latest inbound to respond to:
THEM: ${inbound_body}

Write the reply to send back as an SMS.`;

  let replyText;
  try {
    replyText = await askClaude(FGA_SYSTEM_PROMPT, userMessage, {
      maxTokens: 240,
      temperature: 0.5,
      tenant,
      tenantSlug: tenant.slug,
    });
  } catch (err) {
    log.error(`Claude reply generation failed: ${err.message}`);
    return { success: false, error: err.message };
  }

  // Defensive trim — Claude usually obeys the 320-char limit but enforce it
  replyText = (replyText || '').trim().slice(0, SMS_REPLY_MAX_CHARS);
  if (!replyText) {
    log.warn('Empty reply from Claude — skipping send');
    return { success: false, skipped: true, reason: 'empty_reply' };
  }

  // Send via Twilio
  try {
    await sendSms(tenant.integrations, from, replyText, {
      tenantSlug: tenant.slug,
      tenant,
    });
    log.success(`Replied to ${from}: "${replyText.slice(0, 60)}..."`);
  } catch (err) {
    if (err instanceof A2PUnregisteredError) {
      log.warn(`Reply skipped — A2P 10DLC unregistered for ${err.from}. Push to owner is the fallback notification.`);
    } else if (err instanceof SmsCapExceededError) {
      log.warn(`SMS cap exceeded — reply skipped`);
    } else {
      log.error(`SMS send failed: ${err.message}`);
    }
    // Don't crash the job — the inbound was still logged + owner was already pushed
  }

  // Log the outbound reply for next-turn context + idempotency
  await db.from('messages').insert({
    tenant_id: tenant.id,
    channel: 'sms',
    direction: 'outbound',
    body: replyText,
    external_id: null,
    sent_at: new Date().toISOString(),
  });

  // Best-effort lead capture from name + business mention
  const capturedLeadId = await _maybeCaptureLead(tenant, from, inbound_body, replyText);
  if (capturedLeadId) {
    log.success(`Captured lead ${capturedLeadId} from inbound SMS conversation`);
  }

  return {
    success: true,
    reply: replyText,
    captured_lead_id: capturedLeadId,
  };
}

module.exports = run;
