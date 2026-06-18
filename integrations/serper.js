/**
 * integrations/serper.js — shared Serper (Google search) adapter.
 *
 * A typed provider adapter so the discovery engine never calls the HTTP API
 * directly. Wraps retry/backoff and records spend on the AI-safety ledger
 * (provider='serper'). Existing agents (prospecting/enrichment) keep their own
 * inline copies; this is the shared path for new code (commercial-discovery).
 *
 * Env: SERPER_API_KEY (required), SERPER_SEARCH_COST_USD (optional, default 0.001).
 */

const axios = require('axios');
const { withRetry } = require('./_retry');

const COST = Number(process.env.SERPER_SEARCH_COST_USD || 0.001);

function isConfigured() { return !!process.env.SERPER_API_KEY; }

/**
 * Run one search. Returns { ok, costUsd, organic[], places[], raw }.
 * Never throws on provider error — returns { ok:false } so the orchestrator can
 * keep going and record the failed source.
 */
async function search(query, { num = 10, gl = 'us', hl = 'en', meta = {} } = {}) {
  if (!isConfigured()) return { ok: false, costUsd: 0, organic: [], places: [], error: 'SERPER_API_KEY not set' };
  let res;
  try {
    res = await withRetry(
      () => axios.post(
        'https://google.serper.dev/search',
        { q: query, num, gl, hl },
        { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
      ),
      { attempts: 3 }
    );
  } catch (e) {
    // Record the (failed) call cost — Serper counts attempts against the budget.
    _record(meta);
    return { ok: false, costUsd: COST, organic: [], places: [], error: e.message };
  }
  _record(meta);
  const d = (res && res.data) || {};
  return {
    ok: true, costUsd: COST,
    organic: Array.isArray(d.organic) ? d.organic : [],
    places: Array.isArray(d.places) ? d.places : [],
    knowledgeGraph: d.knowledgeGraph || null,
    raw: d,
  };
}

function _record(meta) {
  try {
    require('../core/ai-safety/usage-tracker').recordUsage({
      provider: 'serper', model: 'serper-search', operationType: 'web_search',
      estimatedCostUsd: COST, isAutomated: true,
      agentName: meta.agentName || 'commercial-discovery', tenantId: meta.tenantId,
      requestSource: meta.requestSource || 'integrations/serper.js:search',
    }).catch(() => {});
  } catch (_) { /* never break discovery */ }
}

module.exports = { isConfigured, search, COST };
