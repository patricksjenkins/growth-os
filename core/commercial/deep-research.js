/**
 * core/commercial/deep-research.js — Stage 2 structured extraction via Claude.
 *
 * Runs ONLY on candidates that passed cheap Stage-1 qualification AND were
 * page-fetched. Hands the trimmed page payload to Claude (through the central
 * callClaude chokepoint via askClaudeJSON — never a new Anthropic client) to
 * extract a normalized event/organization record with honest provenance.
 *
 * Deterministic rules do most of the work; Claude only structures the messy text.
 */

const { askClaudeJSON } = require('../../integrations/claude');

const SYSTEM = 'You extract structured commercial/event opportunity data from a web page for a custom-medal & challenge-coin maker (923A). Return ONLY valid JSON. Never invent facts: if a field is not clearly stated, use null. Distinguish confirmed vs estimated.';

/**
 * @param candidate { url, profile, stage1, page:{title,description,text,events,emails,phones,website} }
 * @param tenant growth-os tenant object (for Claude cost cap attribution)
 * Returns { ok, event } or { ok:false }. `event` is a normalized opportunity model.
 */
async function deepResearch(candidate, tenant) {
  const page = candidate.page || {};
  const ld = (page.events && page.events[0]) || {};
  const userPrompt = `
Profile/category: ${candidate.profile}
Source URL: ${candidate.url}

Structured hints already extracted (may be empty):
- JSON-LD event: ${JSON.stringify(ld)}
- Page emails found: ${JSON.stringify(page.emails || [])}
- Page phones found: ${JSON.stringify(page.phones || [])}
- Title: ${page.title || ''}
- Description: ${page.description || ''}

Page text (trimmed):
"""
${(page.text || '').slice(0, 5000)}
"""

Extract this JSON (use null when not clearly present — do NOT guess attendance, dates, or contacts):
{
  "is_opportunity": true,          // false if this isn't a real upcoming event/org that might buy medals/coins/awards
  "event_name": "string|null",
  "organization": "string|null",
  "event_date": "YYYY-MM-DD|null", // the NEXT/upcoming occurrence only
  "date_confidence": "confirmed|estimated",
  "is_past_event": false,          // true if the page is about a finished event
  "recurring": false,              // annual/repeating series
  "city": "string|null",
  "state": "2-letter|null",
  "size_tier": "large|mid|small|null",
  "attendance": 0,                 // ONLY if explicitly published, else null
  "product_evidence": false,       // page shows they buy/award medals/coins/plaques/pins
  "contacts": [
    { "name": "string|null", "role": "string|null", "email": "string|null", "phone": "string|null", "contact_page": "string|null", "public": true }
  ],
  "registration_open": false,
  "prior_year_evidence": false,
  "notes": "1-2 sentence summary of the opportunity and any risks",
  "confidence": 0.0                // 0-1 overall confidence this is a real, current opportunity
}
Rules:
- Only public, organization-level contacts (event/race/tournament director, coordinator, sponsorship, marketing). No personal/sensitive data.
- If is_past_event is true and recurring is true, still return the org but set event_date to null.
- JSON only.`;

  let res;
  try {
    res = await askClaudeJSON(SYSTEM, userPrompt, { maxTokens: 1200, tenant, agentName: 'commercial-discovery' });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!res || res.is_opportunity === false) return { ok: false, reason: 'not_an_opportunity', raw: res };

  // Normalize into the scoring engine's opportunity model.
  const contacts = Array.isArray(res.contacts) ? res.contacts.filter((c) => c && (c.email || c.phone || c.name || c.contact_page)) : [];
  const location = [res.city, res.state].filter(Boolean).join(', ') || null;
  const event = {
    event_name: res.event_name || page.title || null,
    organization: res.organization || null,
    profile: candidate.profile,
    website: page.website || candidate.url,
    location,
    event_date: res.is_past_event ? null : (res.event_date || null),
    date_confidence: res.date_confidence === 'confirmed' ? 'confirmed' : 'estimated',
    recurring: !!res.recurring,
    size_tier: ['large', 'mid', 'small'].includes(res.size_tier) ? res.size_tier : 'mid',
    attendance: Number.isFinite(res.attendance) ? res.attendance : null,
    product_evidence: !!res.product_evidence,
    contacts,
    source_url: candidate.url,
    notes: res.notes || null,
    _confidence: Number(res.confidence) || 0,
    _isPast: !!res.is_past_event,
    _priorYearEvidence: !!res.prior_year_evidence,
  };
  return { ok: true, event };
}

module.exports = { deepResearch };
