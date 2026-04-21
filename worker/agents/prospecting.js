/**
 * Growth OS — Prospecting Agent (Daily top-up-to-15 mode)
 *
 * DESIGN (2026-04-21 — Patrick):
 *  - Runs DAILY at 06:00 America/New_York (Mon-Sun).
 *  - Every week has ONE focus industry. Rotation advances on TUESDAY only
 *    (the start of the business week for this ICP).
 *  - Goal: 15 *qualified* leads per week. "Qualified" = passed ICP hard
 *    filters AND enrichment found EITHER email OR Facebook URL (so Patrick
 *    can actually reach them via email-first / FB-DM fallback).
 *  - Each daily run:
 *      1. Count qualified leads already inserted this week for this industry.
 *      2. If >= 15, no-op.
 *      3. Otherwise, search Serper, extract candidates, enrich each INLINE
 *         via enrichment.enrichOne(), count only the ones that enrichment
 *         qualifies. Stop when the week hits 15.
 *  - Hard cap per day on candidates processed (SERPER + Claude budget).
 *
 * Configuration (tenant_config):
 *  - target_industries              array, rotated one per week
 *  - target_states                  array (2-letter codes)
 *  - min_employees, max_employees   size band (defaults 1,3)
 *  - require_no_website             boolean (default true)
 *  - weekly_prospect_target         int (default 15)
 *  - daily_candidate_cap            int (default 40) — max candidates processed/day
 *  - score_threshold                int (default 50)
 *  - prospecting_industry_index     rotation counter (advances Tuesday)
 *  - prospecting_week_start         ISO date — the Tuesday this week began
 *  - excluded_industries, excluded_keywords
 *  - prospecting_icp_notes          free-form LLM guidance
 */

const axios = require('axios');
const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const enrichment = require('./enrichment');

const DEFAULT_SCORE_THRESHOLD = 50;
const DEFAULT_WEEKLY_TARGET = 15;
const DEFAULT_DAILY_CANDIDATE_CAP = 40;

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
  const directoryPatterns = [
    'facebook.com', 'yelp.com', 'nextdoor.com', 'maps.google', 'g.page',
    'google.com/maps', 'bbb.org', 'angi.com', 'thumbtack.com', 'linkedin.com',
    'instagram.com', 'tiktok.com', 'yellowpages.com', 'manta.com',
  ];
  if (directoryPatterns.some(p => s.includes(p))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Week boundary + rotation
// ---------------------------------------------------------------------------

/**
 * Returns the ISO date string of the most recent Tuesday at or before today
 * in America/New_York. The "week" for prospecting runs Tue 00:00 ET to the
 * next Mon 23:59 ET.
 */
function currentWeekStartTuesdayET() {
  // Build a Date representing "now" in ET. Node on Railway is UTC, so we
  // shift via Intl.
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  // getDay(): 0=Sun 1=Mon 2=Tue ... 6=Sat. We want to go back to most recent
  // Tuesday (inclusive). If today is Tue, offset = 0.
  const dow = et.getDay();
  const daysBack = (dow - 2 + 7) % 7;
  const tue = new Date(et);
  tue.setDate(et.getDate() - daysBack);
  tue.setHours(0, 0, 0, 0);
  return tue.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Advance the industry rotation counter IF the stored week_start differs
 * from the current one (new Tuesday has arrived). Returns the focus industry
 * for THIS week.
 */
async function resolveWeeklyFocusIndustry(tenant, targetIndustries, log) {
  if (!targetIndustries.length) {
    throw new Error('target_industries is empty — set at least one industry in tenant_config');
  }

  const storedWeekStart = getConfig(tenant, 'prospecting_week_start', null);
  const currentWeekStart = currentWeekStartTuesdayET();
  const isNewWeek = storedWeekStart !== currentWeekStart;

  let index = Number(getConfig(tenant, 'prospecting_industry_index', 0)) || 0;

  if (isNewWeek) {
    // A new week has started — advance the rotation.
    const previousIndex = index;
    index = (index + (storedWeekStart ? 1 : 0)) % targetIndustries.length;
    // On very first run (storedWeekStart null) we keep index as-is at 0.
    await db.from('tenant_config').upsert(
      [
        { tenant_id: tenant.id, key: 'prospecting_industry_index', value: String(index) },
        { tenant_id: tenant.id, key: 'prospecting_week_start', value: currentWeekStart },
      ],
      { onConflict: 'tenant_id,key' },
    );
    log.info(
      `New week: ${currentWeekStart}. Advancing industry index ${previousIndex} -> ${index}`,
    );
  } else {
    log.info(`Same week (${currentWeekStart}). Industry index stays at ${index}.`);
  }

  const industry = targetIndustries[index % targetIndustries.length];
  log.info(`This week's focus industry: ${industry}`);
  return { industry, weekStart: currentWeekStart, indexUsed: index };
}

// ---------------------------------------------------------------------------
// Qualified-this-week count
// ---------------------------------------------------------------------------

async function countQualifiedThisWeek(tenantId, weekStart, focusIndustry) {
  // "Qualified" = lead was inserted this week AND enrichment produced either
  // an email (leads.contacts.email exists) OR a facebook_url in metadata.
  // Cheap query: count leads inserted this week for this focus industry
  // whose lifecycle_stage is 'enriched' or later.
  const since = new Date(`${weekStart}T00:00:00-05:00`).toISOString(); // ET-ish
  const { data, error } = await db
    .from('leads')
    .select('id, metadata, lifecycle_stage')
    .eq('tenant_id', tenantId)
    .eq('lead_source', 'prospecting_agent')
    .gte('created_at', since)
    .in('lifecycle_stage', ['enriched', 'scored', 'sequenced']);

  if (error) throw error;

  const filtered = (data || []).filter((l) => {
    const md = l.metadata || {};
    return (
      md.focus_industry_week === focusIndustry &&
      Array.isArray(md.contact_channels_found) &&
      md.contact_channels_found.length > 0
    );
  });
  return filtered.length;
}

// ---------------------------------------------------------------------------
// Scoring (same rubric as before)
// ---------------------------------------------------------------------------

function textContainsExcludedKeyword(c, kws) {
  const haystack = [c.company, c.industry, c.reason, c.website]
    .filter(Boolean).join(' ').toLowerCase();
  return kws.some((kw) => haystack.includes(String(kw).toLowerCase()));
}

function isExcludedCandidate(c, config) {
  const industry = normalizeIndustry(c.industry);
  if (industry && config.excludedIndustries.includes(industry)) return true;
  if (textContainsExcludedKeyword(c, config.excludedKeywords)) return true;
  return false;
}

function scoreCandidate(c, config) {
  let score = 0;
  const employees = Number(c.employee_count);
  const industry = normalizeIndustry(c.industry);
  const state = normalizeState(c.state);

  if (Number.isFinite(employees) && employees >= 1 && employees <= 3) score += 25;
  else if (!Number.isFinite(employees)) score += 8;

  const hasSite = hasLiveWebsite(c);
  if (!hasSite) score += 25;
  if (hasSite && config.requireNoWebsite) score -= 100;

  if (state && config.targetStates.includes(state)) score += 15;
  if (industry && config.targetIndustries.includes(industry)) score += 10;

  if (c.phone) score += 8;
  if (c.contact_name && c.contact_title) score += 8;
  if (c.google_business_profile_url || c.listed_in_google_maps) score += 5;
  if (c.address || c.hours_visible || c.last_activity_signal) score += 4;

  if (isExcludedCandidate(c, config)) score -= 100;
  return score;
}

// ---------------------------------------------------------------------------
// Discovery: find candidate businesses via Serper + Claude
// ---------------------------------------------------------------------------

function buildDiscoveryQueries(focusIndustry, targetStates) {
  const queries = [];
  for (const st of targetStates) {
    const n = stateName(st);
    queries.push(
      `"${focusIndustry}" owner-operated ${n} "no website"`,
      `small ${focusIndustry} business ${n} site:facebook.com`,
      `${focusIndustry} ${n} local google maps small business`,
      `"family-owned" ${focusIndustry} ${n}`,
    );
  }
  return queries;
}

async function searchSerper(query, num = 10) {
  const response = await axios.post(
    'https://google.serper.dev/search',
    { q: query, num, gl: 'us', hl: 'en' },
    {
      headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
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

TIGHT ICP (all must hold):
- 1–3 employees
- NO live company website (Facebook / Yelp / Google listings are OK)
- Target states: ${config.targetStates.join(', ')}
- Industry this week: ${focusIndustry}

HARD EXCLUSIONS:
- Industries: ${config.excludedIndustries.join(', ') || '(none)'}
- Keywords: ${config.excludedKeywords.join(', ') || '(none)'}
- Fortune 1000 / franchises / large chains / PE-backed roll-ups
- Anything with a live .com / .biz / .co / .net website
${icpNotes ? `\nADDITIONAL TENANT GUIDANCE:\n${icpNotes}\n` : ''}

Return JSON:
{
  "candidates": [
    {
      "company": "string",
      "website": "string or null",
      "industry": "string",
      "state": "2-letter abbreviation or null",
      "employee_count": 2,
      "size": "1-3",
      "phone": "string or null",
      "address": "string or null",
      "hours_visible": true,
      "google_business_profile_url": "string or null",
      "listed_in_google_maps": true,
      "last_activity_signal": "string or null",
      "contact_name": "string or null",
      "contact_title": "string or null",
      "reason": "short explanation",
      "confidence": 0.0,
      "source_urls": ["https://..."]
    }
  ]
}

Rules:
- If a business obviously has a real company website, DO NOT include it.
- Confidence 0–1.
- JSON only.

Search results:
${JSON.stringify(searchPayload)}
`;

  const result = await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 4000,
    tenantSlug: tenant.slug,
  });
  return safeArray(result.candidates);
}

// ---------------------------------------------------------------------------
// DB: insert lead shell (enrichment runs on it right after)
// ---------------------------------------------------------------------------

async function insertLeadShell(tenantId, candidate, score, focusIndustry, weekStart) {
  const metadata = {
    reason: candidate.reason || null,
    source_urls: candidate.source_urls || [],
    prospect_score: score,
    confidence: candidate.confidence || null,
    focus_industry_week: focusIndustry,
    prospecting_week_start: weekStart,
    google_business_profile_url: candidate.google_business_profile_url || null,
    listed_in_google_maps: !!candidate.listed_in_google_maps,
    last_activity_signal: candidate.last_activity_signal || null,
    hours_visible: !!candidate.hours_visible,
    address: candidate.address || null,
    owner_name: candidate.contact_name || null,
  };

  const domain = candidate.website
    ? String(candidate.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    : null;

  const leadName = candidate.contact_name || candidate.company;

  const { data, error } = await db
    .from('leads')
    .insert({
      tenant_id: tenantId,
      name: leadName,
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
      metadata,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function leadAlreadyExists(tenantId, candidate) {
  const { data: byName } = await db
    .from('leads')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('company_name', candidate.company)
    .maybeSingle();
  if (byName) return byName;

  if (candidate.website) {
    const domain = String(candidate.website)
      .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const { data: byDomain } = await db
      .from('leads')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('domain', domain)
      .maybeSingle();
    if (byDomain) return byDomain;
  }
  if (candidate.phone) {
    const { data: byPhone } = await db
      .from('leads')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('phone', candidate.phone)
      .maybeSingle();
    if (byPhone) return byPhone;
  }
  return null;
}

// ============================================================================
// MAIN AGENT — daily top-up-to-15
// ============================================================================

async function run(tenant, payload = {}) {
  const log = createLogger('prospecting', tenant.slug);

  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is required');

  const targetStates = safeArray(getConfig(tenant, 'target_states', [])).map(normalizeState);
  const targetIndustries = safeArray(getConfig(tenant, 'target_industries', [])).map(normalizeIndustry);
  const excludedIndustries = safeArray(getConfig(tenant, 'excluded_industries', [])).map(normalizeIndustry);
  const excludedKeywords = safeArray(getConfig(tenant, 'excluded_keywords', []));
  const requireNoWebsite = Boolean(getConfig(tenant, 'require_no_website', true));
  const scoreThreshold = Number(getConfig(tenant, 'score_threshold', DEFAULT_SCORE_THRESHOLD));
  const weeklyTarget = Number(getConfig(tenant, 'weekly_prospect_target', DEFAULT_WEEKLY_TARGET));
  const dailyCandidateCap = Number(
    payload.daily_cap || getConfig(tenant, 'daily_candidate_cap', DEFAULT_DAILY_CANDIDATE_CAP)
  );

  if (!targetStates.length) throw new Error('Missing required ICP configuration: target_states');
  if (!targetIndustries.length) throw new Error('Missing required ICP configuration: target_industries');

  // Resolve this week's focus industry (advances on Tue; override via payload)
  let focusIndustry, weekStart;
  if (payload.industry) {
    focusIndustry = normalizeIndustry(payload.industry);
    weekStart = currentWeekStartTuesdayET();
    log.info(`Override industry: ${focusIndustry} (week ${weekStart})`);
  } else {
    const r = await resolveWeeklyFocusIndustry(tenant, targetIndustries, log);
    focusIndustry = r.industry;
    weekStart = r.weekStart;
  }

  // How many qualified leads already inserted this week? If we're at target, stop.
  const alreadyQualified = await countQualifiedThisWeek(tenant.id, weekStart, focusIndustry);
  const needed = Math.max(0, weeklyTarget - alreadyQualified);
  log.info(
    `Weekly target=${weeklyTarget} already_qualified=${alreadyQualified} needed=${needed}`
  );
  if (needed === 0) {
    return {
      success: true,
      focus_industry: focusIndustry,
      week_start: weekStart,
      already_qualified: alreadyQualified,
      needed: 0,
      newly_qualified: 0,
      message: 'Weekly target already met — no-op',
    };
  }

  // Search + extract
  const config = {
    targetStates, targetIndustries, excludedIndustries, excludedKeywords,
    requireNoWebsite, weeklyTarget,
  };
  const queries = buildDiscoveryQueries(focusIndustry, targetStates);
  const allResults = [];
  for (const q of queries) {
    try {
      const d = await searchSerper(q, 10);
      allResults.push({
        query: q,
        organic: d.organic || [],
        places: d.places || [],
        knowledgeGraph: d.knowledgeGraph || null,
      });
    } catch (err) {
      log.warn(`Serper discovery failed: ${q}`, { error: err.message });
    }
  }

  const extracted = await extractCandidatesWithClaude(
    { results: allResults }, config, tenant, focusIndustry
  );

  // Filter + dedup + sort by score
  const filtered = extracted
    .filter((c) => c && c.company)
    .filter((c) => !isExcludedCandidate(c, config))
    .filter((c) => !(requireNoWebsite && hasLiveWebsite(c)));
  const deduped = uniqueBy(filtered, (c) => (c.website || c.company).toLowerCase());

  const scored = deduped
    .map((c) => ({ candidate: c, score: scoreCandidate(c, config) }))
    .filter((s) => s.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score);

  log.info(
    `Discovered ${extracted.length} raw → ${filtered.length} filtered → ${deduped.length} dedup → ${scored.length} ≥ threshold`
  );

  // Process candidates: insert shell → enrich inline → count if qualified.
  // Respect both the weekly needed count AND the daily candidate cap.
  let newlyQualified = 0;
  let candidatesProcessed = 0;
  const processed = [];
  const errors = [];

  for (const { candidate, score } of scored) {
    if (newlyQualified >= needed) {
      processed.push({ company: candidate.company, action: 'weekly_target_hit', score });
      break;
    }
    if (candidatesProcessed >= dailyCandidateCap) {
      processed.push({ company: candidate.company, action: 'daily_cap_hit', score });
      log.warn(`Hit daily candidate cap (${dailyCandidateCap}) — stopping`);
      break;
    }

    try {
      const existing = await leadAlreadyExists(tenant.id, candidate);
      if (existing) {
        processed.push({
          company: candidate.company, action: 'duplicate', score,
          existing_lead_id: existing.id,
        });
        continue;
      }

      // 1. Insert shell
      const lead = await insertLeadShell(tenant.id, candidate, score, focusIndustry, weekStart);
      candidatesProcessed++;

      // 2. Enrich inline
      const enriched = await enrichment.enrichOne(tenant, lead);

      if (enriched.qualified) {
        newlyQualified++;
        processed.push({
          company: candidate.company,
          action: 'QUALIFIED',
          score,
          reason: enriched.reason,
          lead_id: lead.id,
        });
        log.info(
          `Qualified lead #${alreadyQualified + newlyQualified}/${weeklyTarget}: ${candidate.company}`
        );
      } else {
        processed.push({
          company: candidate.company,
          action: 'enrichment_no_contact',
          score,
          lead_id: lead.id,
        });
      }
    } catch (err) {
      log.error(`Candidate processing failed: ${candidate.company}`, err);
      errors.push({ company: candidate.company || null, error: err.message });
    }
  }

  const result = {
    success: true,
    focus_industry: focusIndustry,
    week_start: weekStart,
    weekly_target: weeklyTarget,
    already_qualified: alreadyQualified,
    needed_at_start_of_run: needed,
    newly_qualified: newlyQualified,
    week_total_now: alreadyQualified + newlyQualified,
    candidates_processed: candidatesProcessed,
    daily_candidate_cap: dailyCandidateCap,
    discovered: extracted.length,
    qualified_after_score: scored.length,
    errors,
    processed,
  };

  log.success('Prospecting run complete', {
    focus_industry: focusIndustry,
    week_total_now: alreadyQualified + newlyQualified,
    weeks_target: weeklyTarget,
    errors: errors.length,
  });
  return result;
}

module.exports = run;
