/**
 * Growth OS — Enrichment Agent (Multi-source contact search)
 *
 * Enriches prospect-stage leads with contact data by querying multiple public
 * sources. Designed for the FGA "1-3 person no-website micro-business" ICP —
 * where the goal is specifically to find EMAIL or FACEBOOK URL for outreach.
 *
 * Sources queried (priority order):
 *   1. State licensing boards   (plumbing/HVAC/electrical/roofing license lookups)
 *   2. Google Business Profile   (site:maps.google)
 *   3. Facebook About page       (site:facebook.com)
 *   4. Instagram bio             (site:instagram.com)
 *   5. LinkedIn contact info     (site:linkedin.com)
 *   6. Yelp profile              (site:yelp.com)
 *   7. Thumbtack profile         (site:thumbtack.com)
 *   8. Chamber of Commerce       (chamber of commerce "<company>" "<state>")
 *   9. Owner-name search         (catch anything else)
 *
 * For each lead Serper returns organic results; all results are aggregated and
 * sent to Claude with a strict extraction prompt. Claude returns email,
 * facebook_url, instagram_url, linkedin_url, google_business_profile_url, and
 * confirmed owner name.
 *
 * Exports:
 *   - run(tenant, payload)    — batch mode used by the scheduled agent
 *   - enrichOne(tenant, lead) — single-lead helper used inline by prospecting
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
  if (n <= 3) return '1-3';
  if (n <= 10) return '4-10';
  if (n < 20) return '11-19';
  if (n < 50) return '20-50';
  if (n < 100) return '50-100';
  return '100+';
}

function stateFullName(abbr) {
  const map = {
    GA: 'Georgia', FL: 'Florida', NC: 'North Carolina', SC: 'South Carolina',
    TN: 'Tennessee', AL: 'Alabama', TX: 'Texas', VA: 'Virginia',
    CO: 'Colorado', IL: 'Illinois', NY: 'New York', CA: 'California',
  };
  return map[abbr] || abbr || '';
}

// Industry → licensing-board hint. State boards publicize license holders
// and their registered business/contact info. Plumbers, HVAC, electrical,
// and roofing are universally licensed; cleaning and landscaping are not
// always — for those we fall back to general directory searches.
function licensingBoardHint(industry, stateAbbr) {
  if (!industry || !stateAbbr) return null;
  const i = industry.toLowerCase();
  const stateName = stateFullName(stateAbbr);
  if (i.includes('plumb')) {
    return `${stateName} "plumbing license" "license holder" OR "license lookup"`;
  }
  if (i.includes('hvac') || i.includes('heating') || i.includes('cooling') || i.includes('mechanical')) {
    return `${stateName} "HVAC license" OR "mechanical license" license holder`;
  }
  if (i.includes('electric')) {
    return `${stateName} "electrical license" license holder`;
  }
  if (i.includes('roof')) {
    return `${stateName} "roofing license" OR "contractor license" license holder`;
  }
  if (i.includes('landscap') || i.includes('tree')) {
    return `${stateName} "landscape contractor" OR "tree service license" registered`;
  }
  return null;
}

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

/**
 * Run the multi-source contact-search pattern for one lead.
 * Returns the aggregated {query, results[]} array — NOT Claude-extracted yet.
 */
async function multiSourceContactSearch(lead, log) {
  const company = lead.company_name;
  const state = lead.hq_state || '';
  const stateName = stateFullName(state);
  const owner = (lead.metadata && lead.metadata.owner_name) || null;

  const queries = [
    // 1. Google Business Profile / Maps
    `"${company}" ${stateName} google maps site:google.com`,
    // 2. Facebook — always has About section with email/phone
    `"${company}" ${stateName} site:facebook.com`,
    // 3. Instagram — email often in bio
    `"${company}" site:instagram.com`,
    // 4. LinkedIn — for owners who have personal pages
    `"${company}" ${stateName} site:linkedin.com`,
    // 5. Yelp — message-the-business / phone
    `"${company}" ${stateName} site:yelp.com`,
    // 6. Thumbtack — phone always, sometimes email
    `"${company}" ${stateName} site:thumbtack.com`,
    // 7. Chamber of Commerce
    `"${company}" "chamber of commerce" ${stateName}`,
    // 8. Licensing board (industry-dependent)
    licensingBoardHint(lead.industry, state) && `"${company}" ${licensingBoardHint(lead.industry, state)}`,
    // 9. Owner-name / email search (if we already know owner name)
    owner && `"${owner}" "${company}" email OR contact`,
    // 10. General business directory catch-all
    `"${company}" ${stateName} owner email contact`,
  ].filter(Boolean);

  const results = [];
  for (const q of queries) {
    try {
      const data = await searchSerper(q, 5);
      results.push({
        query: q,
        organic: data.organic || [],
        knowledgeGraph: data.knowledgeGraph || null,
        places: data.places || [],
      });
    } catch (err) {
      log.warn(`Serper query failed: ${q}`, { error: err.message });
    }
  }
  return results;
}

/**
 * Pass aggregated search results to Claude, get structured contact data.
 */
async function extractContactDataWithClaude(lead, aggregatedResults, tenant) {
  const systemPrompt =
    'You extract structured contact data for a B2B sales prospect. Return only valid JSON. ' +
    'Be conservative — do not hallucinate emails or URLs. If you cannot find a piece of info, return null.';

  const userPrompt = `
You are looking for contact information for a small business that we want to reach for a
sales conversation. The business is likely 1-3 employees, owner-operated, with no company
website of its own.

Business:
- Name: ${lead.company_name}
- State: ${lead.hq_state || 'unknown'}
- Industry: ${lead.industry || 'unknown'}
${lead.phone ? `- Known phone: ${lead.phone}` : ''}
${lead.metadata?.owner_name ? `- Suspected owner: ${lead.metadata.owner_name}` : ''}

Extract from the aggregated search results below. Return JSON ONLY:

{
  "email": "string or null — ONLY include if explicitly visible in the search results. Do NOT guess or generate an email address.",
  "facebook_url": "string or null — must start with https://www.facebook.com/ or https://facebook.com/",
  "instagram_url": "string or null — must start with https://www.instagram.com/ or https://instagram.com/",
  "linkedin_url": "string or null — the owner's personal LinkedIn if present, else the company page",
  "google_business_profile_url": "string or null",
  "yelp_url": "string or null",
  "thumbtack_url": "string or null",
  "owner_name": "string or null — first+last if visible",
  "phone": "string or null — only if you find a phone we didn't already have",
  "license_info": "string or null — e.g. 'GA Plumbing License #PL12345, active, issued 2019'",
  "review_count": "integer or null — if Google/Yelp shows review count",
  "confidence_email": 0.0,
  "confidence_overall": 0.0,
  "notes": "1-2 sentence summary of what you found and where"
}

Rules:
- Email: ONLY if literally present as text in snippets. No guessing.
- URL validation: must look like a real URL, not a search-results page.
- confidence_* between 0 and 1.
- No markdown, no commentary. JSON only.

Aggregated search results:
${JSON.stringify(aggregatedResults).slice(0, 16000)}
`;

  return await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 2500,
    tenantSlug: tenant.slug,
  });
}

// ============================================================================
// ENRICH ONE LEAD (exported for prospecting to call inline)
// ============================================================================

/**
 * Enrich a single lead end-to-end. Used both by the batch agent and by the
 * prospecting agent which calls this inline for each candidate so it can
 * decide qualification before moving to the next candidate.
 *
 * Side effects:
 *   - Updates leads row with enrichment_status, lifecycle_stage, metadata, etc.
 *   - Inserts a contacts row with email/LinkedIn if found
 *
 * Returns:
 *   { success, qualified, reason, enrichment, contact_email, facebook_url }
 *   where `qualified` = TRUE only if we found email OR facebook_url.
 */
async function enrichOne(tenant, lead) {
  const log = createLogger('enrichment-one', tenant.slug);

  // Mark as processing
  await db.from('leads')
    .update({ enrichment_status: 'enriching' })
    .eq('id', lead.id)
    .eq('tenant_id', tenant.id);

  try {
    const aggregated = await multiSourceContactSearch(lead, log);
    const extracted = await extractContactDataWithClaude(lead, aggregated, tenant);

    const contactEmail = extracted.email || null;
    const facebookUrl = extracted.facebook_url || null;
    const qualified = Boolean(contactEmail || facebookUrl);

    // Build the leads update
    const metadata = {
      ...(lead.metadata || {}),
      owner_name: extracted.owner_name || lead.metadata?.owner_name || null,
      facebook_url: facebookUrl,
      instagram_url: extracted.instagram_url || null,
      linkedin_url: extracted.linkedin_url || null,
      google_business_profile_url: extracted.google_business_profile_url || null,
      yelp_url: extracted.yelp_url || null,
      thumbtack_url: extracted.thumbtack_url || null,
      license_info: extracted.license_info || null,
      review_count: extracted.review_count || null,
      enrichment_confidence: extracted.confidence_overall || null,
      enrichment_email_confidence: extracted.confidence_email || null,
      enrichment_notes: extracted.notes || null,
      contact_channels_found: [
        contactEmail && 'email',
        facebookUrl && 'facebook',
        extracted.instagram_url && 'instagram',
        extracted.linkedin_url && 'linkedin',
      ].filter(Boolean),
    };

    const updates = {
      enrichment_status: qualified ? 'enriched' : 'enriched_no_contact',
      enriched_at: new Date().toISOString(),
      lifecycle_stage: qualified ? 'enriched' : 'unqualified',
      metadata,
      updated_at: new Date().toISOString(),
    };
    if (extracted.phone && !lead.phone) updates.phone = extracted.phone;

    await db.from('leads').update(updates).eq('id', lead.id).eq('tenant_id', tenant.id);

    // Insert/update contact row if we found an email or named owner
    if (contactEmail || extracted.owner_name) {
      const { first_name, last_name } = splitName(extracted.owner_name);
      const { error: contactErr } = await db.from('contacts').insert({
        tenant_id: tenant.id,
        lead_id: lead.id,
        first_name,
        last_name,
        title: 'Owner',
        email: contactEmail,
        linkedin_url: extracted.linkedin_url || null,
        role_in_buying: 'decision_maker',
        is_primary_contact: true,
        contact_status: 'active',
        source: 'enrichment_agent',
      });
      if (contactErr) {
        log.warn(`Contact insert skipped (${contactErr.message})`);
      }
    }

    log.info(
      `Enriched ${lead.company_name}: qualified=${qualified} email=${!!contactEmail} fb=${!!facebookUrl}`
    );

    return {
      success: true,
      qualified,
      reason: qualified
        ? (contactEmail ? 'email_found' : 'facebook_found')
        : 'no_contact_channel',
      contact_email: contactEmail,
      facebook_url: facebookUrl,
      extracted,
    };
  } catch (err) {
    log.error(`Enrichment failed for ${lead.company_name}`, err);
    await db.from('leads')
      .update({
        enrichment_status: 'failed',
        lifecycle_stage: 'unqualified',
        updated_at: new Date().toISOString(),
      })
      .eq('id', lead.id)
      .eq('tenant_id', tenant.id);
    return { success: false, qualified: false, reason: 'exception', error: err.message };
  }
}

// ============================================================================
// BATCH AGENT (scheduled or manual catch-up)
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

  let leadsQuery;
  if (payload.lead_id) {
    leadsQuery = db
      .from('leads')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('id', payload.lead_id);
  } else {
    leadsQuery = db
      .from('leads')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('lifecycle_stage', 'prospect')
      .in('enrichment_status', ['pending', null])
      .order('created_at', { ascending: true })
      .limit(limit);
  }

  const { data: leads, error: fetchErr } = await leadsQuery;
  if (fetchErr) throw fetchErr;

  if (!leads || leads.length === 0) {
    log.info('No leads pending enrichment');
    return { success: true, enriched: 0, message: 'No leads pending enrichment' };
  }

  log.info(`Enriching ${leads.length} leads (multi-source contact search)`);

  let qualified = 0;
  let unqualified = 0;
  let failed = 0;
  const processed = [];

  for (const lead of leads) {
    const r = await enrichOne(tenant, lead);
    processed.push({
      lead_id: lead.id,
      company: lead.company_name,
      qualified: r.qualified,
      reason: r.reason,
    });
    if (!r.success) failed++;
    else if (r.qualified) qualified++;
    else unqualified++;
  }

  const result = { success: true, qualified, unqualified, failed, processed };
  log.success('Enrichment batch complete', result);
  return result;
}

module.exports = run;
module.exports.enrichOne = enrichOne;
