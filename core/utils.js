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

module.exports = {
  stripCodeFences,
  splitName,
  slugify,
  sleep,
  pickRandom,
  interpolateTemplate,
  makeIdempotencyKey
};
