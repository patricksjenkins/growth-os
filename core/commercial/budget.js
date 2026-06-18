/**
 * core/commercial/budget.js — isolated, owner-visible discovery budget guard.
 *
 * Tracks Serper + Apify + Claude spend for 923A commercial discovery against a
 * monthly cap (default $15, approved 2026-06-17) stored in 923A's own Supabase so
 * the owner sees it in the Command Center. Independent of the platform tier caps —
 * hitting this budget pauses ONLY commercial discovery, never the rest of 923A.
 *
 * Provider unit costs (overridable via env, matching the platform ledger):
 *   Serper: SERPER_SEARCH_COST_USD (default 0.001)
 *   Apify:  APIFY_RUN_COST_USD     (default 0.01)
 *   Claude: estimated per call (~$0.01 for the bounded extraction prompt)
 */

const supa = require('../../integrations/supabase-923a');

const SERPER_COST = Number(process.env.SERPER_SEARCH_COST_USD || 0.001);
const APIFY_COST = Number(process.env.APIFY_RUN_COST_USD || 0.01);
const CLAUDE_COST = Number(process.env.COMMERCIAL_CLAUDE_COST_USD || 0.01); // bounded ~1.2k-token extraction

// Build a per-run budget tracker pre-loaded with this month's spend + the cap.
async function load() {
  const [cfg, month] = await Promise.all([supa.getConfig(), supa.getMonthBudget()]);
  const cap = Number(cfg.monthly_budget_usd || 15);
  let spent = Number(month.total_cost_usd || 0);
  let serper = 0; let apify = 0; let claude = 0; let runCost = 0;

  const remaining = () => Math.max(0, cap - spent);
  const overHardStop = () => cap > 0 && spent >= cap * (cfg.hardstop_percent / 100 || 1);
  const overWarn = () => cap > 0 && spent >= cap * (cfg.warn_percent / 100 || 0.7);

  return {
    cfg, cap,
    get spent() { return spent; },
    get runCost() { return runCost; },
    counts: () => ({ serper, apify, claude }),
    remaining, overHardStop, overWarn,
    // Can we afford one more op of this kind?
    canSerper() { return !overHardStop() && remaining() >= SERPER_COST; },
    canApify() { return !overHardStop() && remaining() >= APIFY_COST; },
    canClaude() { return !overHardStop() && remaining() >= CLAUDE_COST; },
    addSerper() { serper++; spent += SERPER_COST; runCost += SERPER_COST; },
    addApify() { apify++; spent += APIFY_COST; runCost += APIFY_COST; },
    addClaude() { claude++; spent += CLAUDE_COST; runCost += CLAUDE_COST; },
    // Persist the run's accumulated spend back to 923A's monthly budget row.
    async flush() {
      if (serper || apify || claude) {
        await supa.addSpend({ serper, apify, claude, costUsd: runCost }).catch(() => {});
      }
      return { serper, apify, claude, runCost };
    },
  };
}

module.exports = { load, SERPER_COST, APIFY_COST, CLAUDE_COST };
