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
// Parse one cron field into a membership test over [lo, hi]. Supports
// '*', 'a', 'a,b', 'a-b', '*/n', 'a-b/n'. Returns null if unparseable.
function parseCronField(field, lo, hi) {
  if (field === '*') return () => true;
  const set = new Set();
  for (const part of field.split(',')) {
    let m;
    if (part === '*') { for (let v = lo; v <= hi; v++) set.add(v); }
    else if ((m = part.match(/^\*\/(\d+)$/))) { for (let v = lo; v <= hi; v += +m[1]) set.add(v); }
    else if ((m = part.match(/^(\d+)-(\d+)\/(\d+)$/))) { for (let v = +m[1]; v <= +m[2]; v += +m[3]) set.add(v); }
    else if ((m = part.match(/^(\d+)-(\d+)$/))) { for (let v = +m[1]; v <= +m[2]; v++) set.add(v); }
    else if (/^\d+$/.test(part)) set.add(+part);
    else return null;
  }
  return (v) => set.has(v);
}

const _gapCache = new Map();

function maxGapHoursForCron(cronExpr) {
  if (!cronExpr || typeof cronExpr !== 'string') return null;
  if (_gapCache.has(cronExpr)) return _gapCache.get(cronExpr);
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const minM = parseCronField(parts[0], 0, 59);
  const hourM = parseCronField(parts[1], 0, 23);
  const domM = parseCronField(parts[2], 1, 31);
  const monM = parseCronField(parts[3], 1, 12);
  const dowM = parseCronField(parts[4], 0, 7); // cron: 0 and 7 both = Sunday
  if (![minM, hourM, domM, monM, dowM].every(Boolean)) { _gapCache.set(cronExpr, 26); return 26; }
  const domRestricted = parts[2] !== '*';
  const dowRestricted = parts[4] !== '*';

  // Simulate the fire times over a 5-week window and take the LARGEST gap
  // between consecutive fires. This is the only reliable way to handle window
  // schedules (e.g. "9-11 weekdays" is silent ~62h over a weekend, not 3h) —
  // a field heuristic can't. Memoized, and Date is only built when min+hour
  // already match, so it's cheap. Anchored on a fixed Jan-1 Monday-week so the
  // result is deterministic (no Date.now()).
  const startMs = Date.UTC(2025, 0, 1, 0, 0);
  const WINDOW_MIN = 35 * 24 * 60;
  const fires = [];
  for (let t = 0; t < WINDOW_MIN; t++) {
    if (!minM(t % 60)) continue;
    if (!hourM(Math.floor(t / 60) % 24)) continue;
    const d = new Date(startMs + t * 60000);
    if (!monM(d.getUTCMonth() + 1)) continue;
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    const domOk = domM(d.getUTCDate());
    const dowOk = dowM(dow) || (dow === 0 && dowM(7));
    // Standard cron: if BOTH dom and dow are restricted, the day matches if EITHER does.
    const dayOk = (domRestricted && dowRestricted) ? (domOk || dowOk) : (domOk && dowOk);
    if (dayOk) fires.push(t);
  }
  let hours;
  if (fires.length < 2) hours = 24 * 32; // ≤1 fire in 5 weeks → monthly-ish
  else {
    let maxGap = 0;
    for (let i = 1; i < fires.length; i++) maxGap = Math.max(maxGap, fires[i] - fires[i - 1]);
    hours = Math.round(maxGap / 60) + 2; // minutes → hours + small grace
  }
  _gapCache.set(cronExpr, hours);
  return hours;
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
