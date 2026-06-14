/**
 * DB-backed statistics library (content_statistics + content_sources).
 *
 * Supersedes the static core/fga-research-stats.js at runtime. Persisted
 * use_count / last_used_at let the planner enforce: statistics in ≤10-15% of
 * posts, never reuse a stat (or its theme) within the recent window, and
 * never invent numbers. The file stays as the seed source.
 */

const { db } = require('../../db/client');
const { createLogger } = require('../logger');

const log = createLogger('content-statistics');

async function fetchStats(tenantId, industry) {
  let q = db.from('content_statistics').select('*').eq('tenant_id', tenantId).eq('active', true);
  const { data, error } = await q;
  if (error) { log.warn(`fetchStats: ${error.message}`); return []; }
  const rows = data || [];
  if (industry) return rows.filter((r) => r.industry === industry || r.industry == null);
  return rows;
}

/**
 * Eligible stats for a post: excludes recently-used stat ids/keys and themes.
 * Sorted by least-recently-used so variety is the default.
 */
async function getEligibleStats(tenantId, { industry = null, recentStatKeys = [], recentThemeTags = [] } = {}) {
  const rows = await fetchStats(tenantId, industry);
  const usedKeys = new Set((recentStatKeys || []).map((k) => String(k).toLowerCase()));
  const usedThemes = new Set(recentThemeTags || []);
  const eligible = rows.filter((r) => {
    if (usedKeys.has(String(r.id).toLowerCase())) return false;
    if (r.value_label && usedKeys.has(String(r.value_label).toLowerCase())) return false;
    if (r.theme_tag && usedThemes.has(r.theme_tag)) return false;
    return true;
  });
  eligible.sort((a, b) => {
    const la = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const lb = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    return la - lb;
  });
  return eligible.length ? eligible : rows; // never starve a stat-led concept
}

async function getStatById(tenantId, id) {
  const { data } = await db.from('content_statistics').select('*, content_sources(name,url,year,publisher)').eq('tenant_id', tenantId).eq('id', id).single();
  return data || null;
}

async function markStatUsed(id) {
  try {
    const { data } = await db.from('content_statistics').select('use_count').eq('id', id).single();
    const next = ((data && data.use_count) || 0) + 1;
    await db.from('content_statistics').update({ use_count: next, last_used_at: new Date().toISOString() }).eq('id', id);
  } catch (e) {
    log.warn(`markStatUsed skipped: ${e.message}`);
  }
}

/**
 * Build the "FACTS YOU MAY CITE" block for the finalize prompt — same shape as
 * the legacy core/fga-research-stats.js buildFactsBlock, but DB-backed and
 * filtered for recency.
 */
async function buildFactsBlock(tenantId, { focusIndustry = null, recentStatKeys = [], recentThemeTags = [], maxIndustry = 6, maxCross = 6 } = {}) {
  const eligible = await getEligibleStats(tenantId, { industry: focusIndustry, recentStatKeys, recentThemeTags });
  const industryFacts = eligible.filter((r) => r.industry === focusIndustry && focusIndustry).slice(0, maxIndustry);
  const crossFacts = eligible.filter((r) => r.industry == null).slice(0, maxCross);

  const lines = ['FACTS YOU MAY CITE (these are the ONLY numbers you may use in this post):', ''];
  if (industryFacts.length) {
    lines.push(`-- ${focusIndustry}-specific --`);
    industryFacts.forEach((f, i) => { lines.push(`  ${i + 1}. ${f.stat_text}`); lines.push(`     Source: ${f.use_hints ? '' : ''}${f.source_year ? '' : ''}${sourceLabel(f)}`); });
    lines.push('');
  }
  lines.push('-- Cross-industry (any small service business) --');
  crossFacts.forEach((f, i) => { lines.push(`  ${i + 1}. ${f.stat_text}`); lines.push(`     Source: ${sourceLabel(f)}`); });
  lines.push('');
  lines.push('RULES FOR USING FACTS:');
  lines.push('- Use 0 or 1 number per post. NEVER stack multiple numbers in one post.');
  lines.push('- Quote it accurately and name the source in the slide or caption.');
  lines.push('- DO NOT invent numbers or cite "studies show" without a named source above.');
  lines.push('- Prefer a stat NOT cited in any recent post.');
  return lines.join('\n');
}

function sourceLabel(stat) {
  if (stat.content_sources && stat.content_sources.name) return stat.content_sources.name;
  return stat.use_hints ? stat.use_hints : (stat.value_label || 'source on file');
}

module.exports = { getEligibleStats, getStatById, markStatUsed, buildFactsBlock };
