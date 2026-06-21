/**
 * Commercial Finder — discovers commercial / community property contacts
 * (property managers, HOAs, apartment communities, churches, etc.) in A Kut
 * Above's service area and saves them as commercial_prospects for the owner to
 * review and enroll in EMAIL-ONLY outreach. NO referral appreciation payment is
 * ever offered to this group (enforced by the commercial templates).
 *
 * On-demand only. Web search + Claude extraction are hard-capped. No outreach is
 * sent here — it only fills the prospect list.
 */
const { db } = require('../../db/client');
const P = require('../../core/outreach-prospecting');
const { createLogger } = require('../../core/logger');

async function run(tenant, payload = {}) {
  const log = createLogger('commercial-finder', tenant.slug);
  const tenantId = tenant.id;
  // Default to the broadly-useful types unless the owner picked one.
  const types = payload.prospect_type ? [payload.prospect_type] : ['property_manager', 'hoa', 'apartments'];

  let created = 0, deduped = 0;
  for (const pt of types) {
    const queries = P.commercialQueries(pt);
    const sr = await P.runSerper(queries);
    const label = P.COMMERCIAL_LABELS[pt] || 'commercial property managers';
    const candidates = await P.extractCandidates(sr, 'commercial', label);
    for (const c of candidates) {
      const key = P.candidateKey('commercial', c);
      const { data: ex } = await db.from('commercial_prospects').select('id').eq('tenant_id', tenantId).eq('candidate_key', key).maybeSingle();
      if (ex) { deduped++; continue; }
      const { error } = await db.from('commercial_prospects').insert({
        tenant_id: tenantId,
        name: c.company || c.name || null, contact_person: c.name || null,
        prospect_type: c.prospect_type || pt,
        email: c.email || null, phone: c.phone || null, website: c.website || null,
        address: c.address || null, city: c.city || null, source_url: c.source_url || null, notes: c.notes || null,
        confidence: (c.confidence != null ? Number(c.confidence) : null),
        candidate_key: key, outreach_status: 'new',
        metadata: { discovered_at: new Date().toISOString() },
      });
      if (!error) created++; else if (!/duplicate key/i.test(error.message)) log.warn(`insert failed: ${error.message}`);
    }
  }
  log.info(`commercial finder: created=${created} deduped=${deduped}`);
  return { created, deduped };
}

module.exports = run;
