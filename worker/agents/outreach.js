/**
 * Growth OS — Outreach Agent (Email-first, Facebook DM fallback)
 *
 * DESIGN (2026-04-21 — Patrick):
 *  - For each enriched, qualified lead that hasn't been sequenced yet, draft
 *    outreach in ONE channel:
 *      * contacts.email is present  → draft cold email (auto-sendable via Resend)
 *      * else facebook_url in metadata → draft Facebook Messenger DM (manual send)
 *    A lead must have EITHER to be reachable — enrichment already rejected
 *    leads without either so this is just re-checking at the outreach layer.
 *  - Drafts ONLY. Nothing auto-sends. They land in content_drafts / outreach_
 *    sequences for Patrick to review in the mobile app.
 *  - No SMS. Period.
 *
 * Pipeline:
 *   enriched lead → outreach (draft) → human approval → send
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

function contactDisplayName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || 'there';
}

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('outreach', tenant.slug);

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'First Gen Automate');
  const brandVoice = getConfig(
    tenant,
    'brand_voice',
    'Direct, warm, and human. We help micro-businesses automate lead capture, follow-up, and online presence so they can focus on the work they love.'
  );
  const senderName = getConfig(tenant, 'sender_name', 'Patrick Jenkins');
  const senderTitle = getConfig(tenant, 'sender_title', 'Founder, First Gen Automate');
  const dailyLimit = Number(payload.limit || getConfig(tenant, 'outreach_daily_limit', 15));

  // Fetch enriched leads that haven't been sequenced yet.
  const { data: leads, error: leadErr } = await db
    .from('leads')
    .select('id, company_name, industry, size, status, lifecycle_stage, metadata, hq_state, phone')
    .eq('tenant_id', tenant.id)
    .eq('lifecycle_stage', 'enriched')
    .eq('lead_source', 'prospecting_agent')
    .order('created_at', { ascending: true })
    .limit(dailyLimit);

  if (leadErr) throw leadErr;

  if (!leads || !leads.length) {
    log.info('No enriched leads waiting for outreach');
    return { success: true, drafted: 0, message: 'No enriched leads' };
  }

  let draftedEmail = 0;
  let draftedDm = 0;
  const processed = [];
  const errors = [];

  for (const lead of leads) {
    try {
      // Find primary contact (enrichment.enrichOne inserted one if it had a name/email)
      const { data: contacts } = await db
        .from('contacts')
        .select('id, first_name, last_name, title, email, linkedin_url, is_primary_contact')
        .eq('tenant_id', tenant.id)
        .eq('lead_id', lead.id)
        .order('is_primary_contact', { ascending: false })
        .limit(2);

      const primaryContact = (contacts && contacts[0]) || null;
      const contactEmail = primaryContact?.email || null;
      const facebookUrl = lead.metadata?.facebook_url || null;

      // Channel decision
      let channel = null;
      if (contactEmail) channel = 'email';
      else if (facebookUrl) channel = 'facebook_dm';
      else {
        // Should not happen — enrichment only qualifies leads with one of these.
        // But we guard to avoid crashing the batch.
        processed.push({
          lead_id: lead.id, company: lead.company_name,
          action: 'skipped_no_channel',
        });
        continue;
      }

      const contactName = primaryContact
        ? contactDisplayName(primaryContact)
        : (lead.metadata?.owner_name || 'there');

      // Build the channel-specific prompt
      const commonContext = `
BUSINESS CONTEXT:
- Company: ${lead.company_name}
- Industry: ${lead.industry}
- State: ${lead.hq_state || 'unknown'}
- Size: ${lead.size || '1-3'} employees
- Owner/contact: ${contactName}${primaryContact?.title ? ` (${primaryContact.title})` : ''}

WHY WE'RE REACHING OUT (${businessName}'s pitch):
We help small home-service businesses win more jobs without hiring. We build an
automated system that captures leads, texts them back in under 60 seconds,
follows up automatically, posts to social, and asks for reviews. Most of our
clients have 1-3 people and don't have a website — our system IS their website
+ CRM + social presence all in one. Setup is a flat $2,000; then $497/mo.

VOICE: ${brandVoice}

SENDER: ${senderName}, ${senderTitle}
`;

      let systemPrompt, userPrompt;
      if (channel === 'email') {
        systemPrompt = 'You write cold outreach emails for a sales prospect. Output only valid JSON.';
        userPrompt = `
${commonContext}

Write a COLD EMAIL to ${contactName}. Return JSON only:

{
  "subject": "Short, specific subject line. No spammy caps. No emojis. 5-9 words max.",
  "body_plain": "Plain-text email body. 4-6 short paragraphs. Conversational, warm, direct. NOT corporate. No buzzwords. No 'I hope this email finds you well'. Reference something specific about their business if you can. Sign off with sender name only. 120-180 words max.",
  "body_html": "The same body as HTML — wrap paragraphs in <p> tags. No styling, no images, no CTAs as big buttons. Just text in <p> tags with a single plain <a> link at the end if you include one."
}

CRITICAL:
- Open with a specific observation (their state, their industry, owner-operated nature)
- One clear value prop, not a laundry list of features
- One soft CTA: "open to a 15-minute call?" or "reply if this resonates"
- Mention $2k setup / $497/mo pricing ONLY if natural, not as the lead
- Sign off with "${senderName}" — no title, no company in signature (those go in the from-field)
- JSON only. No markdown.
`;
      } else {
        // facebook_dm
        systemPrompt = 'You write short, warm Facebook Messenger DMs for cold outreach. Output only valid JSON.';
        userPrompt = `
${commonContext}

Write a FACEBOOK MESSENGER DM to ${lead.company_name}'s page. The page owner
is almost certainly ${contactName}. Return JSON only:

{
  "body": "Short DM, 3-4 short sentences. Max 350 characters. Even more casual than email — FB DMs are personal. Start with 'Hey ${contactName}' or 'Hi there — saw your page'. Mention one specific thing and one offer (15-min call or a free audit). No formatting, no hashtags."
}

CRITICAL:
- Sound like a human founder, not a marketing bot
- Never open with 'I hope this message finds you well' or similar
- Do NOT ask for their phone number
- Do NOT send any link (FB flags DMs with links as spam)
- Sign off with "— ${senderName}" at the end
- JSON only.
`;
      }

      const drafts = await askClaudeJSON(systemPrompt, userPrompt, {
        maxTokens: 1200,
        tenantSlug: tenant.slug,
      });

      if (!drafts || typeof drafts !== 'object') {
        errors.push({ lead_id: lead.id, company: lead.company_name, error: 'Malformed Claude response' });
        continue;
      }

      // Insert outreach sequence
      const sequenceRow = {
        tenant_id: tenant.id,
        lead_id: lead.id,
        contact_id: primaryContact?.id || null,
        sequence_name: `${businessName} — ${channel === 'email' ? 'Cold Email' : 'FB DM'}`,
        sequence_type: channel,
        sequence_status: 'draft',
        step_number: 1,
        message_subject: drafts.subject || null,
        message_body: drafts.body_plain || drafts.body || null,
      };

      const { data: sequence, error: seqErr } = await db
        .from('outreach_sequences')
        .insert(sequenceRow)
        .select()
        .single();
      if (seqErr) log.warn(`Sequence insert error: ${seqErr.message}`);

      // Also insert a conversations row so mobile app approval queue picks it up
      await db.from('conversations').insert({
        tenant_id: tenant.id,
        lead_id: lead.id,
        contact_id: primaryContact?.id || null,
        sequence_id: sequence?.id || null,
        channel: channel === 'email' ? 'email' : 'facebook_dm',
        direction: 'outbound',
        message_subject: drafts.subject || null,
        message_body: drafts.body_plain || drafts.body || null,
        metadata: {
          channel,
          body_html: drafts.body_html || null,
          facebook_url: facebookUrl,
          draft_status: 'awaiting_approval',
          generated_at: new Date().toISOString(),
        },
      });

      // Advance the lead lifecycle so it isn't re-drafted tomorrow
      await db.from('leads')
        .update({ lifecycle_stage: 'sequenced' })
        .eq('id', lead.id)
        .eq('tenant_id', tenant.id);

      if (channel === 'email') draftedEmail++;
      else draftedDm++;

      processed.push({
        lead_id: lead.id,
        company: lead.company_name,
        channel,
        sequence_id: sequence?.id,
      });
      log.info(`Drafted ${channel} for ${lead.company_name}`);
    } catch (err) {
      log.error(`Outreach failed: ${lead.company_name}`, err);
      errors.push({ lead_id: lead.id, company: lead.company_name, error: err.message });
    }
  }

  const result = {
    success: true,
    drafted_email: draftedEmail,
    drafted_facebook_dm: draftedDm,
    drafted_total: draftedEmail + draftedDm,
    processed,
    errors,
  };
  log.success(
    `Outreach complete: ${draftedEmail} email + ${draftedDm} FB DM = ${draftedEmail + draftedDm} drafts`
  );
  return result;
}

module.exports = run;
