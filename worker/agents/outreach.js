/**
 * Growth OS — Outreach Agent (Tenant-Aware)
 * Ported from WellMor outreach-agent.js
 *
 * Reads enriched + outreach-ready leads, generates personalized
 * cold email, LinkedIn message, and call opener via Claude.
 * Inserts drafts into outreach_sequences + conversations.
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

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Professional and helpful.');
  const dailyLimit = Number(payload.limit || getConfig(tenant, 'outreach_daily_limit', 10));

  // Fetch outreach-ready leads.
  // Pipeline: prospect → enriched → scored (outreach_ready=true) → sequenced
  // We accept both 'enriched' (never scored) and 'scored' lifecycle stages,
  // but prefer scored+outreach_ready leads via ordering.
  const { data: leads, error: leadErr } = await db
    .from('leads')
    .select('id, company_name, industry, size, status, lifecycle_stage, lead_score, lead_tier, outreach_ready, metadata, website')
    .eq('tenant_id', tenant.id)
    .in('lifecycle_stage', ['enriched', 'scored'])
    .or('outreach_ready.eq.true,outreach_ready.is.null')
    .order('outreach_ready', { ascending: false, nullsFirst: false })
    .order('lead_score', { ascending: false, nullsFirst: false })
    .limit(dailyLimit);

  if (leadErr) throw leadErr;

  if (!leads || !leads.length) {
    log.info('No outreach-ready leads');
    return { success: true, drafted: 0, message: 'No outreach-ready leads' };
  }

  let drafted = 0;
  const processed = [];
  const errors = [];

  for (const lead of leads) {
    try {
      // Fetch contacts for this lead
      const { data: contacts } = await db
        .from('contacts')
        .select('id, first_name, last_name, title, email, linkedin_url, is_primary_contact')
        .eq('tenant_id', tenant.id)
        .eq('lead_id', lead.id)
        .order('is_primary_contact', { ascending: false })
        .limit(2);

      if (!contacts || !contacts.length) {
        errors.push({ lead_id: lead.id, company: lead.company_name, error: 'No contacts' });
        continue;
      }

      const primaryContact = contacts[0];

      // Generate outreach via Claude
      const systemPrompt = `You create outbound sales drafts for ${businessName}. Return only valid JSON.`;

      const userPrompt = `
You are writing outbound messaging for ${businessName}.

Voice: ${brandVoice}

Company:
- Company: ${lead.company_name}
- Industry: ${lead.industry || 'unknown'}
- Size: ${lead.size || 'unknown'}
- Score: ${lead.lead_score || 'unknown'}

Contact: ${contactDisplayName(primaryContact)}, ${primaryContact.title || 'unknown role'}

Write concise, professional outbound drafts.

Return JSON only:
{
  "email_subject": "string",
  "email_body": "string",
  "linkedin_message": "string",
  "call_opener": "string"
}

Rules:
- Email should be short, warm, and personalized.
- LinkedIn message should be shorter than the email.
- Call opener should sound natural.
- Not spammy. Not corporate. Direct and human.
- JSON only. No markdown.
`;

      const drafts = await askClaudeJSON(systemPrompt, userPrompt, {
        maxTokens: 1500,
        tenantSlug: tenant.slug
      });

      // Validate Claude returned the minimum required fields
      if (!drafts || typeof drafts !== 'object' || !drafts.email_body || !drafts.linkedin_message) {
        log.warn('Claude returned malformed drafts, skipping', { lead_id: lead.id });
        errors.push({ lead_id: lead.id, company: lead.company_name, error: 'Malformed Claude response' });
        continue;
      }

      // Insert outreach sequence
      const { data: sequence, error: seqErr } = await db
        .from('outreach_sequences')
        .insert({
          tenant_id: tenant.id,
          lead_id: lead.id,
          contact_id: primaryContact.id,
          sequence_name: `${businessName} Initial Outreach`,
          sequence_type: 'multi_channel',
          sequence_status: 'draft',
          step_number: 1,
          message_subject: drafts.email_subject || null,
          message_body: drafts.email_body || null,
        })
        .select()
        .single();

      if (seqErr) {
        log.warn('Sequence insert failed, saving to metadata', seqErr);
      }

      // Insert conversations
      const convRows = [
        {
          tenant_id: tenant.id,
          lead_id: lead.id,
          contact_id: primaryContact.id,
          sequence_id: sequence?.id || null,
          channel: 'email',
          direction: 'outbound',
          message_subject: drafts.email_subject,
          message_body: drafts.email_body,
        },
        {
          tenant_id: tenant.id,
          lead_id: lead.id,
          contact_id: primaryContact.id,
          sequence_id: sequence?.id || null,
          channel: 'linkedin',
          direction: 'outbound',
          message_body: drafts.linkedin_message,
        }
      ];

      await db.from('conversations').insert(convRows);

      // Update lead lifecycle
      await db.from('leads')
        .update({ lifecycle_stage: 'sequenced' })
        .eq('id', lead.id)
        .eq('tenant_id', tenant.id);

      drafted++;
      processed.push({
        lead_id: lead.id,
        company: lead.company_name,
        contact: contactDisplayName(primaryContact),
        sequence_id: sequence?.id,
      });

      log.info(`Drafted outreach: ${lead.company_name}`);
    } catch (err) {
      log.error(`Outreach failed: ${lead.company_name}`, err);
      errors.push({ lead_id: lead.id, company: lead.company_name, error: err.message });
    }
  }

  log.success(`Outreach complete: ${drafted} drafted`);
  return { success: true, drafted, processed, errors };
}

module.exports = run;
