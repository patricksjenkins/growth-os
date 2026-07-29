'use strict';

/**
 * Does this address's domain actually accept mail?
 *
 * WHY THIS EXISTS (2026-07-29)
 * The sales department sat at 0/25 for days because the deliverability breaker
 * was paused: 3 hard bounces over 71 sends = 4.2%, past the 4% limit. One of
 * the three was `sales@anytiimehandymanservices.com` — note the typo,
 * "anytiime". That domain does not exist and never could have delivered, but it
 * passed the gate because the only check was a regex, and a typo'd domain is
 * perfectly valid-looking to a regex.
 *
 * At our volume the arithmetic is brutal: at ~70 sends a week, THREE bad
 * addresses trip a 4% breaker and stop every send for days. Prospecting-sourced
 * addresses are guessed or scraped, so some will always be wrong — the answer
 * is to catch them before they cost a send, a bounce, and the domain's
 * reputation.
 *
 * This checks MX records only. It does not verify the mailbox exists (that
 * needs SMTP probing, which looks like an attack and gets you blocklisted). MX
 * catches the whole class of failure we actually saw: dead and misspelled
 * domains.
 *
 * Fails OPEN on a DNS error: a resolver hiccup must not silently stop the
 * day's outreach. Only a definitive "this domain has no mail exchanger"
 * blocks a send.
 */

const dns = require('node:dns').promises;

/** Domain -> {ok, at}. Cached because a run checks the same domains repeatedly. */
const cache = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
const TIMEOUT_MS = 4000;

function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  return at === -1 ? null : String(email).slice(at + 1).trim().toLowerCase();
}

async function withTimeout(promise, ms) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('dns_timeout')), ms); }),
    ]);
  } finally { clearTimeout(t); }
}

/**
 * @returns {Promise<{ok: boolean, reason: string, domain: string|null}>}
 *   ok:true  — the domain has a mail exchanger, or we could not tell (fail open)
 *   ok:false — the domain definitively accepts no mail
 */
async function domainAcceptsMail(email) {
  const domain = domainOf(email);
  if (!domain) return { ok: false, reason: 'no_domain', domain: null };

  const hit = cache.get(domain);
  if (hit && (Date.now() - hit.at) < TTL_MS) {
    return { ok: hit.ok, reason: hit.ok ? 'mx_ok_cached' : 'no_mx_cached', domain };
  }

  try {
    const mx = await withTimeout(dns.resolveMx(domain), TIMEOUT_MS);
    const ok = Array.isArray(mx) && mx.length > 0;
    cache.set(domain, { ok, at: Date.now() });
    return { ok, reason: ok ? 'mx_ok' : 'no_mx_records', domain };
  } catch (err) {
    const code = err && err.code;
    // NXDOMAIN / ENODATA are definitive: the domain does not exist, or has no
    // MX. That is the typo case, and it is exactly what we want to stop.
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      cache.set(domain, { ok: false, at: Date.now() });
      return { ok: false, reason: `domain_unreachable_${code}`, domain };
    }
    // Anything else (timeout, SERVFAIL, resolver down) is OUR problem, not the
    // address's. Fail open rather than stop the department over a DNS blip.
    return { ok: true, reason: `dns_indeterminate_${code || 'unknown'}`, domain };
  }
}

module.exports = { domainAcceptsMail, domainOf, _cache: cache };
