/**
 * AI Safety — Feature Flags & Thresholds (Phase 4 + Phase 5)
 *
 * Central, env-controlled flags for the layered AI safety system. EVERY
 * safeguard reads its on/off state from here so the rollout can advance one
 * lever at a time (monitor -> manual controls -> low-risk enforcement ->
 * shared enforcement).
 *
 * SAFE-DEFAULT CONTRACT (do not change without an explicit rollout decision):
 *   - Observability defaults ON  (tracking, monitor mode, alerts).
 *   - Every BLOCKING/ENFORCEMENT lever defaults OFF.
 *   - A missing/blank env var therefore NEVER blocks live traffic and NEVER
 *     disables the existing system. The worst a missing var can do is leave a
 *     monitor on.
 *
 * Because of that contract, monitor flags use "!== 'false'" (on unless
 * explicitly disabled) and enforcement flags use "=== 'true'" (off unless
 * explicitly enabled).
 */

'use strict';

function boolOn(name) {
  // Observability lever: ON unless explicitly set to 'false'.
  return String(process.env[name] ?? '').toLowerCase() !== 'false';
}

function boolOff(name) {
  // Enforcement lever: OFF unless explicitly set to 'true'.
  return String(process.env[name] ?? '').toLowerCase() === 'true';
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// --- Observability (default ON) ---------------------------------------------
const flags = {
  // Master observability switches.
  trackingEnabled: () => boolOn('AI_USAGE_TRACKING_ENABLED'),
  monitorMode: () => boolOn('AI_MONITOR_MODE_ENABLED'),
  alertsEnabled: () => boolOn('AI_ALERTS_ENABLED'),

  // --- Enforcement (default OFF) -------------------------------------------
  hardLimits: () => boolOff('AI_HARD_LIMITS_ENABLED'),
  circuitBreaker: () => boolOff('AI_CIRCUIT_BREAKER_ENABLED'),
  queueLimits: () => boolOff('AI_QUEUE_LIMITS_ENABLED'),
  idempotencyEnforcement: () => boolOff('AI_IDEMPOTENCY_ENFORCEMENT'),
  strictMetadata: () => boolOff('AI_STRICT_METADATA_REQUIRED'),
  distributedRateLimit: () => boolOff('AI_DISTRIBUTED_RATE_LIMIT_ENABLED'),
  providerKillSwitch: () => boolOff('AI_PROVIDER_KILL_SWITCH_ENABLED'),
  agentKillSwitch: () => boolOff('AI_AGENT_KILL_SWITCH_ENABLED'),
  costEnforcement: () => boolOff('AI_COST_ENFORCEMENT_ENABLED'),
  manualBatchApproval: () => boolOff('AI_MANUAL_BATCH_APPROVAL_ENABLED'),
};

// --- Thresholds (Phase 5) ---------------------------------------------------
// All configurable; documented defaults below. These are evaluated in monitor
// mode by default (they record "would have blocked" without blocking).
const thresholds = {
  // Raised 2026-06-15: now that AI calls correctly attribute to their tenant/
  // agent (and per-call API usage — Serper/Apify/Telnyx/Resend — is also
  // recorded), normal batch agents (enrichment, prospecting) legitimately make
  // far more than the original conservative defaults in a minute/hour. These
  // monitor thresholds were producing false "would-block" alerts on healthy
  // runs. A genuine runaway loop is still far above these. Override via env.
  maxCallsPerTenantPerMinute: () => num('AI_MAX_CALLS_PER_TENANT_PER_MINUTE', 60),
  maxCallsPerTenantPerHour: () => num('AI_MAX_CALLS_PER_TENANT_PER_HOUR', 600),
  maxCallsPerTenantPerDay: () => num('AI_MAX_CALLS_PER_TENANT_PER_DAY', 3000),

  // 300 -> 400 (Patrick, 2026-07-21): the Tuesday full-quota prospecting run
  // legitimately makes ~340 calls in its hour (weekly rotation + target
  // reset), which false-fired this tripwire. 400 still catches a genuine
  // runaway loop instantly without crying wolf weekly. Prospecting also now
  // self-paces below this watermark (see worker/agents/prospecting.js).
  maxCallsPerAgentPerHour: () => num('AI_MAX_CALLS_PER_AGENT_PER_HOUR', 400),
  maxCallsPerAgentPerDay: () => num('AI_MAX_CALLS_PER_AGENT_PER_DAY', 1500),

  maxCallsPerJob: () => num('AI_MAX_CALLS_PER_JOB', 3),
  maxAgentLoopIterations: () => num('AI_MAX_AGENT_LOOP_ITERATIONS', 5),
  maxProviderAttemptsPerOperation: () => num('AI_MAX_PROVIDER_ATTEMPTS_PER_OPERATION', 3),

  maxNewOutreachJobsPerTenantPerHour: () => num('AI_MAX_NEW_OUTREACH_JOBS_PER_TENANT_PER_HOUR', 25),
  maxPendingOutreachJobsPerTenant: () => num('AI_MAX_PENDING_OUTREACH_JOBS_PER_TENANT', 50),

  costWarningPercent: () => num('AI_COST_WARNING_PERCENT', 50),
  costAlertPercent: () => num('AI_COST_ALERT_PERCENT', 75),
  costPausePercent: () => num('AI_COST_PAUSE_PERCENT', 90),
  costHardStopPercent: () => num('AI_COST_HARD_STOP_PERCENT', 100),

  batchApprovalThreshold: () => num('AI_BATCH_APPROVAL_THRESHOLD', 20),

  // Daily platform budget (USD) used to compute the cost-percent alerts.
  // 0 disables cost-percent evaluation (avoids divide-by-zero false alerts).
  dailyBudgetUsd: () => num('AI_DAILY_BUDGET_USD', 0),
};

/**
 * Snapshot every flag + threshold for the dashboard / final report.
 * Pure read — never throws.
 */
function snapshot() {
  const f = {};
  for (const [k, fn] of Object.entries(flags)) f[k] = fn();
  const t = {};
  for (const [k, fn] of Object.entries(thresholds)) t[k] = fn();

  // Human-readable system state label (Phase 13 requirement).
  let state = 'monitoring_only';
  const anyEnforcement = f.hardLimits || f.circuitBreaker || f.queueLimits ||
    f.idempotencyEnforcement || f.strictMetadata || f.distributedRateLimit ||
    f.providerKillSwitch || f.agentKillSwitch || f.costEnforcement || f.manualBatchApproval;
  if (anyEnforcement) {
    const allEnforcement = f.hardLimits && f.circuitBreaker && f.queueLimits;
    state = allEnforcement ? 'full_enforcement' : 'partial_enforcement';
  }
  if (!f.trackingEnabled && !f.monitorMode) state = 'disabled';

  return { flags: f, thresholds: t, state };
}

module.exports = { flags, thresholds, snapshot, _internal: { boolOn, boolOff, num } };
