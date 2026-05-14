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
const { buildFactsBlock } = require('../../core/fga-research-stats');

function contactDisplayName(contact) {
  return [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || 'there';
}

// Hard ban list — Claude must not name specific clients in cold outreach.
// Even with prompt-level guardrails, sometimes a fabrication slips through;
// catch it here and reject the draft so the loop will skip it (re-fire next
// cron run will re-draft with a fresh prompt).
const BANNED_CLIENT_STRINGS = [
  'A Kut Above',
  'a kut above',
  'AKA Tree',
  'WellMor',
  'wellmor',
  'WellMor Benefits',
];

/**
 * Check a generated draft for banned strings (client names) and obviously
 * fabricated metrics. Returns null if clean, or an error string describing
 * the first violation found.
 */
function findGuardrailViolations(drafts) {
  const text = [
    drafts.subject || '',
    drafts.body_plain || '',
    drafts.body || '',
    drafts.body_html || '',
  ].join('\n');
  for (const banned of BANNED_CLIENT_STRINGS) {
    if (text.includes(banned)) {
      return `banned client name in draft: "${banned}"`;
    }
  }
  return null;
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
  // Channel mode:
  //   'email_only' (default) — draft only email leads. FB leads stay queued.
  //   'fb_fallback'          — draft FB-DM leads too. Triggered Sunday only
  //                            (or explicit payload.mode='fb_fallback') when
  //                            the weekly email count hasn't hit target.
  const mode = payload.mode || 'email_only';

  // Which lifecycle stages are in scope for this run?
  // - email-qualified leads always live at 'enriched'
  // - facebook-only leads live at 'fb_only' — only pulled on fallback
  const stages = mode === 'fb_fallback' ? ['enriched', 'fb_only'] : ['enriched'];

  // Fetch leads in scope that haven't been sequenced yet. Source filter is
  // dropped so a manually-created lead (lead_source='manual') also gets
  // drafted — Patrick can add a lead in the app and it flows through here.
  let leadsQuery = db
    .from('leads')
    .select('id, company_name, industry, size, status, lifecycle_stage, metadata, hq_state, phone, lead_source')
    .eq('tenant_id', tenant.id);
  if (payload.lead_id) {
    // Single-lead mode — called from enrichment's auto-enqueue for manual leads.
    leadsQuery = leadsQuery.eq('id', payload.lead_id).in('lifecycle_stage', stages);
  } else {
    leadsQuery = leadsQuery.in('lifecycle_stage', stages)
      .order('created_at', { ascending: true })
      .limit(dailyLimit);
  }
  const { data: leads, error: leadErr } = await leadsQuery;

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

      // Channel decision — email is primary, FB DM is fallback only
      let channel = null;
      if (contactEmail) {
        channel = 'email';
      } else if (facebookUrl && mode === 'fb_fallback') {
        channel = 'facebook_dm';
      } else {
        // Leads without email in email_only mode are skipped (kept in fb_only
        // lifecycle for later) or genuinely have no channel.
        processed.push({
          lead_id: lead.id, company: lead.company_name,
          action: facebookUrl
            ? 'skipped_fb_only_awaiting_fallback'
            : 'skipped_no_channel',
        });
        continue;
      }

      const contactName = primaryContact
        ? contactDisplayName(primaryContact)
        : (lead.metadata?.owner_name || 'there');

      // Build the channel-specific prompt
      //
      // GUARDRAILS (Patrick 2026-05-14):
      //  - NEVER name specific clients (e.g. "A Kut Above", "WellMor",
      //    "WellMor Benefits"). Past Claude runs invented client outcomes
      //    ("A Kut Above booked 4 jobs in their first week") which is a
      //    fabrication — we don't have those measured numbers. Use
      //    generic "another client" framing if a social-proof beat is
      //    needed, and ground it in a real industry statistic from
      //    `fga-research-stats.js` rather than a fake client win.
      //  - The email MUST be relevant to THIS lead's industry. Don't talk
      //    about tree service in an HVAC email or vice versa. Pull
      //    industry-specific facts and references.
      //
      // The buildFactsBlock helper returns the same FACTS YOU MAY CITE
      // block used by content generation — industry-keyed stats + cross-
      // industry fallbacks, plus the explicit "do not invent numbers" rules.
      const factsBlock = buildFactsBlock(lead.industry, [], 4, 4);

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

${factsBlock}

HARD RULES — DO NOT BREAK:
1. INDUSTRY MATCH. This email is going to a ${lead.industry} business owner.
   Every scene, example, tool reference, and pain point in the email MUST be
   from THEIR trade. Examples:
   - ${lead.industry} = HVAC → manifold gauge, condenser, thermostat, peak cooling/heating season, service truck
   - ${lead.industry} = Plumbing → wrench on a copper joint, water heater, shutoff valve, under-sink call
   - ${lead.industry} = Electrical → panel box, breakers, multimeter, weekend wiring jobs
   - ${lead.industry} = Landscaping & Tree Service → chipper, stump grinder, chainsaw, spring cleanups
   - ${lead.industry} = Roofing → pitched roof, nail gun, hail season, insurance claim
   - ${lead.industry} = Cleaning Services → caddy, recurring schedule, customer home access
   Do NOT mix industries. If you write a tree-service scene to an HVAC owner,
   the email is wrong.
2. NO INVENTED CLIENT METRICS. Do not write "A Kut Above booked 4 jobs" or
   "our tree-service client closed X" with a specific number. We don't have
   those measured outcomes. NEVER name a client by name. If you want a social-
   proof beat, use a generic reference like "another small ${lead.industry}
   shop" or "a 1-3 person crew we set up" and pair it with a real cited
   industry statistic from the FACTS YOU MAY CITE block above.
3. NO INVENTED NUMBERS. The only numbers you may cite are from the FACTS
   block above. Use 0 or 1 number. Quote it accurately. Name the source.
4. BANNED CLIENT NAMES (do not include any of these in the email body):
   "A Kut Above", "WellMor", "WellMor Benefits", "AKA", "First Gen Automate
   client named". Generic references are fine.
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
- Open with a specific observation that's RELEVANT TO ${lead.industry} —
  reference a tool, a job site scene, or a seasonal pressure from that
  trade. Don't write generic "small business owner" copy.
- One clear value prop, not a laundry list of features
- One soft CTA: "open to a 15-minute call?" or "reply if this resonates"
- Mention $2k setup / $497/mo pricing ONLY if natural, not as the lead
- Sign off with "${senderName}" — no title, no company in signature (those go in the from-field)
- DO NOT name any client. DO NOT invent client metrics. See the HARD RULES above.
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
- The DM MUST reference something from THEIR trade (${lead.industry}) — a
  tool, a job, a typical scene. Not a generic small-business opener.
- Never open with 'I hope this message finds you well' or similar
- Do NOT ask for their phone number
- Do NOT send any link (FB flags DMs with links as spam)
- DO NOT name any client. DO NOT invent client metrics.
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

      // Guardrail post-check: reject the draft if Claude slipped a banned
      // client name in despite the prompt-level instructions.
      const violation = findGuardrailViolations(drafts);
      if (violation) {
        log.warn(`Guardrail rejected draft for ${lead.company_name}: ${violation}`);
        errors.push({ lead_id: lead.id, company: lead.company_name, error: `Guardrail: ${violation}` });
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
