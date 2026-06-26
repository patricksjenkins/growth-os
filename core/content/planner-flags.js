/**
 * Content Planner — feature flags + thresholds.
 *
 * The strategy-first two-stage workflow (weekly plan → concept approval →
 * finalize) is gated per tenant. Default ON for the FGA tenant only; client
 * tenants keep the existing direct draft→approve flow until explicitly
 * enabled. Everything reads from tenant_config via getConfig so it can be
 * tuned without a deploy.
 */

const { getConfig } = require('../config');

function isPlannerEnabled(tenant) {
  if (!tenant) return false;
  return !!getConfig(tenant, 'content_planner_enabled', tenant.slug === 'fga');
}

// Headless screenshot capture is a heavier, security-sensitive subsystem with
// its own kill switch so the rest of the pipeline ships even if the browser
// image needs tuning. Default ON for FGA, graceful-degrades to generated art.
function screenshotsEnabled(tenant) {
  if (!tenant) return false;
  return !!getConfig(tenant, 'content_screenshots_enabled', tenant.slug === 'fga');
}

function num(tenant, key, def) {
  const v = Number(getConfig(tenant, key, def));
  return Number.isFinite(v) ? v : def;
}

const qualityThreshold = (t) => num(t, 'content_quality_threshold', 70);
const similarityThreshold = (t) => num(t, 'content_similarity_threshold', 0.82);
const statLedMaxPct = (t) => num(t, 'content_stat_led_max_pct', 0.15);
const founderMinPct = (t) => num(t, 'content_founder_min_pct', 0.15);
const founderMaxPct = (t) => num(t, 'content_founder_max_pct', 0.25);
const visualMaxRetries = (t) => num(t, 'content_visual_max_retries', 2);
const conceptRegenMax = (t) => num(t, 'content_concept_regen_max', 2);

// Visual upgrade (2026): AI-vision scoring of the rendered image + the
// deterministic safe-area gate. Both default ON for FGA, tunable per tenant.
const visualScorerEnabled = (t) => {
  if (!t) return false;
  return !!getConfig(t, 'content_visual_scorer_enabled', t.slug === 'fga');
};
// Minimum 1-5 visual score required to clear the gate.
const visualScoreMin = (t) => num(t, 'content_visual_score_min', 4);
// When true, a hard safe-area failure (clipping / bleed) blocks the draft.
const safeAreaHardGate = (t) => {
  if (!t) return false;
  const v = getConfig(t, 'content_safe_area_hard_gate', t.slug === 'fga');
  return v === false || v === 'false' ? false : !!v;
};

module.exports = {
  isPlannerEnabled,
  screenshotsEnabled,
  qualityThreshold,
  similarityThreshold,
  statLedMaxPct,
  founderMinPct,
  founderMaxPct,
  visualMaxRetries,
  conceptRegenMax,
  visualScorerEnabled,
  visualScoreMin,
  safeAreaHardGate,
};
