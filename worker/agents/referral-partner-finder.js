/**
 * Referral Partner Finder — discovers real-estate and insurance agents in A Kut
 * Above's service area (Jackson County, MS + touching cities) and saves them as
 * referral_partners for the owner to review and enroll in EMAIL-ONLY outreach.
 *
 * On-demand only (enqueued by the Outreach Center "Find" button). Web search +
 * Claude extraction are hard-capped. No outreach is sent here — it only fills
 * the prospect list; the owner approves the Day-1 email per the cadence.
 */
const { db } = require('../../db/client');
const P = require('../../core/outreach-prospecting');
const { createLogger } = require('../../core/logger');

async function run(tenant, payload = {}) {
  const log = createLogger('referral-partner-finder', tenant.slug);
  const tenantId = tenant.id;
  const types = payload.partner_type ? [payload.partner_type] : ['real_estate', 'insurance'];

  let created = 0, deduped = 0;
  for (const pt of types) {
    const queries = P.partnerQueries(pt);
    const sr = await P.runSerper(queries);
    const label = pt === 'insurance' ? 'insurance agents' : 'real estate agents';
    const candidates = await P.extractCandidates(sr, 'referral', label);
    for (const c of candidates) {
      const key = P.candidateKey('referral', c);
      const { data: ex } = await db.from('referral_partners').select('id').eq('tenant_id', tenantId).eq('candidate_key', key).maybeSingle();
      if (ex) { deduped++; continue; }
      const { error } = await db.from('referral_partners').insert({
        tenant_id: tenantId,
        name: c.name || null, company: c.company || null,
        partner_type: (c.partner_type === 'insurance' || pt === 'insurance') ? 'insurance' : 'real_estate',
        email: c.email || null, phone: c.phone || null, website: c.website || null,
        city: c.city || null, source_url: c.source_url || null, notes: c.notes || null,
        confidence: (c.confidence != null ? Number(c.confidence) : null),
        candidate_key: key, outreach_status: 'new',
        metadata: { discovered_at: new Date().toISOString() },
      });
      if (!error) created++; else if (!/duplicate key/i.test(error.message)) log.warn(`insert failed: ${error.message}`);
    }
  }
  log.info(`referral finder: created=${created} deduped=${deduped}`);
  return { created, deduped };
}

module.exports = run;
