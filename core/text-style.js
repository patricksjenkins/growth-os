/**
 * text-style.js — house style for AI-generated customer-facing copy.
 *
 * LLMs default to em dashes, curly quotes, and ellipsis characters, which make
 * copy read as machine-written. We fix this two ways:
 *   1. NO_DASH_PROMPT_RULE — an instruction added to generation prompts so the
 *      model writes it right the first time (and reads naturally).
 *   2. stripAiTells(text) — a DETERMINISTIC post-processor run on every draft
 *      right before it's saved, so the output is GUARANTEED clean regardless of
 *      what the model actually emitted. This is the guarantee; the prompt is the
 *      polish. Mirrors the sweep we ran on the public site + sales PDFs.
 *
 * Only punctuation/typography is normalized — wording, meaning, and links are
 * never touched. Safe on any string; non-strings pass through unchanged.
 */

/** Drop-in style rule for AI generation system prompts. */
const NO_DASH_PROMPT_RULE = [
  'WRITING STYLE (sound like a real person, not AI):',
  '- Never use em dashes (—) or en dashes (–). Use commas, periods, or colons instead.',
  '- Use straight quotes (\' and ") only — never curly/smart quotes.',
  '- Never use the ellipsis character (…); if you must trail off, type three periods.',
  '- Keep sentences plain and direct; avoid the dash-heavy cadence AI is known for.',
].join('\n');

/**
 * Normalize AI "tells" in a piece of copy to natural, human punctuation.
 * @param {string} input
 * @returns {string} sanitized copy (or the input unchanged if not a string)
 */
function stripAiTells(input) {
  if (typeof input !== 'string' || input.length === 0) return input;

  let out = input;

  // 1. Number ranges written with a dash keep a plain hyphen: "5 – 7" -> "5-7".
  out = out.replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2');

  // 2. Any remaining em/en dash used as a sentence break -> comma. The regex
  //    eats surrounding whitespace so we never leave a double space.
  out = out.replace(/\s*[–—]\s*/g, ', ');

  // 3. A break dash at the very start of a line would become a stray ", " —
  //    strip that leading comma.
  out = out.replace(/(^|\n)\s*,\s+/g, '$1');

  // 4. Curly quotes -> straight.
  out = out
    .replace(/[“”„‟″]/g, '"') // " " „ ‟ ″
    .replace(/[‘’‚‛′]/g, "'"); // ' ' ‚ ‛ ′

  // 5. Ellipsis character -> three periods.
  out = out.replace(/…/g, '...');

  return out;
}

/**
 * Sanitize the string-valued fields of a draft object in place-safe fashion.
 * Returns a NEW object; only the listed keys (default: common copy fields) are
 * touched, and only when they hold a string.
 * @param {Record<string, any>} obj
 * @param {string[]} [keys]
 */
function stripAiTellsFields(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const fields = keys || [
    'subject',
    'body',
    'body_plain',
    'body_html',
    'text',
    'message',
    'caption',
    'content',
    'preview',
    'greeting',
  ];
  const copy = { ...obj };
  for (const k of fields) {
    if (typeof copy[k] === 'string') copy[k] = stripAiTells(copy[k]);
  }
  return copy;
}

module.exports = { stripAiTells, stripAiTellsFields, NO_DASH_PROMPT_RULE };
