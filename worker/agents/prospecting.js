/**
 * Growth OS — Prospecting Agent (Serper + Claude)
 *
 * PER-TENANT. For the FGA tenant (self-prospecting) the business rules as of
 * 2026-04-20 are:
 *  - ONE industry per week, rotated from `target_industries` in tenant_config.
 *  - Target micro-businesses: 1–3 employees, **no website**, owner-operated.
 *  - Deliver 15 highly-qualified prospects.
 *  - Run Tuesdays 06:00 America/New_York (cron entry lives in worker/scheduler/cron.js).
 *
 * Other tenants can keep broader prospecting by overriding the relevant
 * tenant_config keys (see the CONFIG KEYS section below).
 *
 * CONFIG KEYS (tenant_config):
 *  - target_industries       array — rotated one-per-run
 *  - target_states           array of 2-letter state codes
 *  - prospecting_icp_notes   optional string — free-form extra ICP guidance
 *  - min_employees / max_employees  numeric size band
 *  - require_no_website      boolean (FGA default: true) — reject anything with a live site
 *  - daily_prospect_target / weekly_prospect_target  numeric — how many to insert
 *  - prospecting_industry_index  integer rotation counter (agent increments it)
 *  - score_threshold         numeric (default 60)
 *  - excluded_industries / excluded_keywords  array
 */

const axios = require('axios');
const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

const DEFAULT_SCORE_THRESHOLD = 60;
const DEFAULT_PROSPECT_TARGET = 15;

// ============================================================================
// HELPERS
// ============================================================================

function safeArray(v) { return Array.isArray(v) ? v : []; }
function normalizeState(value) { return value ? String(value).trim().toUpperCase() : null; }
function normalizeIndustry(value) { return value ? String(value).trim() : null; }

function stateName(abbr) {
  const map = {
    GA: 'Georgia', FL: 'Florida', NC: 'North Carolina', SC: 'South Carolina',
    TN: 'Tennessee', AL: 'Alabama', TX: 'Texas', VA: 'Virginia',
    CO: 'Colorado', IL: 'Illinois', NY: 'New York', CA: 'California',
  };
  return map[abbr] || abbr;
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
  if (n <= 3) return '1-3';
  if (n <= 10) return '4-10';
  if (n < 20) return '11-19';
  if (n < 50) return '20-50';
  return '50+';
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

function hasLiveWebsite(candidate) {
  const val = candidate.website;
  if (!val) return false;
  const s = String(val).trim().toLowerCase();
  if (!s) return false;
  // Facebook / Yelp / Nextdoor / Google Business listings don't count as a
  // real business website — these folks are still undigitized.
  const directoryPatterns = [
    'facebook.com', 'yelp.com', 'nextdoor.com', 'maps.google', 'g.page',
    'google.com/maps', 'bbb.org', 'angi.com', 'thumbtack.com', 'linkedin.com',
    'instagram.com', 'tiktok.com', 'yellowpages.com', 'manta.com',
  ];
  if (directoryPatterns.some(p => s.includes(p))) return false;
  return true;
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

/**
 * New scoring rubric optimized for FGA's micro-business ICP.
 * 100 points total:
 *   - 25: employee count 1–3 (0 if >3, +10 if unknown and other signals are strong)
 *   - 25: NO live website (hard requirement when require_no_website = true — see guard below)
 *   - 15: state in target list
 *   - 10: industry matches this week's focus industry
 *   -  8: phone number visible
 *   -  8: owner/decision-maker name + title captured
 *   -  5: has Google Business Profile / local listing (weak but positive signal)
 *   -  4: active (address, hours, or activity signals present)
 *   - -100: excluded keyword / industry
 */
function scoreCandidate(candidate, config) {
  let score = 0;
  const employees = Number(candidate.employee_count);
  const industry = normalizeIndustry(candidate.industry);
  const state = normalizeState(candidate.state);

  if (Number.isFinite(employees) && employees >= 1 && employees <= 3) score += 25;
  else if (!Number.isFinite(employees)) score += 8; // unknown — partial credit

  const hasSite = hasLiveWebsite(candidate);
  if (!hasSite) score += 25;
  // When require_no_website is true, having a website is a hard fail regardless of other signals.
  if (hasSite && config.requireNoWebsite) score -= 100;

  if (state && config.targetStates.includes(state)) score += 15;
  if (industry && config.targetIndustries.includes(industry)) score += 10;

  if (candidate.phone) score += 8;
  if (candidate.contact_name && candidate.contact_title) score += 8;
  if (candidate.google_business_profile_url || candidate.listed_in_google_maps) score += 5;
  if (candidate.address || candidate.hours_visible || candidate.last_activity_signal) score += 4;

  if (isExcludedCandidate(candidate, config)) score -= 100;

  return score;
}

// ============================================================================
// WEEKLY INDUSTRY ROTATION
// ============================================================================

/**
 * Pick THIS week's industry from `target_industries`, increment the counter
 * in tenant_config so next week rotates. If `target_industries` is empty,
 * throw — agent can't proceed without at least one industry.
 */
async function pickWeeklyIndustry(tenant, targetIndustries, log) {
  if (!targetIndustries.length) {
    throw new Error('target_industries is empty — set at least one industry in tenant_config');
  }
  const counterKey = 'prospecting_industry_index';
  const currentIndex = Number(getConfig(tenant, counterKey, 0)) || 0;
  const idx = currentIndex % targetIndustries.length;
  const industry = targetIndustries[idx];

  await db.from('tenant_config').upsert({
    tenant_id: tenant.id,
    key: counterKey,
    value: String((currentIndex + 1) % targetIndustries.length),
  }, { onConflict: 'tenant_id,key' });

  log.info(`This week's focus industry: ${industry} (index ${idx} of ${targetIndustries.length})`);
  return industry;
}

// ============================================================================
// SEARCH & EXTRACTION
// ============================================================================

/**
 * Build search queries optimized to surface 1-3 person, no-website businesses.
 * Emphasizes local-business directory signals (Google Maps, Yelp) where
 * micro-businesses without their own site tend to appear.
 */
function buildQueries(focusIndustry, targetStates, targetPerRun) {
  const queries = [];
  // Cap queries — too many wastes Serper budget.
  const perState = Math.max(2, Math.min(4, Math.ceil(targetPerRun / Math.max(1, targetStates.length))));
  for (const st of targetStates) {
    const stName = stateName(st);
    queries.push(
      `"${focusIndustry}" owner-operated ${stName} "no website"`,
      `small ${focusIndustry} business ${stName} site:facebook.com`,
      `${focusIndustry} ${stName} local google maps small business`,
      `"family-owned" ${focusIndustry} ${stName}`,
    );
    if (perState > 4) queries.push(`${focusIndustry} ${stName} yelp small business`);
  }
  return queries;
}

async function searchSerper(query, num = 10) {
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

async function extractCandidatesWithClaude(searchPayload, config, tenant, focusIndustry) {
  const businessName = getConfig(tenant, 'business_name', 'First Gen Automate');
  const icpNotes = getConfig(tenant, 'prospecting_icp_notes', '');

  const systemPrompt = 'You extract structured prospecting candidates from web search results. Return ONLY valid JSON.';

  const userPrompt = `
You are a prospecting scout for ${businessName}.

GOAL: Find very small, owner-operated ${focusIndustry} businesses that DO NOT have their own website.
These micro-businesses benefit most from the ${businessName} system because they're the most under-digitized.

TIGHT ICP (all must hold):
- 1–3 employees (often just the owner)
- NO live company website (Facebook pages, Yelp, Google listings are OK — those are NOT "real" websites for this purpose)
- Target states: ${config.targetStates.join(', ')}
- Industry this week: ${focusIndustry}
- Owner/decision-maker identified if possible (name + "Owner"/"Founder" title)

POSITIVE SIGNALS (record any you can find — they help qualify):
- Phone number visible
- Google Business Profile / Maps listing
- Active address and hours
- Recent reviews (even a few)
- Listed in local directories

HARD EXCLUSIONS (reject):
- Businesses in excluded industries: ${config.excludedIndustries.join(', ') || '(none)'}
- Anything matching excluded keywords: ${config.excludedKeywords.join(', ') || '(none)'}
- Large chains, franchises, Fortune 1000, PE-backed roll-ups
- Any business with a real company .com / .biz / .co / .net website (a live, owned domain)
${icpNotes ? `\nADDITIONAL TENANT GUIDANCE:\n${icpNotes}\n` : ''}

Return JSON only:
{
  "candidates": [
    {
      "company": "string",
      "website": "string or null (Facebook / Yelp / Google URLs are acceptable — anything else that looks like a real company website should cause you to REJECT the candidate)",
      "industry": "string — should equal or be a subtype of the focus industry",
      "state": "2-letter abbreviation or null",
      "employee_count": 2,
      "size": "1-3",
      "phone": "string or null",
      "address": "string or null",
      "hours_visible": true,
      "google_business_profile_url": "string or null",
      "listed_in_google_maps": true,
      "last_activity_signal": "e.g. 'reviews within last 90 days' or null",
      "contact_name": "string or null",
      "contact_title": "string or null",
      "contact_email": null,
      "contact_linkedin_url": null,
      "reason": "short explanation of why this is a good fit",
      "confidence": 0.0,
      "source_urls": ["https://..."]
    }
  ]
}

Rules:
- Only include candidates where the evidence in the search snippets actually supports the ICP.
- If the search result makes it obvious the business has its own real website, DO NOT include it.
- If employee count is unknown but the business is clearly small/owner-operated, set employee_count to null and size to "1-3" only when the snippet language implies solo/owner-operated.
- Confidence 0–1.

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
// DB OPERATIONS
// ============================================================================

async function insertLead(tenantId, candidate, score, focusIndustry) {
  const metadata = {
    reason: candidate.reason || null,
    source_urls: candidate.source_urls || [],
    prospect_score: score,
    confidence: candidate.confidence || null,
    focus_industry_week: focusIndustry,
    google_business_profile_url: candidate.google_business_profile_url || null,
    listed_in_google_maps: !!candidate.listed_in_google_maps,
    last_activity_signal: candidate.last_activity_signal || null,
    hours_visible: !!candidate.hours_visible,
    address: candidate.address || null,
  };

  const domain = candidate.website
    ? String(candidate.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    : null;

  const { data, error } = await db
    .from('leads')
    .insert({
      tenant_id: tenantId,
      company_name: candidate.company,
      industry: candidate.industry || focusIndustry,
      size: normalizeSize(candidate.employee_count, candidate.size),
      employee_count_actual: candidate.employee_count || null,
      website: candidate.website || null,
      domain,
      phone: candidate.phone || null,
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
  if (!candidate.contact_email && !candidate.contact_name && !candidate.contact_title && !candidate.phone) return null;

  const { first_name, last_name } = splitName(candidate.contact_name);

  const { data, error } = await db
    .from('contacts')
    .insert({
      tenant_id: tenantId,
      lead_id: leadId,
      first_name,
      last_name,
      title: candidate.contact_title || 'Owner',
      email: candidate.contact_email || null,
      phone: candidate.phone || null,
      linkedin_url: candidate.contact_linkedin_url || null,
      role_in_buying: 'decision_maker',
      is_primary_contact: true,
      contact_status: 'active',
      source: 'serper_claude'
    })
    .select()
    .single();

  if (error) return null; // Non-fatal
  return data;
}

async function leadAlreadyExists(tenantId, candidate) {
  const { data: byName } = await db
    .from('leads')
    .select('id, company_name')
    .eq('tenant_id', tenantId)
    .eq('company_name', candidate.company)
    .maybeSingle();
  if (byName) return byName;

  if (candidate.website) {
    const domain = String(candidate.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const { data: byDomain } = await db
      .from('leads')
      .select('id, company_name')
      .eq('tenant_id', tenantId)
      .eq('domain', domain)
      .maybeSingle();
    if (byDomain) return byDomain;
  }
  if (candidate.phone) {
    const { data: byPhone } = await db
      .from('leads')
      .select('id, company_name')
      .eq('tenant_id', tenantId)
      .eq('phone', candidate.phone)
      .maybeSingle();
    if (byPhone) return byPhone;
  }
  return null;
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit, industry (override weekly rotation) }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('prospecting', tenant.slug);

  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is required');

  const targetStates = safeArray(getConfig(tenant, 'target_states', [])).map(normalizeState);
  const targetIndustries = safeArray(getConfig(tenant, 'target_industries', [])).map(normalizeIndustry);
  const excludedIndustries = safeArray(getConfig(tenant, 'excluded_industries', [])).map(normalizeIndustry);
  const excludedKeywords = safeArray(getConfig(tenant, 'excluded_keywords', []));
  const minEmployees = Number(getConfig(tenant, 'min_employees', 1));
  const maxEmployees = Number(getConfig(tenant, 'max_employees', 3));
  const requireNoWebsite = Boolean(getConfig(tenant, 'require_no_website', true));
  const scoreThreshold = Number(getConfig(tenant, 'score_threshold', DEFAULT_SCORE_THRESHOLD));
  const weeklyTarget = Number(
    payload.limit ||
    getConfig(tenant, 'weekly_prospect_target',
      getConfig(tenant, 'daily_prospect_target', DEFAULT_PROSPECT_TARGET))
  );

  if (!targetStates.length) {
    throw new Error('Missing required ICP configuration: target_states');
  }
  if (!targetIndustries.length) {
    throw new Error('Missing required ICP configuration: target_industries');
  }

  // Resolve THIS WEEK's focus industry. Payload.industry can override for one-off runs.
  let focusIndustry;
  if (payload.industry) {
    focusIndustry = normalizeIndustry(payload.industry);
    log.info(`Using override industry: ${focusIndustry}`);
  } else {
    focusIndustry = await pickWeeklyIndustry(tenant, targetIndustries, log);
  }

  const config = {
    targetStates,
    targetIndustries,
    excludedIndustries,
    excludedKeywords,
    minEmployees,
    maxEmployees,
    requireNoWebsite,
    weeklyTarget,
  };

  log.info('Starting weekly prospecting run', { focusIndustry, ...config });

  // Build and execute search queries
  const queries = buildQueries(focusIndustry, targetStates, weeklyTarget);
  const allSearchResults = [];

  for (const query of queries) {
    try {
      const searchData = await searchSerper(query, 10);
      allSearchResults.push({
        query,
        organic: searchData.organic || [],
        places: searchData.places || [],
        knowledgeGraph: searchData.knowledgeGraph || null,
      });
    } catch (err) {
      log.warn(`Serper query failed: ${query}`, { error: err.message });
    }
  }

  if (!allSearchResults.length) {
    return { success: true, inserted: 0, skipped: 0, processed: [], errors: ['No search results returned'] };
  }

  // Extract with Claude
  const extracted = await extractCandidatesWithClaude({ results: allSearchResults }, config, tenant, focusIndustry);
  const filtered = extracted
    .filter(c => c && c.company)
    .filter(c => !isExcludedCandidate(c, config))
    .filter(c => !(requireNoWebsite && hasLiveWebsite(c)));  // extra defense in depth — Claude sometimes slips these through

  const deduped = uniqueBy(filtered, c => (c.website || c.company).toLowerCase());

  let inserted = 0;
  let skipped = 0;
  const processed = [];
  const errors = [];

  // Sort by score so we insert the best first and stop when we hit the target.
  const scoredCandidates = deduped
    .map(c => ({ candidate: c, score: scoreCandidate(c, config) }))
    .sort((a, b) => b.score - a.score);

  for (const { candidate, score } of scoredCandidates) {
    if (inserted >= weeklyTarget) {
      processed.push({ company: candidate.company, action: 'capped_weekly_target', score });
      skipped++;
      continue;
    }
    try {
      if (score < scoreThreshold) {
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

      const lead = await insertLead(tenant.id, candidate, score, focusIndustry);
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
    focus_industry: focusIndustry,
    weekly_target: weeklyTarget,
    inserted,
    skipped,
    processed,
    errors,
    query_count: queries.length,
    raw_candidates: extracted.length,
    filtered_candidates: filtered.length,
    deduped_candidates: deduped.length,
  };

  log.success('Prospecting run completed', {
    focus_industry: focusIndustry,
    inserted,
    skipped,
    errors: errors.length,
  });
  return result;
}

module.exports = run;
