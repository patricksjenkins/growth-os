/**
 * Operations Guardian — pure diagnosis helpers (no DB, no network, no LLM).
 *
 * Everything here is deterministic rules. The guardian deliberately does NOT
 * call Claude (or any paid API) to "diagnose" — a monitoring loop that calls a
 * paid model is exactly the runaway-cost risk we must avoid. Root cause is
 * inferred from the error signature via a known map, and that inference also
 * decides the permission level (auto-fix / approval / escalate).
 */

// ---------------------------------------------------------------------------
// Expected cadence — derived from the scheduler's cron expressions.
// ---------------------------------------------------------------------------

/**
 * Estimate the maximum number of hours that should ever pass between two runs
 * of a single cron expression. Heuristic but conservative — used only to decide
 * when a scheduled agent is "stale" (overdue), so over-estimating just makes us
 * slower to flag, never falsely noisy.
 */
function maxGapHoursForCron(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [min, hour, dom, , dow] = parts;

  // Fires many times a day (every hour, or multiple hours, or every minute).
  const multiHour = hour === '*' || hour.includes('*') || hour.includes('-') || hour.includes('/') || hour.split(',').length > 1;
  const everyMinute = min === '*' || min.includes('/') || min.includes('-');
  if (multiHour || everyMinute) return 3; // frequent → stale after ~3h

  // Specific day-of-month (e.g. "1") → monthly.
  if (dom !== '*' && /^\d/.test(dom)) return 24 * 32;

  // Day-of-week patterns.
  if (dow === '*') return 26; // every day → ~daily

  // Parse a dow list/range into the set of weekdays it fires on (0=Sun..6=Sat).
  const days = new Set();
  for (const tok of dow.split(',')) {
    if (tok.includes('-')) {
      const [a, b] = tok.split('-').map((n) => parseInt(n, 10));
      if (Number.isFinite(a) && Number.isFinite(b)) {
        for (let d = a; d <= b; d++) days.add(((d % 7) + 7) % 7);
      }
    } else {
      const d = parseInt(tok, 10);
      if (Number.isFinite(d)) days.add(((d % 7) + 7) % 7);
    }
  }
  if (days.size === 0) return 26;
  if (days.size === 1) return 24 * 8; // weekly → ~8 days

  // Largest gap (in days) between consecutive firing weekdays, wrapping around.
  const sorted = [...days].sort((a, b) => a - b);
  let maxGapDays = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[(i + 1) % sorted.length];
    const gap = i + 1 < sorted.length ? next - sorted[i] : 7 - sorted[i] + next;
    if (gap > maxGapDays) maxGapDays = gap;
  }
  return maxGapDays * 24 + 2; // + small grace
}

/**
 * Build a per-agent expected-cadence map from getSchedule()'s entries.
 * Returns { agentName: { maxGapHours, unconditional, descs } }.
 *
 * `unconditional` is true only if the agent has at least one schedule entry
 * with NO `when` predicate. Agents that ONLY fire conditionally (e.g.
 * content-concept-finalize fires only when a concept was approved) must NOT be
 * flagged as "stale" — not running is their normal state.
 */
function buildCadenceMap(schedule) {
  const map = {};
  for (const entry of schedule || []) {
    const name = entry.agent;
    if (!name) continue;
    const gap = maxGapHoursForCron(entry.cron);
    const conditional = typeof entry.when === 'function';
    if (!map[name]) map[name] = { maxGapHours: gap, unconditional: !conditional, descs: [] };
    else {
      // Most-frequent entry wins (smallest gap); unconditional if any entry is.
      if (gap != null && (map[name].maxGapHours == null || gap < map[name].maxGapHours)) map[name].maxGapHours = gap;
      if (!conditional) map[name].unconditional = true;
    }
    if (entry.desc) map[name].descs.push(entry.desc);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Error signatures + rules-based root cause / permission level.
// ---------------------------------------------------------------------------

/** Normalize an error message into a stable signature for dedup + repeat counts. */
function errorSignature(msg) {
  if (!msg) return 'unknown';
  return String(msg)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, 'url')           // strip urls
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, 'id') // uuids
    .replace(/\b\d{3,}\b/g, 'n')                 // long numbers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Map an error to a likely root cause + how the guardian is allowed to respond.
 *  - recoverable: a plain re-run might fix it (transient) → eligible for a
 *    bounded Level-1 retry.
 *  - level: the permission level if a retry does NOT recover it (or isn't safe).
 */
function classifyError(msg) {
  const s = String(msg || '').toLowerCase();
  const R = (cause, recoverable, level, category) => ({ cause, recoverable, level, category });

  if (/usagecapexceeded|usage cap|cap exceeded/.test(s))
    return R('Hit a usage cap by design — not a fault.', false, 0, 'cap'); // level 0 = informational, no action
  if (/premature close|terminated|socket hang up|fetch failed|invalid response body|econnreset.*fetch/.test(s))
    return R('A long/non-streamed provider call was cut off by a network or timeout — code-level (e.g. needs streaming).', false, 2, 'provider_network');
  if (/rate.?limit|\b429\b|too many requests/.test(s))
    return R('Provider rate limit reached.', true, 1, 'rate_limit');
  if (/quota|out of credit|insufficient.*credit|\b402\b|payment required/.test(s))
    return R('Provider account is out of credits/quota — needs a top-up.', false, 2, 'provider_quota');
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid api key|api key.*(invalid|revoked)|revoked/.test(s))
    return R('Provider API key is invalid/revoked — needs an env/key change.', false, 2, 'auth');
  if (/\betimedout\b|\benotfound\b|\beai_again\b|\beconnreset\b|\beconnrefused\b|network|timeout/.test(s))
    return R('Transient network error.', true, 1, 'network');
  if (/no json object|json|parse|schema|unexpected token|validation/.test(s))
    // Not retry-recoverable: askClaudeJSON already retries parse failures 3× before
    // the job is marked failed, so a guardian requeue would just hit the same wall
    // (e.g. JSON truncated at max_tokens). Escalate for a prompt/code fix instead.
    return R('Model response failed to parse/validate (parser or schema mismatch) — likely a prompt/token-limit fix, not a retry.', false, 2, 'parser');
  if (/serper|search api/.test(s))
    return R('Serper (search) API error.', true, 1, 'serper');
  return R('Unclear root cause — needs human diagnosis.', false, 3, 'unknown');
}

module.exports = {
  maxGapHoursForCron,
  buildCadenceMap,
  errorSignature,
  classifyError,
};
