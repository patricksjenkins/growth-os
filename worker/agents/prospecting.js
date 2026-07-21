/**
 * Growth OS — Prospecting Agent (Daily top-up-to-50, multi-industry mode)
 *
 * DESIGN (2026-04-21 → 2026-06-11 scale-up — Patrick):
 *  - Runs DAILY at 06:00 America/New_York (Mon-Sun).
 *  - Each WEEK runs a SET of 3-5 focus industries (>=2 Tier-1, <=1 Tier-3)
 *    instead of a single one. The set rotates each week (Tuesday boundary),
 *    avoids repeating the previous week's exact combo, and preserves history.
 *  - Goal (2026-07-03 autonomous-outbound update): the weekly qualified
 *    target is ADAPTIVE — when autonomous outreach is armed, discovery keeps
 *    feeding until the weekly SEND target (autosend_weekly_target, 150) can
 *    be met, sized by the trailing email-coverage ratio and clamped at 600.
 *    Otherwise weekly_prospect_target (default 50) applies. "Qualified" =
 *    passed ICP hard filters AND enrichment found email OR Facebook URL.
 *  - The weekly count is GLOBAL across all of the week's industries.
 *  - DAILY PACING: derived from the weekly target (weekdays ~16%, weekend
 *    days ~10% each) — each run tops up toward the day's pace AND the weekly
 *    remainder, whichever is smaller.
 *  - Each daily run:
 *      1. Count qualified leads already inserted this week (all industries).
 *      2. needed = min(weekly_remaining, daily_remaining). If 0, no-op.
 *      3. Search Serper across the week's industries × approved states with a
 *         HARD per-run Serper-call cap, extract candidates via Claude, enrich
 *         each INLINE, count the ones enrichment qualifies. Stop at needed,
 *         the daily candidate cap, or the Serper cap — whichever first.
 *
 * SAFETY (unchanged + strengthened):
 *  - Hard per-run Serper-call cap (default 30) — bounds API spend per run.
 *  - Hard daily candidate-processing cap (default 75) — bounds enrichment.
 *  - Weekly qualified ceiling (default 50) — hard stop, no 51st insert.
 *  - Daily pace cap — stops the run once the day's pace target is met.
 *  - Serper retry/backoff (integrations/_retry, max attempts) — unchanged.
 *  - Dedup across name/domain/phone before any insert — unchanged.
 *  - No recursive self-enqueue; the run is a single pass and returns.
 *
 * Configuration (tenant_config — source of truth):
 *  - target_industries              array — full approved pool
 *  - target_states                  array (2-letter codes) — 11 approved states
 *  - min_employees, max_employees   size band (defaults 1,10; scoring favors 1-3)
 *  - require_no_website             boolean (default false — website = signal, not filter)
 *  - weekly_prospect_target         int (default 50) — HARD weekly ceiling
 *  - daily_candidate_cap            int (default 75) — max candidates/day
 *  - max_serper_calls_per_run       int (default 30) — hard per-run API cap
 *  - industries_per_week            int (default 4, clamped 3-5)
 *  - score_threshold                int (default 50)
 *  - prospecting_active_industries  array — the current week's chosen set
 *  - prospecting_industry_history   array — last few weekly sets (rotation)
 *  - prospecting_week_start         ISO date — the Tuesday this week began
 *  - excluded_industries, excluded_keywords
 *  - prospecting_icp_notes          free-form LLM guidance
 */

const axios = require('axios');
const { askClaude, askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sanitizePhone } = require('../../core/utils');
const enrichment = require('./enrichment');

const DEFAULT_SCORE_THRESHOLD = 50;
const DEFAULT_WEEKLY_TARGET = 50;
const DEFAULT_DAILY_CANDIDATE_CAP = 150;
const DEFAULT_MAX_SERPER_CALLS_PER_RUN = 45;
const DEFAULT_INDUSTRIES_PER_WEEK = 4; // clamped to the 3-5 window
const DEFAULT_EMPLOYEE_MIN = 1;
// 2026-07-03 (Patrick): ICP widened 1-5 -> 1-10 employees. Scoring bands
// inside scoreCandidate still favor the smallest teams (1-3 > 4-7 > 8-10);
// anything over 10 is rejected outright.
const DEFAULT_EMPLOYEE_MAX = 10;

// ---------------------------------------------------------------------------
// Industry tiers (Patrick 2026-06-11). Tier 1 = highest FGA fit (phone-driven,
// miss calls on the job, need follow-up). Weekly mix favors Tier 1. These are
// the canonical names; membership checks are case-insensitive so they line up
// with whatever casing target_industries uses.
// ---------------------------------------------------------------------------
const TIER1_INDUSTRIES = [
  'Plumbing', 'HVAC', 'Electrical', 'Tree Services', 'Roofing', 'Landscaping',
  'Garage Door Repair', 'Appliance Repair', 'Locksmiths', 'Pest Control',
  'Junk Removal', 'Pressure Washing', 'Handyman Services', 'Mobile Mechanics',
  'Towing', 'Cleaning Services', 'Pool Service',
];
const TIER2_INDUSTRIES = [
  'Hair Salons', 'Barbershops', 'Pet Groomers', 'Personal Trainers',
  'Massage Practices', 'Photographers', 'Caterers', 'Property Managers',
  'Bookkeepers', 'Tax Preparers', 'Independent Insurance Agencies',
  'Small Law Offices', 'Home Inspectors', 'Moving Companies',
];
const TIER3_INDUSTRIES = [
  'Florists', 'Event Planners', 'DJs', 'Videographers', 'Tutoring Services',
  'Laundromats', 'Sign Shops', 'Trophy and Awards Shops', 'Embroidery Shops',
];

// States added in the 2026-07-03 nationwide expansion (11 -> 48 + DC).
// The interleave in buildDiscoveryQueries mixes these with the established
// southeastern states so capped runs always evaluate new geography. (AK/HI
// excluded: service-business density + timezone spread don't justify slots.)
const NEWLY_ADDED_STATES = [
  'TX', 'OK', 'MO', 'WV', 'MD', 'DE', 'PA', 'NJ', 'NY', 'CT', 'RI', 'MA',
  'VT', 'NH', 'ME', 'OH', 'IN', 'IL', 'MI', 'WI', 'MN', 'IA', 'KS', 'NE',
  'SD', 'ND', 'MT', 'WY', 'CO', 'NM', 'AZ', 'UT', 'ID', 'NV', 'WA', 'OR',
  'CA', 'DC',
];

function tierOf(industry) {
  const n = String(industry || '').trim().toLowerCase();
  if (TIER1_INDUSTRIES.some((i) => i.toLowerCase() === n)) return 1;
  if (TIER2_INDUSTRIES.some((i) => i.toLowerCase() === n)) return 2;
  if (TIER3_INDUSTRIES.some((i) => i.toLowerCase() === n)) return 3;
  return 2; // unknown industries treated as Tier 2 (neutral) for mixing
}

// ============================================================================
// HELPERS
// ============================================================================

function safeArray(v) { return Array.isArray(v) ? v : []; }

// Tolerant parser for the candidate-extraction response. The model does not
// reliably honor a "max N candidates" instruction — it fills maxTokens, which
// truncates the JSON mid-array (the recurring "Expected ',' or ']' after array
// element in JSON" failure). Rather than fight that, we salvage every COMPLETE
// candidate object before the truncation point: scan the "candidates" array and
// JSON.parse each balanced {...}, stopping cleanly at the first incomplete one.
// Robust to truncation, ```json fences, and trailing prose.
function parseCandidatesLoose(text) {
  if (!text) return [];
  // Fast path: well-formed JSON.
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { const obj = JSON.parse(m[0]); if (Array.isArray(obj.candidates)) return obj.candidates; }
  } catch (_) { /* fall through to salvage */ }
  const key = text.indexOf('"candidates"');
  const arrStart = key === -1 ? -1 : text.indexOf('[', key);
  if (arrStart === -1) return [];
  const out = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = arrStart + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') {
      if (depth > 0) { depth--; if (depth === 0 && objStart !== -1) { try { out.push(JSON.parse(text.slice(objStart, i + 1))); } catch (_) { /* skip malformed */ } objStart = -1; } }
    } else if (ch === ']' && depth === 0) { break; } // clean end of the array
  }
  return out;
}
function normalizeState(value) { return value ? String(value).trim().toUpperCase() : null; }
function normalizeIndustry(value) { return value ? String(value).trim() : null; }

function stateName(abbr) {
  // Nationwide (2026-07-03): full lower-48 + DC map so discovery queries can
  // spell out any approved state.
  const map = {
    AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California',
    CO: 'Colorado', CT: 'Connecticut', DC: 'Washington DC', DE: 'Delaware',
    FL: 'Florida', GA: 'Georgia', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois',
    IN: 'Indiana', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine', MI: 'Michigan',
    MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana',
    NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada',
    NY: 'New York', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VA: 'Virginia', VT: 'Vermont', WA: 'Washington', WI: 'Wisconsin',
    WV: 'West Virginia', WY: 'Wyoming',
  };
  return map[abbr] || abbr;
}

/**
 * Daily pace target by day-of-week in ET, DERIVED from the (possibly adaptive)
 * weekly target so pacing scales automatically: weekdays carry ~16% of the
 * week each, weekend days ~10% (5x16 + 2x10 = 100). At the legacy target of 50
 * this reproduces the old Mon-Fri 8 / Sat-Sun 5 curve exactly. Override via
 * tenant_config.prospecting_daily_pace (array of 7, index 0 = Sunday) if
 * Patrick wants a custom curve.
 */
function dailyPaceTarget(tenant, weeklyTarget = DEFAULT_WEEKLY_TARGET) {
  const custom = getConfig(tenant, 'prospecting_daily_pace', null);
  if (Array.isArray(custom) && custom.length === 7) {
    const curve = custom.map((n) => Number(n) || 0);
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return curve[et.getDay()] ?? Math.ceil(weeklyTarget * 0.16);
  }
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const isWeekend = et.getDay() === 0 || et.getDay() === 6;
  return Math.max(1, Math.ceil(weeklyTarget * (isWeekend ? 0.10 : 0.16)));
}

/**
 * Adaptive weekly prospect target (Patrick 2026-07-03): there is NO separate
 * discovery target — the funnel keeps discovering until the autonomous SEND
 * target (autosend_weekly_target, default 150) can be fed. We estimate how
 * many qualified prospects that takes from the trailing 28-day email-coverage
 * ratio (qualified prospects that ended up with a usable email), add a 20%
 * buffer, and clamp to a sane ceiling so a bad coverage week can't stampede
 * the Serper/Claude budget. When autonomous mode is off, the configured
 * weekly_prospect_target applies unchanged.
 */
async function computeAdaptiveWeeklyTarget(tenant, baseTarget, log) {
  const autonomous = String(getConfig(tenant, 'autonomous_outreach_enabled', 'false')) === 'true';
  if (!autonomous) return baseTarget;
  const sendTarget = Number(getConfig(tenant, 'autosend_weekly_target', 150)) || 150;
  try {
    const since = new Date(Date.now() - 28 * 86400000).toISOString();
    const { count: total } = await db.from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id).eq('lead_source', 'prospecting_agent')
      .gte('created_at', since);
    const { count: withEmail } = await db.from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id).eq('lead_source', 'prospecting_agent')
      .not('email', 'is', null)
      .gte('created_at', since);
    // Floor coverage at 20% so early/noisy data can't demand absurd volume.
    const coverage = (total || 0) >= 30 ? Math.max(0.2, (withEmail || 0) / total) : 0.35;
    const needed = Math.ceil((sendTarget / coverage) * 1.2);
    const target = Math.min(Math.max(baseTarget, needed), 600);
    log.info(`Adaptive weekly target: send_target=${sendTarget}, email_coverage=${(coverage * 100).toFixed(0)}% (${withEmail}/${total} last 28d) -> prospect_target=${target}`);
    return target;
  } catch (err) {
    log.warn(`Adaptive target failed (${err.message}) — using base ${baseTarget}`);
    return baseTarget;
  }
}

function normalizeSize(employeeCount, existingSize = null) {
  if (existingSize) return String(existingSize);
  const n = Number(employeeCount);
  if (!Number.isFinite(n)) return null;
  if (n <= 5) return '1-5';
  if (n <= 10) return '6-10';
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

/** Integer week index since epoch (for deterministic rotation). */
function weekIndexFromStart(weekStart) {
  const ms = new Date(`${weekStart}T00:00:00-05:00`).getTime();
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000));
}

/** Pick `count` items from `pool` starting at `offset`, wrapping, no repeats. */
function pickRotating(pool, count, offset) {
  const out = [];
  const n = pool.length;
  if (n === 0) return out;
  for (let i = 0; i < count && i < n; i++) {
    out.push(pool[(offset + i) % n]);
  }
  return out;
}

/**
 * Choose this week's 3-5 focus industries from the approved pool, honoring the
 * tier mix: >=2 Tier-1, <=1 Tier-3, the rest Tier-2. Deterministic rotation by
 * week index so it advances each Tuesday and (cheaply) avoids repeating the
 * previous week's exact combo. Only industries present in the tenant's
 * target_industries pool are eligible, so config stays the source of truth.
 */
function chooseWeeklyIndustries(targetIndustries, weekStart, perWeek, prevSet) {
  const inPool = (name) =>
    targetIndustries.some((t) => t.toLowerCase() === String(name).toLowerCase());
  const t1 = TIER1_INDUSTRIES.filter(inPool);
  const t2 = TIER2_INDUSTRIES.filter(inPool);
  const t3 = TIER3_INDUSTRIES.filter(inPool);

  const size = Math.max(3, Math.min(5, perWeek || DEFAULT_INDUSTRIES_PER_WEEK));
  const w = weekIndexFromStart(weekStart);

  const build = (bump) => {
    const chosen = [];
    // >=2 Tier-1
    for (const i of pickRotating(t1, Math.min(2, t1.length), (w * 2 + bump))) chosen.push(i);
    // exactly 1 Tier-3 on odd weeks (<=1), else fill from Tier-2
    const wantT3 = (w % 2 === 1) && t3.length > 0;
    if (wantT3) chosen.push(...pickRotating(t3, 1, w + bump));
    // fill the remainder from Tier-2 (then Tier-1 as last resort)
    let fillIdx = 0;
    while (chosen.length < size) {
      const pool = t2.length ? t2 : t1;
      const pick = pool[(w + fillIdx + bump) % pool.length];
      if (!chosen.some((c) => c.toLowerCase() === pick.toLowerCase())) chosen.push(pick);
      fillIdx++;
      if (fillIdx > pool.length + size) break; // safety
    }
    return chosen.slice(0, size);
  };

  let chosen = build(0);
  // Avoid the exact same combo as last week (deterministic bump).
  const prev = Array.isArray(prevSet) ? prevSet.map((s) => s.toLowerCase()).sort().join('|') : '';
  if (prev && chosen.map((s) => s.toLowerCase()).sort().join('|') === prev) {
    chosen = build(1);
  }
  return chosen;
}

/**
 * Resolve the week's focus industries, advancing on the Tuesday boundary and
 * persisting the chosen set + a short history. Returns { industries, weekStart }.
 * `payload.industry` / `payload.industries` still override for manual runs.
 */
async function resolveWeeklyIndustries(tenant, targetIndustries, perWeek, log) {
  if (!targetIndustries.length) {
    throw new Error('target_industries is empty — set at least one industry in tenant_config');
  }
  const storedWeekStart = getConfig(tenant, 'prospecting_week_start', null);
  const currentWeekStart = currentWeekStartTuesdayET();
  const isNewWeek = storedWeekStart !== currentWeekStart;

  const storedActive = safeArray(getConfig(tenant, 'prospecting_active_industries', []));
  if (!isNewWeek && storedActive.length) {
    log.info(`Same week (${currentWeekStart}). Active industries: ${storedActive.join(', ')}`);
    return { industries: storedActive.map(normalizeIndustry), weekStart: currentWeekStart };
  }

  const history = safeArray(getConfig(tenant, 'prospecting_industry_history', []));
  const prevSet = storedActive.length ? storedActive : (history[0]?.industries || null);
  const chosen = chooseWeeklyIndustries(targetIndustries, currentWeekStart, perWeek, prevSet);

  const newHistory = [{ week_start: currentWeekStart, industries: chosen }, ...history].slice(0, 12);
  await db.from('tenant_config').upsert(
    [
      { tenant_id: tenant.id, key: 'prospecting_active_industries', value: JSON.stringify(chosen) },
      { tenant_id: tenant.id, key: 'prospecting_industry_history', value: JSON.stringify(newHistory) },
      { tenant_id: tenant.id, key: 'prospecting_week_start', value: currentWeekStart },
    ],
    { onConflict: 'tenant_id,key' },
  );
  log.info(`New week ${currentWeekStart}. Focus industries: ${chosen.join(', ')}`);
  return { industries: chosen.map(normalizeIndustry), weekStart: currentWeekStart };
}

// ---------------------------------------------------------------------------
// Qualified-this-week count
// ---------------------------------------------------------------------------

async function countQualifiedThisWeek(tenantId, weekStart) {
  // GLOBAL weekly count across ALL of the week's industries so the weekly
  // ceiling (50) is a true cap regardless of which industry produced a lead.
  // "Qualified" = inserted this week by the prospecting agent, reached
  // lifecycle 'enriched'+ , and enrichment found an EMAIL (email is the
  // auto-sendable channel; FB-only leads are tracked separately below).
  const since = new Date(`${weekStart}T00:00:00-05:00`).toISOString(); // ET-ish
  const { data, error } = await db
    .from('leads')
    .select('id, metadata, lifecycle_stage')
    .eq('tenant_id', tenantId)
    .eq('lead_source', 'prospecting_agent')
    .gte('created_at', since)
    .in('lifecycle_stage', ['enriched', 'scored', 'sequenced']);

  if (error) throw error;

  return (data || []).filter((l) => {
    const md = l.metadata || {};
    return (
      Array.isArray(md.contact_channels_found) &&
      md.contact_channels_found.includes('email')
    );
  }).length;
}

/**
 * Count email-qualified prospecting leads inserted SO FAR TODAY (ET). Used to
 * enforce the daily pace target so a single run can't burn the whole week.
 */
async function countQualifiedToday(tenantId) {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setHours(0, 0, 0, 0);
  const since = et.toISOString();
  const { data, error } = await db
    .from('leads')
    .select('id, metadata')
    .eq('tenant_id', tenantId)
    .eq('lead_source', 'prospecting_agent')
    .gte('created_at', since)
    .in('lifecycle_stage', ['enriched', 'scored', 'sequenced']);
  if (error) throw error;
  return (data || []).filter((l) => {
    const md = l.metadata || {};
    return Array.isArray(md.contact_channels_found) && md.contact_channels_found.includes('email');
  }).length;
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

  // Size fit (Patrick 2026-07-03): banded, not binary. The smallest
  // owner-operated teams are the best FGA fit; 4-7 is solid; 8-10 is
  // acceptable; anything larger is outside the ICP entirely. Unknown counts
  // still get a small credit — micro-businesses rarely publish headcount.
  if (Number.isFinite(employees)) {
    if (employees >= 1 && employees <= 3) score += 25;
    else if (employees <= 7) score += 12;
    else if (employees <= 10) score += 4;
    else score -= 100; // >10 employees: hard reject
  } else {
    score += 8;
  }

  // Website (Patrick 2026-07-03): NO LONGER a hard rule. No-website is a
  // strong buying signal (they need the DFY website + presence), so it keeps
  // a boost — but a business WITH a website just scores lower, it is not
  // excluded. (require_no_website config is honored for backwards compat but
  // now defaults false.)
  const hasSite = hasLiveWebsite(c);
  if (!hasSite) score += 20;
  if (hasSite && config.requireNoWebsite) score -= 100;

  if (state && config.targetStates.includes(state)) score += 15;
  if (industry && config.targetIndustries.includes(industry)) score += 10;

  // Tier bias — Tier 1 is the highest FGA fit, nudge it up.
  const tier = tierOf(industry);
  if (tier === 1) score += 6;
  else if (tier === 3) score -= 2;

  if (c.phone) score += 8;
  if (c.contact_name && c.contact_title) score += 8;
  if (c.google_business_profile_url || c.listed_in_google_maps) score += 5;
  if (c.address || c.hours_visible || c.last_activity_signal) score += 4;

  if (isExcludedCandidate(c, config)) score -= 100;
  return score;
}

/**
 * Classify a candidate's digital presence so outreach/owner can distinguish
 * "no website" from "social-only" / "directory-only" / "owned website". The
 * deep website-truth checks (broken/placeholder) happen during enrichment;
 * here we make the best call from the candidate fields.
 */
function digitalPresenceStatus(c) {
  if (hasLiveWebsite(c)) return 'Owned Website';
  const fb = c.facebook_url || (c.source_urls || []).some((u) => /facebook\.com/i.test(u));
  const gbp = c.google_business_profile_url || c.listed_in_google_maps;
  const dir = (c.source_urls || []).some((u) =>
    /(yelp|angi|thumbtack|homeadvisor|yellowpages|bbb)\./i.test(u));
  if (fb) return 'Social Only';
  if (gbp) return 'Directory Only';
  if (dir) return 'Directory Only';
  return 'Unclear';
}

/**
 * Lightweight module-fit hint computed from the candidate's industry + signals.
 * Enrichment may refine this (e.g. voice_receptionist_signal), but storing a
 * first-pass recommendation means every qualified prospect carries a primary +
 * secondary FGA module, a pain point, and an outreach angle.
 */
function moduleFit(c) {
  const tier = tierOf(c.industry);
  const noSite = !hasLiveWebsite(c);
  // Tier-1 field-service trades: phone-driven, miss calls on the job.
  if (tier === 1) {
    return {
      primary: 'Missed Call Text-Back',
      secondary: noSite ? 'Done-For-You Website' : 'Speed-to-Lead',
      pain_point: 'Misses inbound calls while on the job — lost leads',
      outreach_angle: 'How many calls go to voicemail while you are working?',
      voice_receptionist_fit: true,
    };
  }
  // Tier-2 appointment-based: booking + reviews + follow-up.
  if (tier === 2) {
    return {
      primary: 'Lead Follow-Up',
      secondary: 'Review Request',
      pain_point: 'No-shows and unbooked slots; inconsistent follow-up',
      outreach_angle: 'Automatic follow-up + review requests after every appointment',
      voice_receptionist_fit: false,
    };
  }
  // Tier-3 / exploratory: marketing + web chat presence.
  return {
    primary: noSite ? 'Done-For-You Website' : 'Web Chat',
    secondary: 'Social Content',
    pain_point: 'Thin/inconsistent online presence',
    outreach_angle: 'A simple branded presence + chat that captures inquiries',
    voice_receptionist_fit: false,
  };
}

// ---------------------------------------------------------------------------
// Discovery: find candidate businesses via Serper + Claude
// ---------------------------------------------------------------------------

/**
 * Build a BOUNDED set of discovery queries across the week's industries and the
 * approved states, then cap to maxSerperCalls. Two safeguards bake in here:
 *  - State interleave puts newly-added states next to original ones so the
 *    capped slice always contains a geographic mix (new states get evaluated).
 *  - A per-run dayOffset rotates which (industry,state) pairs are queried each
 *    day, so over a week all combos get covered without exceeding the per-run
 *    Serper budget.
 */
function buildDiscoveryQueries(industries, targetStates, maxSerperCalls, dayOffset = 0) {
  // Interleave original vs newly-added states so a capped slice stays mixed.
  const originals = targetStates.filter((s) => !NEWLY_ADDED_STATES.includes(s));
  const news = targetStates.filter((s) => NEWLY_ADDED_STATES.includes(s));
  const interleaved = [];
  for (let i = 0; i < Math.max(originals.length, news.length); i++) {
    if (i < originals.length) interleaved.push(originals[i]);
    if (i < news.length) interleaved.push(news[i]);
  }

  // 2 queries per (industry, state): one "no website" intent, one FB-listing.
  const pairs = [];
  for (const ind of industries) {
    for (const st of interleaved) pairs.push({ ind, st });
  }
  if (pairs.length === 0) return [];

  // Rotate the starting point by day so coverage spreads across the week.
  const start = ((dayOffset % pairs.length) + pairs.length) % pairs.length;
  const ordered = pairs.slice(start).concat(pairs.slice(0, start));

  // 3 queries per pair (2026-07-03: website no longer disqualifies, so a
  // website-neutral variant joins the two legacy intents), capped to the
  // per-run Serper budget.
  const queries = [];
  for (const { ind, st } of ordered) {
    const n = stateName(st);
    queries.push(`"${ind}" owner-operated ${n} "no website"`);
    queries.push(`small ${ind} business ${n} site:facebook.com`);
    queries.push(`"${ind}" ${n} "family owned" OR "locally owned" reviews`);
    if (queries.length >= maxSerperCalls) break;
  }
  return queries.slice(0, maxSerperCalls);
}

async function searchSerper(query, num = 10) {
  // V1 hardening (2026-05-24): wrap in retry/backoff. Serper rate-limits
  // hard at 429 and the daily prospecting run used to die on the first hit.
  const { withRetry } = require('../../integrations/_retry');
  const response = await withRetry(
    () => axios.post(
      'https://google.serper.dev/search',
      { q: query, num, gl: 'us', hl: 'en' },
      {
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    ),
    {
      attempts: 3,
      onRetry: (err, attempt, delayMs) =>
        console.warn(`[prospecting] Serper retry ${attempt} in ${delayMs}ms: ${err.message}`),
    }
  );
  // Usage-based cost on the ledger (provider=serper). Per-search; override
  // SERPER_SEARCH_COST_USD. Agent/tenant come from the running agent context.
  try {
    require('../../core/ai-safety/usage-tracker').recordUsage({
      provider: 'serper', model: 'serper-search', operationType: 'web_search',
      estimatedCostUsd: Number(process.env.SERPER_SEARCH_COST_USD || 0.001),
      isAutomated: true, requestSource: 'worker/agents/prospecting.js:searchSerper',
    }).catch(() => {});
  } catch (_) { /* never break prospecting */ }
  return response.data || {};
}

async function extractCandidatesWithClaude(searchPayload, config, tenant, industries) {
  const businessName = getConfig(tenant, 'business_name', 'First Gen Automate');
  const icpNotes = getConfig(tenant, 'prospecting_icp_notes', '');
  const empMin = config.employeeMin ?? DEFAULT_EMPLOYEE_MIN;
  const empMax = config.employeeMax ?? DEFAULT_EMPLOYEE_MAX;
  const industryList = Array.isArray(industries) ? industries.join(', ') : String(industries);

  // Bound the model's INPUT and OUTPUT so the candidate JSON can't exceed
  // maxTokens and truncate mid-array (which produced
  // "Expected ',' or ']' after array element in JSON at position ..."). Keep
  // only the fields the extractor needs, cap results per query + total, and
  // cap the number of candidates the model may return.
  const rawResults = (searchPayload && Array.isArray(searchPayload.results)) ? searchPayload.results : [];
  const trimmedResults = rawResults.slice(0, 24).map((r) => ({
    query: r.query,
    organic: (Array.isArray(r.organic) ? r.organic : []).slice(0, 8).map((o) => ({
      title: o.title, link: o.link, snippet: o.snippet,
    })),
  }));
  // Soft target + final slice. The model won't reliably honor this, so we don't
  // depend on it: parseCandidatesLoose salvages complete candidates even when the
  // JSON is truncated, so a cut-off response no longer fails the whole run.
  const MAX_CANDIDATES = 40;

  const systemPrompt = 'You extract structured prospecting candidates from web search results. Return ONLY valid JSON.';
  const userPrompt = `
You are a prospecting scout for ${businessName}.

GOAL: Find very small, owner-operated businesses in these industries:
${industryList}.

TIGHT ICP (all must hold):
- ${empMin}–${empMax} employees (owner-operated micro-business; 1-3 is the
  bullseye, up to ${empMax} is acceptable). If the exact count isn't visible,
  do NOT reject a clearly owner-operated single-location business — estimate
  from signals (owner-operated language, small crew, one or a few service
  vehicles, single location, small review footprint, owner listed as the
  contact) and set "employee_count": null with "size_estimated": true.
- Website status is a SIGNAL, not a filter: include businesses with or
  without their own website, and report what you find in "website". A
  business with NO live site of its own is a bonus (they need one), but a
  small business WITH a modest website is still fully in-ICP. These never
  count as an owned website: Facebook page, Instagram, Yelp, Google Business
  Profile, Angi, Thumbtack, HomeAdvisor, Yellow Pages, directories,
  booking marketplaces.
- Based in one of these states (the business itself, not just service area):
  ${config.targetStates.join(', ')}
- Industries this week: ${industryList}

HARD EXCLUSIONS:
- Industries: ${config.excludedIndustries.join(', ') || '(none)'}
- Keywords: ${config.excludedKeywords.join(', ') || '(none)'}
- Fortune 1000 / franchises / large chains / multi-state operators / PE roll-ups
- Clearly more than ${empMax} employees
- National lead-gen sites pretending to be a local business
${icpNotes ? `\nADDITIONAL TENANT GUIDANCE:\n${icpNotes}\n` : ''}

Return JSON:
{
  "candidates": [
    {
      "company": "string",
      "website": "string or null",
      "industry": "string — one of the target industries above",
      "state": "2-letter abbreviation or null",
      "city": "string or null",
      "employee_count": 2,
      "size": "1-5",
      "size_estimated": false,
      "facebook_url": "string or null",
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
- List the STRONGEST matches FIRST.
- Return AT MOST ${MAX_CANDIDATES} candidates. Keep each candidate compact.
- Output ONLY the JSON object, nothing else.

Search results:
${JSON.stringify({ results: trimmedResults })}
`;

  // Raw text + tolerant parse: the model often ignores the cap and fills
  // maxTokens, truncating the JSON. parseCandidatesLoose salvages the complete
  // (best-first) candidates instead of failing the run on a cut-off response.
  const text = await askClaude(systemPrompt, userPrompt, {
    maxTokens: 8000,
    temperature: 0,
    tenantSlug: tenant.slug,
    operationType: 'prospecting_extract',
  });
  return parseCandidatesLoose(text).slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// DB: insert lead shell (enrichment runs on it right after)
// ---------------------------------------------------------------------------

async function insertLeadShell(tenantId, candidate, score, weekStart, weekIndustries) {
  const leadIndustry = candidate.industry || (weekIndustries && weekIndustries[0]) || null;
  const fit = moduleFit(candidate);
  const metadata = {
    reason: candidate.reason || null,
    source_urls: candidate.source_urls || [],
    prospect_score: score,
    confidence: candidate.confidence || null,
    focus_industry_week: leadIndustry,
    focus_industries_week: Array.isArray(weekIndustries) ? weekIndustries : null,
    industry_tier: tierOf(leadIndustry),
    prospecting_week_start: weekStart,
    google_business_profile_url: candidate.google_business_profile_url || null,
    facebook_url: candidate.facebook_url || null,
    listed_in_google_maps: !!candidate.listed_in_google_maps,
    last_activity_signal: candidate.last_activity_signal || null,
    hours_visible: !!candidate.hours_visible,
    address: candidate.address || null,
    owner_name: candidate.contact_name || null,
    // Geography + size provenance
    size_estimated: !!candidate.size_estimated || !Number.isFinite(Number(candidate.employee_count)),
    digital_presence_status: digitalPresenceStatus(candidate),
    is_new_state: NEWLY_ADDED_STATES.includes(normalizeState(candidate.state)),
    // Module-fit recommendation (enrichment may refine voice fit)
    module_fit_primary: fit.primary,
    module_fit_secondary: fit.secondary,
    pain_point: fit.pain_point,
    outreach_angle: fit.outreach_angle,
    voice_receptionist_signal: { relevant: fit.voice_receptionist_fit, reason: 'prospecting tier heuristic' },
  };

  const domain = candidate.website
    ? String(candidate.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    : null;

  const leadName = candidate.contact_name || candidate.company;

  // City: prefer candidate.city, else parse "City, ST" from the address.
  let city = candidate.city || null;
  if (!city && candidate.address) {
    const m = String(candidate.address).match(/^([^,]+),\s*[A-Z]{2}/);
    if (m) city = m[1].trim();
  }

  const { data, error } = await db
    .from('leads')
    .insert({
      tenant_id: tenantId,
      name: leadName,
      company_name: candidate.company,
      industry: leadIndustry,
      // Mirror industry into service_type so the mobile pipeline shows the
      // "Plumbing" pill instead of being blank.
      service_type: leadIndustry,
      size: normalizeSize(candidate.employee_count, candidate.size),
      employee_count_actual: candidate.employee_count || null,
      website: candidate.website || null,
      domain,
      phone: sanitizePhone(candidate.phone),
      address: candidate.address || null,
      city,
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
// MAIN AGENT — daily, multi-industry top-up to the weekly ceiling (50)
// ============================================================================

async function run(tenant, payload = {}) {
  const log = createLogger('prospecting', tenant.slug);

  if (!process.env.SERPER_API_KEY) throw new Error('SERPER_API_KEY is required');

  const targetStates = safeArray(getConfig(tenant, 'target_states', [])).map(normalizeState);
  const targetIndustries = safeArray(getConfig(tenant, 'target_industries', [])).map(normalizeIndustry);
  const excludedIndustries = safeArray(getConfig(tenant, 'excluded_industries', [])).map(normalizeIndustry);
  const excludedKeywords = safeArray(getConfig(tenant, 'excluded_keywords', []));
  // Default flipped true -> false (Patrick 2026-07-03): having a website is a
  // scoring signal now, never an exclusion.
  const requireNoWebsite = String(getConfig(tenant, 'require_no_website', 'false')) === 'true';
  const scoreThreshold = Number(getConfig(tenant, 'score_threshold', DEFAULT_SCORE_THRESHOLD));
  const weeklyTarget = Number(getConfig(tenant, 'weekly_prospect_target', DEFAULT_WEEKLY_TARGET));
  const employeeMin = Number(getConfig(tenant, 'min_employees', DEFAULT_EMPLOYEE_MIN));
  const employeeMax = Number(getConfig(tenant, 'max_employees', DEFAULT_EMPLOYEE_MAX));
  const industriesPerWeek = Number(getConfig(tenant, 'industries_per_week', DEFAULT_INDUSTRIES_PER_WEEK));
  const dailyCandidateCap = Number(
    payload.daily_cap || getConfig(tenant, 'daily_candidate_cap', DEFAULT_DAILY_CANDIDATE_CAP)
  );
  const maxSerperCalls = Number(
    payload.max_serper_calls || getConfig(tenant, 'max_serper_calls_per_run', DEFAULT_MAX_SERPER_CALLS_PER_RUN)
  );

  if (!targetStates.length) throw new Error('Missing required ICP configuration: target_states');
  if (!targetIndustries.length) throw new Error('Missing required ICP configuration: target_industries');

  // Resolve this week's focus industries (set of 3-5; advances on Tue).
  // payload.industries / payload.industry still override for manual runs.
  let weekIndustries, weekStart;
  if (payload.industries || payload.industry) {
    weekIndustries = safeArray(payload.industries || [payload.industry]).map(normalizeIndustry);
    weekStart = currentWeekStartTuesdayET();
    log.info(`Override industries: ${weekIndustries.join(', ')} (week ${weekStart})`);
  } else {
    const r = await resolveWeeklyIndustries(tenant, targetIndustries, industriesPerWeek, log);
    weekIndustries = r.industries;
    weekStart = r.weekStart;
  }

  // Adaptive target: in autonomous mode, discovery keeps feeding until the
  // weekly SEND target can be met (email-coverage aware). See helper above.
  const effectiveWeeklyTarget = await computeAdaptiveWeeklyTarget(tenant, weeklyTarget, log);

  // Weekly ceiling (GLOBAL across industries) + daily pace.
  const alreadyQualified = await countQualifiedThisWeek(tenant.id, weekStart);
  const weeklyRemaining = Math.max(0, effectiveWeeklyTarget - alreadyQualified);

  const paceTarget = dailyPaceTarget(tenant, effectiveWeeklyTarget);
  const qualifiedToday = await countQualifiedToday(tenant.id);
  const dailyRemaining = Math.max(0, paceTarget - qualifiedToday);

  // This run only tries to add the SMALLER of the weekly and daily remainders.
  const needed = Math.min(weeklyRemaining, dailyRemaining);
  log.info(
    `weekly_target=${effectiveWeeklyTarget} week_qualified=${alreadyQualified} weekly_remaining=${weeklyRemaining} | ` +
    `pace_today=${paceTarget} qualified_today=${qualifiedToday} daily_remaining=${dailyRemaining} | needed_this_run=${needed}`
  );

  if (needed === 0) {
    const reason = weeklyRemaining === 0 ? 'weekly_ceiling_reached' : 'daily_pace_met';
    log.info(`No-op: ${reason}`);
    return {
      success: true,
      focus_industries: weekIndustries,
      week_start: weekStart,
      weekly_target: effectiveWeeklyTarget,
      already_qualified: alreadyQualified,
      weekly_remaining: weeklyRemaining,
      daily_pace_target: paceTarget,
      qualified_today: qualifiedToday,
      needed: 0,
      newly_qualified: 0,
      stop_reason: reason,
      message: `No-op — ${reason}`,
    };
  }

  const config = {
    targetStates, targetIndustries, excludedIndustries, excludedKeywords,
    requireNoWebsite, weeklyTarget: effectiveWeeklyTarget, employeeMin, employeeMax,
  };

  // Day-of-year offset rotates which (industry,state) pairs get queried, so a
  // week of capped runs covers the full grid without exceeding the per-run cap.
  const dayOffset = Math.floor(Date.now() / 86400000);
  const queries = buildDiscoveryQueries(weekIndustries, targetStates, maxSerperCalls, dayOffset);
  log.info(`Discovery: ${queries.length} Serper queries (cap ${maxSerperCalls}) across ${weekIndustries.length} industries × ${targetStates.length} states`);

  let serperCalls = 0;
  const allResults = [];
  for (const q of queries) {
    if (serperCalls >= maxSerperCalls) break; // hard per-run API ceiling
    try {
      const d = await searchSerper(q, 10);
      serperCalls++;
      allResults.push({
        query: q,
        organic: d.organic || [],
        places: d.places || [],
        knowledgeGraph: d.knowledgeGraph || null,
      });
    } catch (err) {
      serperCalls++; // count the attempt against the budget even on failure
      log.warn(`Serper discovery failed: ${q}`, { error: err.message });
    }
  }

  const extracted = await extractCandidatesWithClaude(
    { results: allResults }, config, tenant, weekIndustries
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

  // Process candidates: dedup → insert shell → enrich inline → count if qualified.
  // Stops at: weekly remainder, daily pace remainder, or daily candidate cap.
  let newlyQualified = 0;
  let candidatesProcessed = 0;
  let stopReason = 'exhausted_candidates';
  const processed = [];
  const errors = [];
  const byState = {};   // qualified per state
  const byIndustry = {}; // qualified per industry

  for (const { candidate, score } of scored) {
    if (newlyQualified >= needed) {
      stopReason = weeklyRemaining - newlyQualified <= 0 ? 'weekly_ceiling_reached' : 'daily_pace_met';
      processed.push({ company: candidate.company, action: 'target_hit', score });
      break;
    }
    if (candidatesProcessed >= dailyCandidateCap) {
      stopReason = 'daily_candidate_cap';
      processed.push({ company: candidate.company, action: 'daily_cap_hit', score });
      log.warn(`Hit daily candidate cap (${dailyCandidateCap}) — stopping`);
      break;
    }

    // AI-pace guard (2026-07-21): stay safely under the ai-safety
    // agent_per_hour watermark instead of tripping it on heavy Tuesday runs.
    // Checked every 5 candidates (each check is one cheap head-count on
    // ai_usage_events). Stopping here loses nothing: remaining candidates are
    // re-discovered by tomorrow's top-up run, exactly like the daily cap.
    // Defensive — a tracker failure never blocks prospecting.
    if (candidatesProcessed > 0 && candidatesProcessed % 5 === 0) {
      try {
        const tracker = require('../../core/ai-safety/usage-tracker');
        const { thresholds } = require('../../core/ai-safety/flags');
        const watermark = thresholds.maxCallsPerAgentPerHour();
        const paceLimit = Math.max(50, watermark - 50);
        const callsThisHour = await tracker.countCalls({ minutes: 60, agentName: 'prospecting' });
        if (callsThisHour >= paceLimit) {
          stopReason = 'hourly_ai_pace_guard';
          processed.push({ company: candidate.company, action: 'ai_pace_guard', score });
          log.warn(`AI pace guard: ${callsThisHour} Claude calls this hour (pace limit ${paceLimit}, watermark ${watermark}) — deferring remaining candidates to the next run`);
          break;
        }
      } catch (_) { /* never let the guard break prospecting */ }
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

      // 1. Insert shell (tagged with the week's industry set + module fit)
      const lead = await insertLeadShell(tenant.id, candidate, score, weekStart, weekIndustries);
      candidatesProcessed++;

      // 2. Enrich inline (Serper + Apify FB + Claude inside enrichOne)
      const enriched = await enrichment.enrichOne(tenant, lead);

      if (enriched.qualified) {
        newlyQualified++;
        const st = normalizeState(candidate.state) || 'unknown';
        const ind = candidate.industry || weekIndustries[0] || 'unknown';
        byState[st] = (byState[st] || 0) + 1;
        byIndustry[ind] = (byIndustry[ind] || 0) + 1;
        processed.push({
          company: candidate.company,
          action: 'QUALIFIED',
          score,
          state: st,
          industry: ind,
          reason: enriched.reason,
          lead_id: lead.id,
        });
        log.info(
          `Qualified #${alreadyQualified + newlyQualified}/${effectiveWeeklyTarget} (${ind}, ${st}): ${candidate.company}`
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

  // Weekly pace indicator for the dashboard.
  const weekTotalNow = alreadyQualified + newlyQualified;
  let pace;
  if (weekTotalNow >= effectiveWeeklyTarget) pace = 'Target Reached';
  else {
    // Expected progress by end of today vs actual.
    const expectedByNow = Math.min(effectiveWeeklyTarget, paceTarget); // simple per-day expectation
    if (qualifiedToday + newlyQualified >= expectedByNow) pace = 'On Pace';
    else pace = 'Behind Pace';
  }
  if (stopReason === 'daily_candidate_cap') pace = 'Paused by Safety Limit';

  const result = {
    success: true,
    focus_industries: weekIndustries,
    week_start: weekStart,
    weekly_target: effectiveWeeklyTarget,
    already_qualified: alreadyQualified,
    weekly_remaining_at_start: weeklyRemaining,
    daily_pace_target: paceTarget,
    qualified_today_at_start: qualifiedToday,
    needed_at_start_of_run: needed,
    newly_qualified: newlyQualified,
    week_total_now: weekTotalNow,
    pace_indicator: pace,
    stop_reason: stopReason,
    serper_calls: serperCalls,
    serper_cap: maxSerperCalls,
    candidates_processed: candidatesProcessed,
    daily_candidate_cap: dailyCandidateCap,
    discovered: extracted.length,
    qualified_after_score: scored.length,
    qualified_by_state: byState,
    qualified_by_industry: byIndustry,
    errors,
    processed,
  };

  log.success('Prospecting run complete', {
    focus_industries: weekIndustries.join(', '),
    week_total_now: weekTotalNow,
    weekly_target: effectiveWeeklyTarget,
    stop_reason: stopReason,
    serper_calls: serperCalls,
    errors: errors.length,
  });
  return result;
}

module.exports = run;
// Pure helpers exposed for unit tests (no DB / no network).
module.exports._internals = {
  tierOf,
  chooseWeeklyIndustries,
  buildDiscoveryQueries,
  scoreCandidate,
  digitalPresenceStatus,
  moduleFit,
  normalizeSize,
  dailyPaceTarget,
  TIER1_INDUSTRIES,
  TIER2_INDUSTRIES,
  TIER3_INDUSTRIES,
  NEWLY_ADDED_STATES,
  DEFAULT_WEEKLY_TARGET,
  DEFAULT_DAILY_CANDIDATE_CAP,
  DEFAULT_MAX_SERPER_CALLS_PER_RUN,
};
