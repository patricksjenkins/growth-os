'use strict';

/**
 * Is this failure about the ITEM, or about the SYSTEM?
 *
 * WHY THIS EXISTS (2026-09-24)
 * On 2026-09-21 the FGA tenant exhausted its email_send_count quota (500/500).
 * Every drip send from then on threw the same error. The drip's retry budget
 * could not tell "this prospect's address is broken" from "nothing can send
 * right now", so it charged each prospect a strike for a wall they had nothing
 * to do with. Three strikes quarantined 56 follow-ups into `review`, where
 * they would have stayed forever after the quota was lifted. 70 more were one
 * run from the same fate. The job burned 25+ failing attempts per run and the
 * guardian escalated it as "Unclear root cause".
 *
 * A systemic failure means every item behind it will fail identically. The
 * correct responses are the opposite of the per-item ones:
 *   - stop the batch at the first one (circuit-break) instead of retrying N
 *   - charge no strikes; defer the item unchanged
 *   - release anything that was quarantined by it once it clears
 *   - name the blocker once, specifically, for the owner
 *
 * Deliberately conservative: an error is systemic only when its text proves it.
 * Anything unrecognized stays item-level, which preserves the existing
 * quarantine protection for genuinely broken enrollments.
 */

const PATTERNS = [
  // Our own metering. "Tenant <id> hit cap on email_send_count: 500/500"
  {
    kind: 'usage_cap',
    re: /hit cap on ([a-z_]+):\s*(\d+)\s*\/\s*(\d+)|usagecapexceeded/i,
    parse: (m) => (m && m[1]
      ? { meter: m[1], used: Number(m[2]), cap: Number(m[3]) }
      : {}),
  },
  // Provider account problems: every send fails until a human fixes the key or plan.
  { kind: 'provider_auth', re: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|api key is invalid|restricted_api_key|missing_api_key/i },
  { kind: 'provider_quota', re: /\b402\b|payment required|out of credit|insufficient.{0,20}credit|daily_quota_exceeded|monthly_quota/i },
  { kind: 'provider_rate_limit', re: /\b429\b|rate.?limit|too many requests/i },
  // Provider/network outage.
  { kind: 'provider_outage', re: /\b5\d\d\b.*(resend|postmark|anthropic|stripe)|(resend|postmark|anthropic).*\b5\d\d\b|econnrefused|eai_again|enotfound|socket hang up|service unavailable|bad gateway|gateway timeout/i },
  // The deliverability breaker or the owner's kill switch.
  { kind: 'sending_paused', re: /deliverability.?paused|autosend_paused|kill.?switch/i },
];

/**
 * @param {Error|string} err
 * @returns {{systemic: boolean, kind: string|null, meter?: string, used?: number, cap?: number, message: string}}
 */
function classifyFailure(err) {
  const message = String((err && err.message) || err || '');
  for (const p of PATTERNS) {
    const m = message.match(p.re);
    if (m) return { systemic: true, kind: p.kind, ...(p.parse ? p.parse(m) : {}), message };
  }
  return { systemic: false, kind: null, message };
}

/** Owner-facing one-liner for a systemic blocker. */
function describeBlocker(c) {
  if (!c || !c.systemic) return null;
  switch (c.kind) {
    case 'usage_cap':
      return c.meter
        ? `Monthly ${c.meter} quota exhausted (${c.used}/${c.cap}) — nothing on this meter can run until it resets or is raised`
        : 'A monthly usage quota is exhausted';
    case 'provider_auth': return 'Provider rejected our credentials — an API key needs replacing';
    case 'provider_quota': return 'Provider account is out of credit or quota — needs a top-up';
    case 'provider_rate_limit': return 'Provider is rate-limiting us — will clear on its own';
    case 'provider_outage': return 'Provider or network outage — will clear on its own';
    case 'sending_paused': return 'Sending is paused by the deliverability breaker or kill switch';
    default: return 'Systemic failure';
  }
}

module.exports = { classifyFailure, describeBlocker };
