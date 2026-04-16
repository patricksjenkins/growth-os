/**
 * Growth OS — Prospecting Agent (Serper + OpenAI Hybrid)
 * Finds real companies via web search, extracts/filters against tenant ICP,
 * and inserts qualified prospects into leads + contacts tables.
 *
 * Multi-tenant: ICP config from tenant_config via getConfig().
 */

const axios = require('axios');
const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

const SCORE_THRESHOLD = 40;

// ============================================================================
// HELPERS
// ============================================================================

function safeArray(v) { return Array.isArray(v) ? v : []; }

function normalizeState(value) {
  return value ? String(value).trim().toUpperCase() : null;
}

function normalizeIndustry(value) {
  return value ? String(value).trim() : null;
}

function stateName(abbr) {
  const map = {
    GA: 'Georgia', FL: 'Florida', NC: 'North Carolina', SC: 'South Carolina',
    TN: 'Tennessee', AL: 'Alabama', TX: 'Texas', VA: 'Virginia',
    CO: 'Colorado', IL: 'Illinois'
  };
  return map[abbr] || abbr;
}

function stripCodeFences(text) {
  if (!text) return text;
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}

function splitName(fullName) {
  if (!fullName) return { first_name: null, last_name: null };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: null };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

function normalizeSize(employeeCount, existingSize = null) {
  if (existingSize) return String(existingSize);
  const n = Number(employeeCount);
  if (!Number.isFinite(n)) return null;
  if (n >= 20 && n < 50) return '20-50';
  if (n >= 50 && n < 100) return '50-100';
  if (n >= 100 && n < 150) return '100-150';
  if (n >= 150 && n < 250) return '150-250';
  if (n >= 250 && n < 500) return '250-500';
  return '<20';
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// EXCLUSION & SCORING
// ============================================================================

function textContainsExcludedKeyword(candidate, excludedKeywords) {
  const haystack = [candidate.company, candidate.industry, candidate.reason, candidate.website]
    .filter(Boolean).join(' ').toLowerCase();
  return excludedKeywords.some(kw => haystack.includes(String(kw).toLowerCase()));
}

function isExcludedCandidate(candidate, config) {
  const industry = normalizeIndustry(candidate.industry);
  if (industry && config.excludedIndustries.includes(industry)) return true;
  if (textContainsExcludedKeyword(candidate, config.excludedKeywords)) return true;
  return false;
}

function scoreCandidate(candidate, config) {
  let score = 0;
  const employees = Number(candidate.employee_count || 0);
  const industry = normalizeIndustry(candidate.industry);
  const state = normalizeState(candidate.state);

  if (Number.isFinite(employees) && employees >= config.minEmployees && employees <= config.maxEmployees) {
    score += 30;
  } else if (!candidate.employee_count) {
    score += 10;
  }

  if (industry && config.targetIndustries.includes(industry)) score += 20;
  if (state && config.targetStates.includes(state)) score += 15;
  if (candidate.growth_signal) score += 15;
  if (candidate.contact_title) score += 10;
  if (candidate.website) score += 5;
  if (isExcludedCandidate(candidate, config)) score -= 100;

  return score;
}

// ============================================================================
// SEARCH & EXTRACTION
// ============================================================================

function buildQueries(targetStates, targetIndustries, dailyLimit) {
  const queries = [];
  const maxQueries = Math.min(12, Math.max(4, Math.ceil(dailyLimit / 2)));

  for (const st of targetStates) {
    for (const industry of targetIndustries) {
      queries.push(
        `"${industry}" company in ${stateName(st)} employees HR benefits`,
        `${industry} business ${stateName(st)} founder CEO operations team`
      );
    }
  }

  return queries.slice(0, maxQueries);
}

async function searchSerper(query, num = 8) {
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

async function extractCandidatesWithClaude(searchPayload, config, tenant) {
  const businessName = getConfig(tenant, 'business_name', 'Our Company');

  const systemPrompt = 'You extract structured prospecting candidates from web search results. Return only valid JSON.';

  const userPrompt = `
You are a prospecting scout for ${businessName}.

Your job: Identify real companies from the search results that may be strong prospects.

Target ICP:
- ${config.minEmployees} to ${config.maxEmployees} employees is ideal
- Target states: ${config.targetStates.join(', ')}
- Target industries: ${config.targetIndustries.join(', ')}
- Focus on small, owner-operated service businesses
- Avoid Fortune 1000 or obviously huge enterprises
- Prefer companies showing growth, hiring, or operational complexity
- Try to identify the owner or decision-maker (Founder, Owner, CEO)

IMPORTANT EXCLUSIONS:
Do NOT include companies in excluded industries: ${config.excludedIndustries.join(', ')}
Excluded keywords: ${config.excludedKeywords.join(', ')}

Return JSON only:
{
  "candidates": [
    {
      "company": "string",
      "website": "string or null",
      "industry": "string or null",
      "state": "2-letter abbreviation or null",
      "employee_count": 50,
      "size": "1-10",
      "growth_signal": true,
      "contact_name": "string or null",
      "contact_title": "string or null",
      "contact_email": null,
      "contact_linkedin_url": null,
      "reason": "short explanation",
      "confidence": 0.0,
      "source_urls": ["https://..."]
    }
  ]
}

Rules:
- Only include candidates with reasonable evidence from titles/snippets/links.
- If employee count is unknown, set employee_count to null.
- Confidence between 0 and 1.

Search results JSON:
${JSON.stringify(searchPayload)}
`;

  const result = await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 4000,
    tenantSlug: tenant.slug
  });

  return safeArray(result.candidates);
}

// ============================================================================
// DB OPERATIONS (tenant-scoped)
// ============================================================================

async function insertLead(tenantId, candidate, score) {
  const metadata = {
    reason: candidate.reason || null,
    source_urls: candidate.source_urls || [],
    prospect_score: score,
    confidence: candidate.confidence || null
  };

  const { data, error } = await db
    .from('leads')
    .insert({
      tenant_id: tenantId,
      company_name: candidate.company,
      industry: candidate.industry || null,
      size: normalizeSize(candidate.employee_count, candidate.size),
      employee_count_actual: candidate.employee_count || null,
      website: candidate.website || null,
      domain: candidate.website ? candidate.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : null,
      hq_state: normalizeState(candidate.state),
      status: 'new_lead',
      lifecycle_stage: 'prospect',
      lead_source: 'prospecting_agent',
      enrichment_status: 'pending',
      metadata
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function insertContact(tenantId, leadId, candidate) {
  if (!candidate.contact_email && !candidate.contact_name && !candidate.contact_title) return null;

  const { first_name, last_name } = splitName(candidate.contact_name);

  const { data, error } = await db
    .from('contacts')
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      first_name,
      last_name,
      title: candidate.contact_title || null,
      email: candidate.contact_email || null,
      linkedin_url: candidate.contact_linkedin_url || null,
      role_in_buying: 'decision_maker',
      is_primary_contact: true,
      contact_status: 'active',
      source: 'serper_openai'
    })
    .select()
    .single();

  if (error) {
    // Non-fatal — log and continue
    return null;
  }
  return data;
}

async function leadAlreadyExists(tenantId, candidate) {
  // Check by company name
  const { data: byName } = await db
    .from('leads')
    .select('id, company_name')
    .eq('tenant_id', tenantId)
    .eq('company_name', candidate.company)
    .maybeSingle();

  if (byName) return byName;

  // Check by domain
  if (candidate.website) {
    const domain = candidate.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const { data: byDomain } = await db
      .from('leads')
      .select('id, company_name')
      .eq('tenant_id', tenantId)
      .eq('domain', domain)
      .maybeSingle();

    if (byDomain) return byDomain;
  }

  return null;
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('prospecting', tenant.slug);

  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is required');

  const targetStates = safeArray(getConfig(tenant, 'target_states', [])).map(normalizeState);
  const targetIndustries = safeArray(getConfig(tenant, 'target_industries', [])).map(normalizeIndustry);
  const excludedIndustries = safeArray(getConfig(tenant, 'excluded_industries', [])).map(normalizeIndustry);
  const excludedKeywords = safeArray(getConfig(tenant, 'excluded_keywords', []));
  const minEmployees = Number(getConfig(tenant, 'min_employees', 20));
  const maxEmployees = Number(getConfig(tenant, 'max_employees', 150));
  const dailyLimit = Number(payload.limit || getConfig(tenant, 'daily_prospect_target', 25));

  if (!targetStates.length || !targetIndustries.length) {
    throw new Error('Missing required ICP configuration: target_states and target_industries');
  }

  const config = {
    targetStates, targetIndustries, excludedIndustries, excludedKeywords,
    minEmployees, maxEmployees, dailyLimit
  };

  log.info('Starting prospecting run', config);

  // Build and execute search queries
  const queries = buildQueries(config.targetStates, config.targetIndustries, dailyLimit);
  const allSearchResults = [];

  for (const query of queries) {
    try {
      const searchData = await searchSerper(query, 8);
      allSearchResults.push({
        query,
        organic: searchData.organic || [],
        knowledgeGraph: searchData.knowledgeGraph || null,
        answerBox: searchData.answerBox || null
      });
    } catch (err) {
      log.warn(`Serper query failed: ${query}`, { error: err.message });
    }
  }

  if (!allSearchResults.length) {
    return { success: true, inserted: 0, skipped: 0, processed: [], errors: ['No search results returned'] };
  }

  // Extract candidates with OpenAI
  const extracted = await extractCandidatesWithClaude({ results: allSearchResults }, config, tenant);
  const filtered = extracted.filter(c => !isExcludedCandidate(c, config));
  const deduped = uniqueBy(filtered.filter(c => c && c.company), c => (c.website || c.company).toLowerCase());

  let inserted = 0;
  let skipped = 0;
  const processed = [];
  const errors = [];

  for (const candidate of deduped) {
    try {
      const score = scoreCandidate(candidate, config);

      if (score < SCORE_THRESHOLD) {
        skipped++;
        processed.push({ company: candidate.company, action: 'skipped_low_score', score });
        continue;
      }

      const existing = await leadAlreadyExists(tenant.id, candidate);
      if (existing) {
        skipped++;
        processed.push({ company: candidate.company, action: 'duplicate', score, existing_lead_id: existing.id });
        continue;
      }

      const lead = await insertLead(tenant.id, candidate, score);
      const contact = await insertContact(tenant.id, lead.id, candidate);

      inserted++;
      processed.push({
        company: candidate.company,
        action: 'inserted',
        score,
        lead_id: lead.id,
        contact_id: contact ? contact.id : null
      });

      log.info('Inserted prospect', { company: candidate.company, score, lead_id: lead.id });
    } catch (err) {
      log.error('Candidate processing failed', err);
      errors.push({ company: candidate.company || null, error: err.message });
    }
  }

  const result = {
    success: true,
    inserted,
    skipped,
    processed,
    errors,
    query_count: queries.length,
    raw_candidates: extracted.length,
    filtered_candidates: filtered.length,
    deduped_candidates: deduped.length
  };

  log.success('Prospecting run completed', result);
  return result;
}

module.exports = run;
