/**
 * AI-vision visual scorer.
 *
 * Looks at a RENDERED slide and scores how well the visual works for a busy
 * micro-business owner scrolling Facebook/Instagram — does it SHOW the idea,
 * is it more than words on a card, would it stop a scroll, is it on-brand, and
 * is anything clipped / crowded. Complements the deterministic safe-area gate
 * (which catches geometric bleed) by catching the things only a viewer can see.
 *
 * Cost-safe: reuses integrations/claude.js askClaudeWithImageJSON (which already
 * enforces the per-tenant Claude cap + records usage). Flag-gated + FGA-only by
 * default, scores ONE representative slide per draft (bounded to a single vision
 * call), idempotent via the caller passing a cache, and fail-OPEN — if scoring
 * is unavailable it never blocks content, it just skips the vision portion of
 * the gate. No loops.
 */

const { createLogger } = require('../logger');
const { askClaudeWithImageJSON } = require('../../integrations/claude');

const SYSTEM = `You score a single social-media IMAGE for First Gen Automate (FGA) — a managed AI service for micro businesses (1-10 people), flagship product the 24/7 AI Voice Receptionist. The audience is busy owner-operators (tree service, HVAC, plumber, cleaner, salon, etc.) scrolling Facebook/Instagram. Score how well the IMAGE works, not the caption.

Return ONLY JSON:
{
  "overall": <integer 1-5>,
  "categories": {
    "explains_idea": <1-5>,        // does the image convey the point before any caption?
    "more_than_words": <1-5>,      // is it more than centered text on a plain card?
    "shows_pain_product_outcome": <1-5>, // does it show a pain, the product/workflow, or an outcome?
    "scroll_stopping": <1-5>,
    "platform_appropriate": <1-5>,
    "on_brand": <1-5>              // clean, navy/green FGA feel, not generic
  },
  "clipping": <true|false>,        // is any text/logo/element cut off or bleeding off an edge?
  "overcrowded": <true|false>,     // too much text crammed in?
  "issues": [ "<short issue>", ... ],
  "explanation": "<one concise sentence, no chain-of-thought>"
}

Be strict: a plain text quote-card with no visual idea scores 2-3 on overall and low on more_than_words. A clear product workflow / captured-lead card / a real pain scene scores higher. If anything is clipped or crowded, say so.

Specifically penalize these failures:
- a large black or opaque text panel pasted over a photograph;
- an unrelated stock-like photo used only as wallpaper;
- centered white copy on a plain navy/blue field with no visual idea;
- a visual that technically fits the brand colors but does not explain the post.
Brand colors alone never justify an on_brand score above 3. The composition must feel intentionally art-directed.`;

function normalizeScore(raw) {
  const categories = raw?.categories || {};
  let score = Number(raw?.overall);
  if (!Number.isFinite(score)) return null;
  score = Math.max(1, Math.min(5, Math.round(score)));
  const moreThanWords = Number(categories.more_than_words);
  const explainsIdea = Number(categories.explains_idea);
  const showsIdea = Number(categories.shows_pain_product_outcome);

  // A visual cannot earn a passing editorial score just because it is legible
  // and uses navy/green. These caps make the stated rubric enforceable even
  // when the vision model is overly generous with its overall number.
  if (Number.isFinite(moreThanWords) && moreThanWords <= 2) score = Math.min(score, 2);
  if (Number.isFinite(explainsIdea) && explainsIdea <= 2) score = Math.min(score, 2);
  if (Number.isFinite(showsIdea) && showsIdea <= 2) score = Math.min(score, 3);
  if (raw?.clipping || raw?.overcrowded) score = Math.min(score, 2);
  return score;
}

/**
 * Score a rendered image.
 * @param {Object} tenant
 * @param {Object} args { imageUrl, concept, visualType, platform }
 * @returns {Promise<{ok:boolean, visual_score:number, categories:Object, clipping:boolean, overcrowded:boolean, issues:string[], explanation:string} | null>}
 *   Returns null when scoring could not run (caller treats null as "skip vision gate").
 */
async function scoreVisual(tenant, { imageUrl, concept = {}, visualType = null, platform = 'instagram' } = {}) {
  const log = createLogger('visual-scorer', tenant?.slug);
  if (!imageUrl) return null;
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) { log.warn(`fetch image ${res.status}`); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    const b64 = buf.toString('base64');

    const userPrompt = `Platform: ${platform}. Intended visual_type: ${visualType || 'unspecified'}.\n`
      + `Post idea: ${(concept.hook || concept.audience_problem || concept.objective || '').toString().slice(0, 240)}\n`
      + `Score this image per the rubric.`;

    const out = await askClaudeWithImageJSON(SYSTEM, userPrompt, b64, 'image/png', {
      tenant, maxTokens: 400, operationType: 'content_visual_score', agentName: 'content-visual-scorer',
      requestSource: 'core/content/visual-scorer.js',
    });

    const visual_score = normalizeScore(out);
    if (visual_score == null) return null;
    return {
      ok: true,
      visual_score,
      categories: out.categories || {},
      clipping: !!out.clipping,
      overcrowded: !!out.overcrowded,
      issues: Array.isArray(out.issues) ? out.issues.slice(0, 6) : [],
      explanation: typeof out.explanation === 'string' ? out.explanation.slice(0, 280) : '',
    };
  } catch (e) {
    // Fail open — never block content because scoring was unavailable.
    log.warn(`scoreVisual skipped: ${e.message}`);
    return null;
  }
}

module.exports = { scoreVisual, normalizeScore };
