/**
 * core/lead-sources.js — classify where a lead came from.
 *
 * INBOUND leads are people who contacted the BUSINESS themselves — website
 * contact form, web chat, missed call, voice receptionist, anything a tenant
 * site posts to /api/leads/capture. They are customers (or warm prospects)
 * reaching in, and must NEVER enter the cold-prospecting pipeline: no cold
 * outreach drafts, no autosend, and enrichment must never overwrite the
 * message they wrote.
 *
 * PROSPECT sources are the only ones eligible for cold outreach — leads the
 * platform or the owner deliberately sourced. The polarity is fail-safe: an
 * unknown or missing lead_source is treated as INBOUND, because cold-pitching
 * a real customer costs far more than a prospect waiting on manual review.
 * (2026-07-14: a 923A customer asking for a coin reorder got an FGA cold-email
 * draft because the old checks were a deny-list instead of this allow-list.)
 */

const PROSPECT_SOURCES = new Set([
  'manual',                  // owner adds a prospect by hand in the app
  'prospecting_agent',       // Growth Engine sourced it
  'targeted_campaign_agent', // Targeted Campaign Agent sourced it
]);

function isProspectSource(source) {
  return PROSPECT_SOURCES.has(String(source || '').trim().toLowerCase());
}

/** Accepts a lead row or a raw lead_source string. */
function isInboundLead(leadOrSource) {
  const src = (leadOrSource && typeof leadOrSource === 'object')
    ? leadOrSource.lead_source
    : leadOrSource;
  return !isProspectSource(src);
}

module.exports = { PROSPECT_SOURCES, isProspectSource, isInboundLead };
