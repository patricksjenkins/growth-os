/**
 * Growth OS — Enrichment Agent
 * Enriches prospect-stage leads with web research data.
 *
 * Uses Serper for web search + Claude for structured extraction.
 * Updates leads with industry, size, hq_state, employee_count_actual,
 * and any contacts found.
 *
 * Multi-tenant: all queries scoped by tenant_id.
 */

const axios = require('axios');
const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// ============================================================================
// HELPERS
// ============================================================================

function splitName(fullName) {
  if (!fullName) return { first_name: null, last_name: null };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function normalizeSize(employeeCount) {
  const n = Number(employeeCount);
  if (!Number.isFinite(n)) return null;
  if (n < 20) return '<20';
  if (n < 50) return '20-50';
  if (n < 100) return '50-100';
  if (n < 150) return '100-150';
  if (n < 250) return '150-250';
  if (n < 500) return '250-500';
  return '500+';
}

// ============================================================================
// SEARCH & EXTRACTION
// ============================================================================

async function searchSerper(query, num = 5) {
  const response = await axios.post(
    'https://google.serper.dev/search',
    { q: query, num, gl: 'us', hl: 'en' },
    {
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );
  return response.data || {};
}

async function enrichWithClaude(lead, searchResults, tenant) {
  const systemPrompt = 'You extract structured B2B company data from web search results. Return only valid JSON.';

  const userPrompt = `
You are a B2B company research assistant. Given a company name and web search results,
extract structured company intelligence data.

Company: ${lead.company_name}
${lead.website ? `Known website: ${lead.website}` : ''}
${lead.industry ? `Known industry: ${lead.industry}` : ''}

Return JSON only:
{
  "company_name": "verified company name",
  "industry": "specific industry category",
  "employee_count": 75,
  "size": "50-100",
  "hq_state": "GA",
  "website": "https://example.com",
  "domain": "example.com",
  "description": "1-2 sentence company description",
  "growth_signals": ["hiring", "expansion", "new office"],
  "benefits_signals": ["growing team", "multi-location"],
  "contacts": [
    {
      "name": "John Doe",
      "title": "CEO",
      "email": null,
      "linkedin_url": null,
      "role": "decision_maker"
    }
  ],
  "confidence": 0.85,
  "notes": "Key research findings in 1-2 sentences"
}

Rules:
- employee_count: best estimate as integer, or null if unknown
- size: one of "<20", "20-50", "50-100", "100-150", "150-250", "250-500", "500+"
- hq_state: 2-letter US state abbreviation, or null
- confidence: 0 to 1 based on data quality
- contacts.role: one of "decision_maker", "influencer", "champion", "user"
- JSON only. No markdown.

Search results:
${JSON.stringify(searchResults)}
`;

  return await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 2000,
    tenantSlug: tenant.slug
  });
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit, lead_id }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('enrichment', tenant.slug);

  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is required');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');

  const limit = Number(payload.limit || 10);

  // If a specific lead_id is provided, enrich just that one
  let leadsQuery = db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('lifecycle_stage', 'prospect')
    .in('enrichment_status', ['pending', null])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (payload.lead_id) {
    leadsQuery = db
      .from('leads')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('id', payload.lead_id);
  }

  const { data: leads, error: fetchErr } = await leadsQuery;
  if (fetchErr) throw fetchErr;

  if (!leads || leads.length === 0) {
    log.info('No leads to enrich');
    return { success: true, enriched: 0, message: 'No leads pending enrichment' };
  }

  log.info(`Enriching ${leads.length} leads`);

  let enriched = 0;
  let failed = 0;
  const processed = [];
  const errors = [];

  for (const lead of leads) {
    try {
      // Mark as processing
      await db.from('leads').update({ enrichment_status: 'enriching' }).eq('id', lead.id).eq('tenant_id', tenant.id);

      // Search for company data
      const searchQuery = `${lead.company_name} ${lead.hq_state ? lead.hq_state : ''} company employees about`;
      const searchResults = await searchSerper(searchQuery, 5);

      // Extract structured data
      const enrichment = await enrichWithClaude(lead, searchResults, tenant);

      // Build update payload — only update fields that were null/empty
      const updates = {
        enrichment_status: 'enriched',
        enriched_at: new Date().toISOString(),
        lifecycle_stage: 'enriched',
        updated_at: new Date().toISOString()
      };

      if (enrichment.industry && !lead.industry) updates.industry = enrichment.industry;
      if (enrichment.employee_count && !lead.employee_count_actual) updates.employee_count_actual = enrichment.employee_count;
      if (enrichment.size && !lead.size) updates.size = enrichment.size || normalizeSize(enrichment.employee_count);
      if (enrichment.hq_state && !lead.hq_state) updates.hq_state = enrichment.hq_state;
      if (enrichment.website && !lead.website) updates.website = enrichment.website;
      if (enrichment.domain && !lead.domain) updates.domain = enrichment.domain;

      // Merge enrichment data into metadata
      updates.metadata = {
        ...(lead.metadata || {}),
        enrichment_confidence: enrichment.confidence || null,
        growth_signals: enrichment.growth_signals || [],
        benefits_signals: enrichment.benefits_signals || [],
        enrichment_notes: enrichment.notes || null,
        enrichment_description: enrichment.description || null
      };

      await db.from('leads').update(updates).eq('id', lead.id).eq('tenant_id', tenant.id);

      // Insert any contacts found
      const contacts = enrichment.contacts || [];
      let contactsInserted = 0;

      for (const contact of contacts) {
        if (!contact.name && !contact.title) continue;

        const { first_name, last_name } = splitName(contact.name);

        const { error: contactErr } = await db.from('contacts').insert({
          tenant_id: tenant.id,
          lead_id: lead.id,
          first_name,
          last_name,
          title: contact.title || null,
          email: contact.email || null,
          linkedin_url: contact.linkedin_url || null,
          role_in_buying: contact.role || 'decision_maker',
          is_primary_contact: contactsInserted === 0,
          contact_status: 'active',
          source: 'serper_claude'
        });

        if (!contactErr) contactsInserted++;
      }

      enriched++;
      processed.push({
        lead_id: lead.id,
        company: lead.company_name,
        confidence: enrichment.confidence,
        contacts_added: contactsInserted
      });

      log.info('Enriched lead', { company: lead.company_name, confidence: enrichment.confidence });
    } catch (err) {
      failed++;
      log.error(`Enrichment failed for ${lead.company_name}`, err);

      await db.from('leads')
        .update({ enrichment_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', lead.id).eq('tenant_id', tenant.id);

      errors.push({ lead_id: lead.id, company: lead.company_name, error: err.message });
    }
  }

  const result = { success: true, enriched, failed, processed, errors };
  log.success('Enrichment run completed', result);
  return result;
}

module.exports = run;
