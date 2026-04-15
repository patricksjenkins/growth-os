/**
 * Growth OS — Meeting Prep Agent (Tenant-Aware)
 * Ported from WellMor meeting-prep-agent.js
 *
 * Generates comprehensive meeting briefings when a demo/meeting is
 * booked. Creates research doc with company overview, pain points,
 * discovery questions, and competitive context.
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendEmail } = require('../../integrations/email');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { lead_id }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('meeting-prep', tenant.slug);

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const ownerEmail = getConfig(tenant, 'digest_email', tenant.owner_email);
  const serviceTypes = getConfig(tenant, 'service_types', []);

  // Find leads with upcoming meetings or demo_booked status
  let leads;
  if (payload.lead_id) {
    const { data } = await db
      .from('leads')
      .select('id, company_name, industry, size, website, hq_state, metadata, lead_score')
      .eq('id', payload.lead_id)
      .eq('tenant_id', tenant.id)
      .single();
    leads = data ? [data] : [];
  } else {
    const { data } = await db
      .from('leads')
      .select('id, company_name, industry, size, website, hq_state, metadata, lead_score')
      .eq('tenant_id', tenant.id)
      .eq('status', 'demo_booked')
      .is('briefing_generated', null)
      .limit(5);
    leads = data || [];
  }

  if (!leads.length) {
    log.info('No meetings needing briefings');
    return { success: true, briefings: 0, message: 'No meetings to prep' };
  }

  let briefings = 0;
  const results = [];

  for (const lead of leads) {
    try {
      // Get contacts
      const { data: contacts } = await db
        .from('contacts')
        .select('first_name, last_name, title, email, linkedin_url')
        .eq('lead_id', lead.id)
        .eq('tenant_id', tenant.id)
        .limit(3);

      const primaryContact = contacts?.[0] || {};
      const contactName = [primaryContact.first_name, primaryContact.last_name].filter(Boolean).join(' ') || 'Unknown';

      // Get conversation history
      const { data: convos } = await db
        .from('conversations')
        .select('channel, direction, message_body, created_at')
        .eq('lead_id', lead.id)
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: true })
        .limit(10);

      const convoSummary = (convos || []).map(c =>
        `[${c.channel}] ${c.direction}: ${(c.message_body || '').substring(0, 200)}`
      ).join('\n');

      // Generate briefing via Claude
      const systemPrompt = `You are a research analyst for ${businessName}, preparing a briefing before a discovery call. Create a thorough, insightful briefing. Write directly — make assertions, don't hedge.

${businessName} offers: ${serviceTypes.join(', ')}`;

      const userPrompt = `Generate a meeting briefing for this prospect:

COMPANY: ${lead.company_name}
Industry: ${lead.industry || 'unknown'}
Size: ${lead.size || 'unknown'}
State: ${lead.hq_state || 'unknown'}
Website: ${lead.website || 'none'}
Lead Score: ${lead.lead_score || 'unscored'}

CONTACT: ${contactName}, ${primaryContact.title || 'unknown title'}

CONVERSATION HISTORY:
${convoSummary || 'None yet'}

Return JSON:
{
  "at_a_glance": { "company_name": "", "contact_name": "", "contact_title": "", "industry": "", "employee_count": 0, "location": "", "icp_match_score": 0 },
  "why_targeted": "2-3 sentences",
  "company_overview": "3-4 sentences",
  "contact_profile": "2-3 sentences",
  "pain_points": ["string"],
  "discovery_questions": ["string"] (5-8),
  "competitive_notes": "2-3 sentences",
  "talking_points": ["string"] (3-5 key things to mention)
}`;

      const briefing = await askClaudeJSON(systemPrompt, userPrompt, {
        maxTokens: 3000,
        tenantSlug: tenant.slug,
      });

      // Store briefing
      await db.from('meeting_briefings').insert({
        tenant_id: tenant.id,
        lead_id: lead.id,
        briefing_data: briefing,
      });

      // Mark lead as briefed
      await db.from('leads').update({ briefing_generated: true }).eq('id', lead.id);

      // Email briefing to owner
      if (ownerEmail) {
        const questionsHtml = (briefing.discovery_questions || []).map((q, i) => `<li>${q}</li>`).join('');
        const painHtml = (briefing.pain_points || []).map(p => `<li>${p}</li>`).join('');

        await sendEmail({
          to: ownerEmail,
          subject: `Meeting Briefing: ${lead.company_name}`,
          html: `
            <h2>${lead.company_name} — Discovery Call Briefing</h2>
            <p><strong>Contact:</strong> ${contactName} (${primaryContact.title || ''})</p>
            <p><strong>ICP Match:</strong> ${briefing.at_a_glance?.icp_match_score || '?'}/10</p>
            <h3>Why We Targeted Them</h3><p>${briefing.why_targeted}</p>
            <h3>Pain Points</h3><ul>${painHtml}</ul>
            <h3>Discovery Questions</h3><ol>${questionsHtml}</ol>
            <h3>Competitive Notes</h3><p>${briefing.competitive_notes}</p>
          `,
        });
      }

      briefings++;
      results.push({ lead_id: lead.id, company: lead.company_name, icp_score: briefing.at_a_glance?.icp_match_score });
      log.success(`Briefing generated: ${lead.company_name}`);
    } catch (err) {
      log.error(`Briefing failed: ${lead.company_name}`, err);
    }
  }

  return { success: true, briefings, results };
}

module.exports = run;
