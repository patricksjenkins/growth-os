/**
 * core/commercial/discovery.js — commercial discovery ORCHESTRATOR.
 *
 * The single place that runs the full path for a discovery spec:
 *   queries → Serper search → normalize + canonicalize → dedupe → Stage-1 qualify
 *   → bounded page fetch + Apify(FB) enrichment → Stage-2 Claude deep research
 *   → score + buying window (shared engine) → creation threshold → upsert into
 *   923A's Supabase (opportunity + sources + series) → run audit.
 *
 * Every paid op is gated by BOTH a hard per-run cap AND the isolated $15/mo budget.
 * Raw results never become opportunities automatically (threshold + Stage gates).
 * Returns a full run summary. Never throws past the run-level try/catch.
 */

const serper = require('../../integrations/serper');
const supa = require('../../integrations/supabase-923a');
const budgetMod = require('./budget');
const { generateQueries, DEFAULT_STATES } = require('./queries');
const { canonicalUrl, sourceTier, sourceType } = require('./sources');
const { qualifyCandidate, worthDeepResearch } = require('./qualify');
const { fetchCandidate } = require('./extract');
const { deepResearch } = require('./deep-research');
const { computeIntelligence, dedupeKey, seriesKey } = require('./scoring');
const { createLogger } = require('../logger');

const log = createLogger('commercial-discovery');

const DEFAULT_CAPS = { rawCap: 150, deepCap: 40, enrichCap: 25, queriesPerProfile: 12 };

// Map an internal class/timing into the stored stage (timing can override fit).
function placeOpportunity(intel) {
  // intel.stage already reflects timing (future/contact_soon/contact_now/research).
  return intel.stage;
}

/**
 * @param tenant growth-os tenant (Claude cost attribution)
 * @param spec {
 *   trigger: 'scheduled'|'manual'|'targeted'|'monitor',
 *   mode: string (label),
 *   profiles: string[],
 *   states?: string[],
 *   caps?: { rawCap, deepCap, enrichCap, queriesPerProfile },
 *   extra?: { state, product },       // targeted-search pins
 *   apifyOk?: boolean,                 // allow paid FB extraction
 *   minScore?: number,                 // creation threshold override
 *   searchRequestId?: string,          // link opportunities to a targeted request
 *   goalQualified?: number,            // stop after N created (targeted)
 * }
 */
async function runDiscovery(tenant, spec) {
  const caps = { ...DEFAULT_CAPS, ...(spec.caps || {}) };
  const states = spec.states || DEFAULT_STATES;
  const minScore = spec.minScore != null ? spec.minScore : 40;
  const apifyOk = spec.apifyOk !== false; // default allow (still budget+cap gated)
  const profiles = (spec.profiles && spec.profiles.length) ? spec.profiles : ['endurance'];

  const summary = {
    trigger: spec.trigger, mode: spec.mode, profiles,
    queries: 0, rawResults: 0, uniqueCandidates: 0, qualified: 0,
    created: 0, updated: 0, duplicates: 0, rejected: 0, errors: 0,
    serperCalls: 0, apifyCalls: 0, claudeCalls: 0, costUsd: 0,
    status: 'completed', notes: [], topCreated: [],
  };

  if (!supa.isConfigured()) { summary.status = 'failed'; summary.notes.push('923A Supabase not configured'); return summary; }

  const budget = await budgetMod.load();
  if (!budget.cfg.enabled || budget.cfg.paused) { summary.status = 'cancelled'; summary.notes.push(budget.cfg.paused ? 'agent paused' : 'discovery disabled'); return summary; }
  if (budget.overHardStop()) { summary.status = 'cancelled'; summary.notes.push(`monthly budget reached ($${budget.spent.toFixed(2)}/$${budget.cap})`); return summary; }

  const runId = await supa.startRun({
    trigger: spec.trigger, mode: spec.mode, profiles, started_at: new Date().toISOString(),
    search_request_id: spec.searchRequestId || null, status: 'running',
  }).catch((e) => { summary.notes.push('startRun: ' + e.message); return null; });

  const seenUrls = new Set();
  const seenDedupe = new Set();
  const deepQueue = []; // { result, profile, query, stage1 }

  try {
    // ---- SEARCH + STAGE-1 ----
    for (const profile of profiles) {
      if (!budget.canSerper()) { summary.notes.push('budget reached during search'); break; }
      const recent = await supa.recentQueries(profile, 14).catch(() => []);
      const queries = generateQueries(profile, { cap: caps.queriesPerProfile, states, recent, extra: spec.extra || {} });
      for (const q of queries) {
        if (!budget.canSerper() || summary.rawResults >= caps.rawCap) break;
        const r = await serper.search(q, { num: 10, meta: { tenantId: tenant && tenant.id, agentName: 'commercial-discovery', requestSource: 'discovery.search' } });
        budget.addSerper(); summary.serperCalls++; summary.queries++;
        await supa.recordQuery({ profile, query: q, results: (r.organic || []).length, trigger: spec.trigger }).catch(() => {});
        if (!r.ok) { summary.errors++; continue; }
        const results = [...(r.organic || []), ...(r.places || []).map((p) => ({ title: p.title, link: p.website || p.link, snippet: p.address || '' }))];
        summary.rawResults += results.length;
        for (const res of results) {
          const link = res.link || res.url; if (!link) continue;
          const canon = canonicalUrl(link);
          if (seenUrls.has(canon)) continue;
          seenUrls.add(canon);
          summary.uniqueCandidates++;
          const stage1 = qualifyCandidate({ ...res, link: canon }, profile, q);
          if (worthDeepResearch(stage1.class)) deepQueue.push({ canon, link, profile, query: q, stage1, title: res.title });
          else summary.rejected++;
        }
      }
    }

    // Rank deep candidates by Stage-1 score, take the top deepCap.
    deepQueue.sort((a, b) => b.stage1.score - a.stage1.score);
    const deepList = deepQueue.slice(0, caps.deepCap);

    // ---- STAGE-2 DEEP RESEARCH + UPSERT ----
    let enrichUsed = 0;
    for (const cand of deepList) {
      if (spec.goalQualified && summary.created >= spec.goalQualified) { summary.notes.push('reached qualified goal'); break; }
      if (!budget.canClaude()) { summary.notes.push('budget reached during research'); summary.status = 'partial'; break; }

      const isFb = /facebook\.com/i.test(cand.canon);
      const allowApifyHere = apifyOk && isFb && enrichUsed < caps.enrichCap && budget.canApify();
      if (isFb && !allowApifyHere) continue; // skip FB we can't afford to extract

      let page;
      try { page = await fetchCandidate(cand.canon, { apifyOk: allowApifyHere }); }
      catch (e) { summary.errors++; continue; }
      if (page && page.usedApify) { budget.addApify(); summary.apifyCalls++; enrichUsed++; }
      if (!page || !page.ok) { summary.errors++; await recordSource(cand, null, 'fetch_failed'); continue; }

      const dr = await deepResearch({ url: cand.canon, profile: cand.profile, stage1: cand.stage1, page }, tenant);
      budget.addClaude(); summary.claudeCalls++;
      if (!dr.ok || !dr.event || !dr.event.event_name) { summary.rejected++; await recordSource(cand, null, 'not_opportunity'); continue; }

      const ev = dr.event;
      const dk = dedupeKey(ev);
      if (seenDedupe.has(dk)) { summary.duplicates++; continue; }
      seenDedupe.add(dk);

      const intel = computeIntelligence(ev);
      // Creation threshold — below minScore stays in the audit only (not the pipeline).
      if (intel.score < minScore && !(ev.recurring && ev._priorYearEvidence)) {
        summary.rejected++;
        await recordSource(cand, null, `below_threshold(${intel.score})`);
        continue;
      }
      summary.qualified++;

      // Event-occurrence dedupe across prior runs (different source, same event).
      const existing = await supa.findByDedupe(dk).catch(() => null);
      const sk = seriesKey(ev);
      const seriesId = await supa.upsertSeries({
        series_key: sk, name: ev.event_name, organization: ev.organization, profile: ev.profile,
        typical_month: ev.event_date ? Number(String(ev.event_date).slice(5, 7)) : null,
        recurring: ev.recurring, last_seen_at: new Date().toISOString(),
      }).catch(() => null);

      const row = {
        profile: ev.profile, event_name: ev.event_name, organization: ev.organization,
        website: ev.website, location: ev.location, event_date: ev.event_date,
        date_confidence: ev.date_confidence, recurring: ev.recurring, size_tier: ev.size_tier,
        attendance: ev.attendance, product_evidence: ev.product_evidence, contacts: ev.contacts,
        notes: ev.notes, source_url: ev.source_url, source: 'discovery',
        dedupe_key: dk, series_key: sk, series_id: seriesId,
        score: intel.score, band: intel.band, confidence: intel.confidence,
        window_start: intel.window.start, window_end: intel.window.end, first_outreach: intel.window.firstOutreach,
        intel, stage: placeOpportunity(intel),
        discovery_run_id: runId, last_discovered_at: new Date().toISOString(),
        source_tier: cand.stage1.tier,
      };

      try {
        if (existing) {
          // Don't overwrite owner-managed stages/notes; refresh evidence + computed cache.
          const patch = {
            score: row.score, band: row.band, confidence: row.confidence,
            window_start: row.window_start, window_end: row.window_end, first_outreach: row.first_outreach,
            intel: row.intel, last_discovered_at: row.last_discovered_at, series_id: seriesId,
          };
          if (!existing.contacts || !existing.contacts.length) patch.contacts = row.contacts;
          if (!existing.event_date && row.event_date) { patch.event_date = row.event_date; patch.date_confidence = row.date_confidence; }
          await supa.updateOpportunity(existing.id, patch);
          await recordSource(cand, existing.id, 'updated');
          summary.updated++;
        } else {
          const inserted = await supa.insertOpportunity(row);
          await recordSource(cand, inserted && inserted.id, 'created');
          summary.created++;
          if (summary.topCreated.length < 8) summary.topCreated.push({ event: ev.event_name, score: intel.score, stage: row.stage, date: ev.event_date });
        }
        if (spec.searchRequestId && !existing) {
          // best-effort association handled by run summary; request progress updated by caller
        }
      } catch (e) {
        summary.errors++; summary.notes.push('upsert: ' + e.message);
      }
    }

    async function recordSource(cand, oppId, evidence) {
      await supa.insertSource({
        opportunity_id: oppId || null, url: cand.link, canonical_url: cand.canon,
        domain: (cand.canon.match(/^https?:\/\/([^/]+)/) || [])[1] || null,
        source_tier: cand.stage1.tier, source_type: cand.stage1.type,
        profile: cand.profile, evidence, retrieved_at: new Date().toISOString(),
        discovery_run_id: runId,
      }).catch(() => {});
    }

    summary.costUsd = Number(budget.runCost.toFixed(4));
    await budget.flush();
    if (budget.overHardStop()) summary.notes.push('monthly budget now reached — discovery will pause until next month');

    await supa.finishRun(runId, {
      status: summary.status, queries: summary.queries, raw_results: summary.rawResults,
      unique_candidates: summary.uniqueCandidates, qualified: summary.qualified,
      opportunities_created: summary.created, opportunities_updated: summary.updated,
      duplicates: summary.duplicates, rejected: summary.rejected, errors: summary.errors,
      serper_calls: summary.serperCalls, apify_calls: summary.apifyCalls, claude_calls: summary.claudeCalls,
      cost_usd: summary.costUsd, summary,
    }).catch(() => {});

    log.info(`Discovery ${spec.mode}: created ${summary.created}, updated ${summary.updated}, qualified ${summary.qualified}, cost $${summary.costUsd}`);
    return summary;
  } catch (err) {
    summary.status = 'failed'; summary.errors++; summary.notes.push('fatal: ' + err.message);
    summary.costUsd = Number(budget.runCost.toFixed(4));
    await budget.flush().catch(() => {});
    await supa.finishRun(runId, { status: 'failed', errors: summary.errors, cost_usd: summary.costUsd, summary }).catch(() => {});
    log.error(`Discovery ${spec.mode} failed: ${err.message}`);
    return summary;
  }
}

module.exports = { runDiscovery, DEFAULT_CAPS };
