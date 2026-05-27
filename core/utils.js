/**
 * Growth OS Utility Functions
 */

/**
 * Remove markdown code fences from AI responses
 */
function stripCodeFences(text) {
  if (!text) return text;
  return text
    .replace(/^```(?:json|javascript|js|html|css|sql)?\s*\n?/gm, '')
    .replace(/\n?```\s*$/gm, '')
    .trim();
}

/**
 * Split full name into first and last
 */
function splitName(fullName) {
  if (!fullName) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return {
    first: parts[0] || '',
    last: parts.slice(1).join(' ') || ''
  };
}

/**
 * Create URL-safe slug from text
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Sleep for given milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pick random item from array
 */
function pickRandom(array) {
  if (!array || array.length === 0) return null;
  return array[Math.floor(Math.random() * array.length)];
}

/**
 * Interpolate template variables: "Hello {name}" + {name: "Pat"} => "Hello Pat"
 */
function interpolateTemplate(template, vars) {
  if (!template || !vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

/**
 * Generate a unique idempotency key
 */
function makeIdempotencyKey(parts) {
  return parts.filter(Boolean).join(':');
}

/**
 * sanitizePhone(raw) — normalize phone input and reject masked / incomplete
 * values. Facebook business listings often hide the last 4 digits of a phone
 * (e.g. "(912) 617-XXXX" or "404-555-****"), and the enrichment agent was
 * storing those verbatim — producing leads that look reachable but aren't.
 *
 * Returns null if the value can't reach a US number:
 *   - empty / null / undefined
 *   - contains 'X', 'x', or '*' anywhere
 *   - fewer than 10 digits after stripping non-digits
 *
 * Otherwise returns the original string (preserving whatever formatting
 * the source used — we don't try to reformat to E.164 here; that's
 * Twilio's job at send time).
 */
function sanitizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[Xx*]/.test(trimmed)) return null;          // masked
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 10) return null;             // incomplete
  return trimmed;
}

module.exports = {
  stripCodeFences,
  splitName,
  slugify,
  sleep,
  pickRandom,
  interpolateTemplate,
  makeIdempotencyKey,
  sanitizePhone,
};
