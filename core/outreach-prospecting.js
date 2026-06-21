/**
 * Outreach prospecting helper — Serper web search + Claude extraction for the
 * referral-partner and commercial-property finder agents, bounded to A Kut
 * Above's service area (Jackson County, MS + touching Gulf-Coast cities).
 *
 * Safety: hard caps on searches + candidates per run; never invents emails/
 * phones; idempotent candidate_key dedupe. Cold prospects are EMAIL ONLY.
 */
const crypto = require('crypto');
const { search } = require('../integrations/serper');
const { askClaudeJSON } = require('../integrations/claude');
const { createLogger } = require('./logger');
const log = createLogger('outreach-prospecting');

// Jackson County, MS focus + immediately touching coastal cities. Source:
// tenants/a-kut-above aiService service area (Gautier, Moss Point, Ocean
// Springs, Pascagoula, Biloxi) plus nearby touching towns.
const SERVICE_AREA = ['Pascagoula', 'Moss Point', 'Ocean Springs', 'Gautier', 'Vancleave', "D'Iberville", 'Biloxi', 'Gulfport'];
const STATE = 'MS';
const MAX_SERPER = 6;       // hard cap on paid searches per run
const MAX_CANDIDATES = 20;  // hard cap on extracted candidates per run

const COMMERCIAL_LABELS = {
  property_manager: 'commercial property management companies',
  hoa: 'homeowners association (HOA) management companies',
  apartments: 'apartment communities',
  churches: 'churches',
  schools: 'schools and daycares',
  storage: 'self storage facilities',
  mobile_home: 'mobile home communities',
  retail: 'retail shopping centers',
  office_parks: 'office parks',
};

function partnerQueries(partnerType) {
  const label = partnerType === 'insurance' ? 'insurance agents' : 'real estate agents';
  return SERVICE_AREA.slice(0, 4).map((city) => `${label} in ${city} ${STATE}`);
}
function commercialQueries(prospectType) {
  const label = COMMERCIAL_LABELS[prospectType] || 'commercial property managers';
  return SERVICE_AREA.slice(0, 4).map((city) => `${label} in ${city} ${STATE}`);
}

async function runSerper(queries) {
  const results = [];
  for (const q of queries.slice(0, MAX_SERPER)) {
    try {
      const r = await search(q, { num: 10, meta: { source: 'outreach-prospecting' } });
      if (r && r.ok) results.push({ query: q, organic: (r.organic || []).slice(0, 8), places: (r.places || []).slice(0, 8) });
    } catch (err) { log.warn(`serper "${q}" failed: ${err.message}`); }
  }
  return results;
}

async function extractCandidates(searchResults, kind, typeLabel) {
  if (!searchResults.length) return [];
  const typeField = kind === 'referral' ? 'partner_type (real_estate|insurance)' : 'prospect_type';
  const system = `You extract LOCAL business contacts from web search results for a family-owned tree-service company on the Mississippi Gulf Coast (Jackson County area).
Return STRICT JSON: {"candidates":[{ "name":"", "company":"", "${kind === 'referral' ? 'partner_type' : 'prospect_type'}":"", "email":"", "phone":"", "website":"", "city":"", "source_url":"", "confidence":0.0, "notes":"" }]}.
Only include ${typeLabel} located in or very near these Mississippi cities: ${SERVICE_AREA.join(', ')}.
NEVER invent or guess an email or phone — leave the field as "" if it is not explicitly present in the results.
Skip national chains, directories themselves, and anything clearly outside the service area. Keep notes to one short line.`;
  // Compact the raw Serper payload to title/snippet/link/phone so the request
  // body stays small (avoids "Premature close" on large bodies + cuts cost).
  const compact = [];
  for (const r of searchResults) {
    for (const o of (r.organic || [])) compact.push({ t: o.title, s: o.snippet, u: o.link });
    for (const p of (r.places || [])) compact.push({ t: p.title, s: p.address, u: p.website, ph: p.phoneNumber });
  }
  const user = JSON.stringify(compact.slice(0, 30));
  try {
    const out = await askClaudeJSON(system, user, { maxTokens: 2200, operationType: 'outreach_prospect_extract' });
    const arr = Array.isArray(out?.candidates) ? out.candidates : [];
    return arr.filter((c) => c && (c.company || c.name)).slice(0, MAX_CANDIDATES);
  } catch (err) {
    log.warn(`claude extraction failed: ${err.message}`);
    return [];
  }
}

function candidateKey(kind, c) {
  const domain = String(c.website || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const phone = String(c.phone || '').replace(/\D/g, '');
  const name = String(c.company || c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = domain || phone || name || Math.random().toString(36).slice(2);
  return crypto.createHash('sha1').update(`${kind}|${id}`).digest('hex');
}

module.exports = {
  SERVICE_AREA, STATE, MAX_CANDIDATES, COMMERCIAL_LABELS,
  partnerQueries, commercialQueries, runSerper, extractCandidates, candidateKey,
};
