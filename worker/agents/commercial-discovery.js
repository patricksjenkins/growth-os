/**
 * worker/agents/commercial-discovery.js — 923A Commercial & Event Opportunity Agent.
 *
 * Lives in growth-os so it can reuse Serper, Apify, the callClaude chokepoint, the
 * AI-safety/usage ledger, and the worker+scheduler — but writes its results into
 * 923A's separate front-door Supabase (integrations/supabase-923a.js). It is
 * SEPARATE from the Federal (SAM.gov) agent, which lives in the 923A site.
 *
 * Hard-scoped to the 923A tenant + an isolated $15/mo budget. Idle by default:
 * the scheduler `when` predicate only enqueues it for 923A when discovery is
 * enabled, not paused, and under budget — so a dormant agent makes zero API calls.
 *
 * payload.mode:
 *   'daily_monitor'   — recompute windows/score/stage on existing opps (no web).
 *   'discovery_tue'   — endurance + community + military profiles.
 *   'discovery_thu'   — sports + schools + corporate + conferences + clubs.
 *   'quality'         — Saturday: recompute, close past events, summarize.
 *   'monthly'         — extended-horizon discovery across all profiles.
 *   'targeted_search' — claim + run one queued targeted-search request.
 *   'run_now'         — payload.spec is a full discovery spec (manual trigger).
 */

const supa = require('../../integrations/supabase-923a');
const { runDiscovery } = require('../../core/commercial/discovery');
const { computeIntelligence } = require('../../core/commercial/scoring');
const { createLogger } = require('../../core/logger');

const log = createLogger('commercial-discovery');
const SLUG = '923a-coins';

const TUE_PROFILES = ['endurance', 'community_fundraising', 'military_first_responder'];
const THU_PROFILES = ['sports', 'schools_rotc', 'corporate', 'conferences', 'clubs'];
const ALL_PROFILES = [...TUE_PROFILES, ...THU_PROFILES];

async function run(tenant, payload = {}) {
  // Hard guard: this agent only ever runs for 923A.
  if (!tenant || tenant.slug !== SLUG) return { skipped: 'not 923A' };
  if (!supa.isConfigured()) { log.warn('923A Supabase not configured — idle'); return { skipped: 'unconfigured' }; }

  const cfg = await supa.getConfig().catch(() => ({ enabled: false }));
  if (!cfg.enabled) return { skipped: 'disabled' };
  if (cfg.paused) return { skipped: 'paused' };

  const mode = payload.mode || 'daily_monitor';

  // The cheap monitor can always run. Broad discovery respects a run-lock.
  if (mode !== 'daily_monitor') {
    const active = await supa.activeRunExists().catch(() => false);
    if (active) return { skipped: 'a discovery run is already active' };
  }

  switch (mode) {
    case 'daily_monitor': return monitor();
    case 'discovery_tue': return discover(tenant, { trigger: 'scheduled', mode: 'tuesday', profiles: TUE_PROFILES });
    case 'discovery_thu': return discover(tenant, { trigger: 'scheduled', mode: 'thursday', profiles: THU_PROFILES });
    case 'monthly': return discover(tenant, { trigger: 'scheduled', mode: 'monthly', profiles: ALL_PROFILES, caps: { rawCap: 220, deepCap: 60, enrichCap: 30, queriesPerProfile: 14 } });
    case 'quality': return quality();
    case 'targeted_search': return targeted(tenant);
    case 'run_now': return discover(tenant, payload.spec || { trigger: 'manual', mode: 'run_now', profiles: ALL_PROFILES });
    default: return monitor();
  }
}

// ---- Daily monitor: recompute windows/score/stage, no web calls -------------
async function monitor() {
  const opps = await supa.listActiveOpportunities(500).catch(() => []);
  let refreshed = 0; let moved = 0; let closed = 0;
  const past = ['outreach_drafted', 'outreach_sent', 'replied', 'quote_requested', 'proposal_sent', 'won', 'lost', 'no_fit', 'closed'];
  const derivedStages = ['new', 'future_outreach', 'contact_soon', 'contact_now', 'research_needed', 'annual_repeat'];
  for (const o of opps) {
    const intel = computeIntelligence(model(o));
    const patch = {
      score: intel.score, band: intel.band, confidence: intel.confidence,
      window_start: intel.window.start, window_end: intel.window.end, first_outreach: intel.window.firstOutreach,
      intel, last_discovered_at: o.last_discovered_at || null,
    };
    // Only the monitor moves timing stages; never overrides an owner-set stage.
    if (!o.stage || derivedStages.includes(o.stage)) { if (intel.stage !== o.stage) moved++; patch.stage = intel.stage; }
    if (intel.stage === 'annual_repeat' && !past.includes(o.stage)) closed++;
    try { await supa.updateOpportunity(o.id, patch); refreshed++; } catch (_) { /* keep going */ }
  }
  log.info(`Monitor: refreshed ${refreshed}, moved ${moved}`);
  return { mode: 'daily_monitor', refreshed, moved, closed };
}

// ---- Saturday quality run: monitor + light summary --------------------------
async function quality() {
  const m = await monitor();
  // (Duplicate-merge + source-conflict review is a future enhancement; the monitor
  // already keeps windows/stages correct and closes past occurrences.)
  return { mode: 'quality', ...m };
}

// ---- Scheduled / manual web discovery --------------------------------------
async function discover(tenant, spec) {
  const summary = await runDiscovery(tenant, spec);
  if (summary.created > 0) {
    await supa.notifyOwner(
      `${summary.created} new commercial ${summary.created === 1 ? 'opportunity' : 'opportunities'}`,
      `Discovery (${summary.mode}) added ${summary.created} and updated ${summary.updated}. Cost $${summary.costUsd}.`,
      {}
    ).catch(() => {});
  }
  return summary;
}

// ---- Targeted-search queue consumer ----------------------------------------
async function targeted(tenant) {
  const req = await supa.claimSearchRequest().catch(() => null);
  if (!req) return { mode: 'targeted_search', skipped: 'no queued requests' };

  const extra = {};
  if (req.region) extra.state = req.region;
  // Parse an optional product focus + min-score out of the free-text query.
  const minMatch = String(req.query || '').match(/min score (\d{1,3})/i);
  const minScore = minMatch ? Math.min(100, Number(minMatch[1])) : 55;
  if (req.query) extra.product = req.query.replace(/min score \d{1,3}/i, '').slice(0, 60);

  const spec = {
    trigger: 'targeted', mode: 'targeted_search',
    profiles: req.profile ? [req.profile] : ['endurance'],
    extra, minScore, apifyOk: true,
    caps: { rawCap: 80, deepCap: 30, enrichCap: 15, queriesPerProfile: 12 },
    searchRequestId: req.id, goalQualified: Number(req.goal_qualified) || 10,
  };

  await supa.updateSearchRequest(req.id, { status: 'searching', started_at: new Date().toISOString() }).catch(() => {});
  const summary = await runDiscovery(tenant, spec);
  const status = summary.status === 'failed' ? 'failed' : (summary.created > 0 ? 'completed' : 'partial');
  await supa.updateSearchRequest(req.id, {
    status, completed_at: new Date().toISOString(),
    raw_results: summary.rawResults, unique_candidates: summary.uniqueCandidates,
    qualified: summary.qualified, opportunities_created: summary.created,
    duplicates: summary.duplicates, rejected: summary.rejected,
    cost_usd: summary.costUsd, note: summary.notes.join('; ').slice(0, 500) || null,
  }).catch(() => {});
  await supa.notifyOwner(`Targeted search done: ${summary.created} found`, `"${(req.query || req.profile || '').slice(0, 80)}" → ${summary.created} opportunities.`, {}).catch(() => {});
  return { mode: 'targeted_search', requestId: req.id, ...summary };
}

function model(o) {
  return {
    profile: o.profile, event_name: o.event_name, organization: o.organization, website: o.website,
    notes: o.notes, event_date: o.event_date, date_confidence: o.date_confidence,
    prior_year_date: o.prior_year_date, recurring: o.recurring, size_tier: o.size_tier,
    attendance: o.attendance, product_evidence: o.product_evidence, stage: o.stage,
    contacts: o.contacts || [], source_url: o.source_url,
  };
}

module.exports = run;
module.exports._internals = { monitor, targeted, TUE_PROFILES, THU_PROFILES };
