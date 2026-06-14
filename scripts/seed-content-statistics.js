/**
 * Seed content_sources + content_statistics for the FGA tenant from the
 * curated facts in core/fga-research-stats.js.
 *
 * Idempotent: upserts sources by (tenant_id, name, year) and skips statistics
 * whose stat_text already exists for the tenant. Safe to run repeatedly.
 *
 * Usage: node scripts/seed-content-statistics.js
 */

require('dotenv').config();
const { db } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const { CROSS_INDUSTRY_FACTS, FACTS_BY_INDUSTRY } = require('../core/fga-research-stats');

// Infer a coarse theme tag from the fact's match tokens + text so the planner
// can enforce "no overused theme twice in a row" (missed-call, speed, etc.).
function inferThemeTag(fact) {
  const hay = `${(fact.match || []).join(' ')} ${fact.stat} ${fact.use || ''}`.toLowerCase();
  if (/missed call|unanswered|miss .*call|two-thirds/.test(hay)) return 'missed_call';
  if (/respond|response|1 minute|first business|speed|velocity|velocify|within 1 hour|urgency/.test(hay)) return 'speed';
  if (/review/.test(hay)) return 'reviews';
  if (/profile|google business|gbp/.test(hay)) return 'gbp';
  if (/website|load|5 second/.test(hay)) return 'website';
  if (/recurring|retention|monthly billing|cancel/.test(hay)) return 'retention';
  if (/season|hail|storm|april|september|cooling|heating/.test(hay)) return 'seasonal';
  if (/8am|6pm|weekend|off-hour/.test(hay)) return 'off_hours';
  if (/lifetime|acquisition|\$|cost-per-lead|click/.test(hay)) return 'economics';
  return 'industry';
}

// Split "Invoca, 2024 Home Services Call Study" → { name, publisher, year }.
function parseSource(src) {
  const yearMatch = String(src).match(/(19|20)\d{2}/);
  const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
  const publisher = String(src).split(/[,/]/)[0].trim();
  return { name: String(src).trim(), publisher, year };
}

async function upsertSource(src) {
  const { name, publisher, year } = parseSource(src);
  // Upsert by (tenant_id, name, year)
  const { data: existing } = await db
    .from('content_sources')
    .select('id')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('name', name)
    .limit(1);
  if (existing && existing.length) return existing[0].id;
  const { data, error } = await db
    .from('content_sources')
    .insert({ tenant_id: FGA_TENANT_ID, name, publisher, year, credibility: 'verified' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function seedFact(fact, industry) {
  // Skip if a statistic with this exact text already exists for the tenant.
  const { data: existing } = await db
    .from('content_statistics')
    .select('id')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('stat_text', fact.stat)
    .limit(1);
  if (existing && existing.length) return false;

  const sourceId = await upsertSource(fact.source);
  const { year } = parseSource(fact.source);
  const { error } = await db.from('content_statistics').insert({
    tenant_id: FGA_TENANT_ID,
    source_id: sourceId,
    stat_text: fact.stat,
    value_label: (fact.match && fact.match[0]) || null,
    industry: industry || null,
    match_tokens: fact.match || [],
    theme_tag: inferThemeTag(fact),
    use_hints: fact.use || null,
    source_year: year,
    active: true,
  });
  if (error) throw error;
  return true;
}

async function main() {
  let inserted = 0;
  for (const fact of CROSS_INDUSTRY_FACTS) {
    if (await seedFact(fact, null)) inserted++;
  }
  for (const [industry, facts] of Object.entries(FACTS_BY_INDUSTRY)) {
    for (const fact of facts) {
      if (await seedFact(fact, industry)) inserted++;
    }
  }
  console.log(`Seeded ${inserted} new statistics for FGA tenant.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
