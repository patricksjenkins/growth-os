/**
 * Growth OS — Shared retry/backoff helper for outbound HTTP.
 *
 * V1 hardening (2026-05-24). Every external API call in the codebase
 * (Serper, Claude, Gemini, Buffer, Telnyx status, Vapi management,
 * Mercury, Stripe, Expo Push) used to throw on a 429 or transient 503
 * and let the job die. This wraps the request in 3 attempts with
 * exponential backoff and honors `Retry-After` when the provider sends
 * it.
 *
 * Usage:
 *   const { withRetry } = require('./_retry');
 *   const data = await withRetry(() => axios.post(url, body), {
 *     attempts: 3,
 *     onRetry: (err, attempt, delayMs) => log.warn(`retry ${attempt} in ${delayMs}ms: ${err.message}`),
 *   });
 *
 * Retryable conditions:
 *   - Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN)
 *   - HTTP 408 (Request Timeout)
 *   - HTTP 429 (Too Many Requests) — uses Retry-After header
 *   - HTTP 5xx EXCEPT 501 (Not Implemented — won't change on retry)
 *
 * Non-retryable: 4xx other than 408/429 — caller's fault, retry won't help.
 */

const DEFAULT_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;        // first retry waits ~500ms
const MAX_DELAY_MS = 15_000;       // cap individual sleeps at 15s
const JITTER_RATIO = 0.25;         // up to ±25% jitter

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH', 'ECONNABORTED',
  // undici/fetch connection drops (Anthropic/other SDKs surface these when a
  // response body is cut off mid-flight — e.g. "Premature close")
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

// fetch/undici often throw a generic Error whose `code` is undefined and whose
// detail lives in the message or a wrapped `cause`. Match those by text so a
// transient connection drop is retried (with a fresh connection) instead of
// killing the job.
const RETRYABLE_MESSAGE_RE =
  /premature close|terminated|socket hang up|other side closed|econnreset|fetch failed|network error|invalid response body/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  const variance = ms * JITTER_RATIO;
  return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * variance));
}

function isRetryableError(err) {
  if (!err) return false;
  // network-layer errors expose `code` — check the error and any wrapped cause
  const code = err.code ?? err.cause?.code;
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  // codeless connection drops (undici/fetch) — match on the message/cause text
  const msg = `${err.message ?? ''} ${err.cause?.message ?? ''}`;
  if (RETRYABLE_MESSAGE_RE.test(msg)) return true;
  // axios-style: err.response.status
  const status = err.response?.status ?? err.status ?? err.statusCode;
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status !== 501) return true;
  return false;
}

function retryAfterMs(err) {
  // axios:  err.response.headers['retry-after']
  // fetch:  caller would have to pass it through; we look in both spots
  const raw =
    err?.response?.headers?.['retry-after'] ??
    err?.response?.headers?.get?.('retry-after') ??
    err?.headers?.['retry-after'] ??
    null;
  if (!raw) return null;
  // Provider may send seconds (e.g. "30") or an HTTP-date.
  const asInt = Number(raw);
  if (Number.isFinite(asInt)) return Math.min(asInt * 1000, MAX_DELAY_MS);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), MAX_DELAY_MS);
  }
  return null;
}

/**
 * Run `fn` up to `attempts` times, sleeping between failures with
 * exponential backoff. Resolves with the first successful return value;
 * rejects with the last error if all attempts fail.
 *
 * @param {() => Promise<T>} fn
 * @param {Object} [opts]
 * @param {number} [opts.attempts=3]
 * @param {(err: Error, attempt: number, delayMs: number) => void} [opts.onRetry]
 * @param {number} [opts.baseDelayMs=500]
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelay = opts.baseDelayMs ?? BASE_DELAY_MS;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryableError(err)) {
        throw err;
      }
      const headerDelay = retryAfterMs(err);
      const expoDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), MAX_DELAY_MS);
      const delay = jitter(headerDelay ?? expoDelay);
      if (typeof opts.onRetry === 'function') {
        try { opts.onRetry(err, attempt, delay); } catch (_) { /* listener must not throw */ }
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, isRetryableError };
