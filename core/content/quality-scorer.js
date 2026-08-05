/**
 * Concept quality scorer.
 *
 * Scores a concept against clear criteria BEFORE it enters the owner review
 * queue. A single deterministic Claude call (no internal retries — we never
 * want a scorer failure to multiply provider attempts). Returns category
 * scores + a concise explanation. No hidden chain-of-thought is requested or
 * stored.
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../logger');
const flags = require('./planner-flags');

const CATEGORIES = [
  'strategic_relevance', 'fga_differentiation', 'audience_specificity', 'originality',
  'practical_value', 'hook_strength', 'tone_balance', 'evidence_quality',
  'cta_fit', 'repetition_risk', 'claim_safety', 'visual_strength',
];

const SYSTEM = `You are a strict content editor for First Gen Automate (managed AI + automation for micro businesses). Score a proposed post CONCEPT (a plan, not final copy) from 0-100 on each category. Be concise. Do NOT reveal step-by-step reasoning — return only the scores and one short explanation sentence.

Scoring guidance:
- strategic_relevance: does it serve a clear FGA objective for micro-business owners?
- fga_differentiation: does it convey MANAGED service / done-for-you / ongoing management / connected modules (not just "software" or "AI-powered")?
- audience_specificity: concrete to a 1-10 person owner's real workday, not generic?
- originality: a genuinely fresh idea, not a recycled missed-call/competitor/speed angle?
- practical_value: does the reader learn or get something useful?
- hook_strength: would an owner stop scrolling? (no two-clause echo headlines)
- tone_balance: constructive/possibility, not fear-dominant?
- evidence_quality: if it uses a stat it's sourced+relevant; if not, still has a real idea?
- cta_fit: if a CTA is used, does it fit the objective without keyword bait or a forced close? An intentional no-CTA ending may score highly.
- repetition_risk: 100 = clearly distinct from recent themes, 0 = a rerun.
- claim_safety: no overpromise, no guaranteed outcomes, no scheduling/dispatch claims, no fabricated customer numbers?
- visual_strength: does the planned visual SHOW the pain / product / workflow / outcome (a real scene, a product-UI mockup, a before/after, a Command Center card) rather than default to words on a card? Plain text/quote visuals score low here.

Return ONLY JSON.`;

function buildUser(concept) {
  const cp = concept.concept_plan || {};
  return `Concept:
- Objective: ${concept.objective}
- Audience/Industry: ${concept.audience || 'general'} / ${concept.industry || 'general'}
- Audience problem: ${concept.audience_problem}
- FGA POV: ${concept.fga_pov}
- Module/theme: ${concept.module_theme} (module-specific: ${!!concept.is_module_post})
- Angle: ${concept.angle}
- Format: ${concept.format_name}
- Visual type: ${concept.visual_type || 'unspecified'} — visual direction: ${cp.visual_direction || 'n/a'}
- Evidence: ${concept.evidence_kind} ${JSON.stringify(concept.evidence_ref || {})}
- Tone/framing: ${concept.tone} / ${concept.emotional_framing}
- Hook: ${cp.hook || concept.hook}
- CTA: ${cp.cta || concept.cta} (${concept.cta_type})
- Slide outline: ${(cp.slide_outline || []).join(' | ')}

Return JSON: { "categories": { ${CATEGORIES.map((c) => `"${c}": <0-100>`).join(', ')} }, "overall": <0-100>, "explanation": "<=1 short sentence, no chain-of-thought" }`;
}

/**
 * @returns {Promise<{overall:number, categories:Object, passed:boolean, threshold:number, explanation:string, model:string}>}
 */
async function scoreConcept(tenant, concept) {
  const log = createLogger('quality-scorer', tenant.slug);
  const threshold = flags.qualityThreshold(tenant);
  try {
    const r = await askClaudeJSON(SYSTEM, buildUser(concept), {
      maxTokens: 600, retries: 0, tenant, tenantSlug: tenant.slug,
      agentName: 'content-plan', operationType: 'content_quality_score',
    });
    const categories = r.categories || {};
    let overall = Number(r.overall);
    if (!Number.isFinite(overall)) {
      const vals = CATEGORIES.map((c) => Number(categories[c])).filter(Number.isFinite);
      overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    }
    return {
      overall, categories, passed: overall >= threshold, threshold,
      explanation: String(r.explanation || '').slice(0, 240), model: 'claude-sonnet-4-6',
    };
  } catch (e) {
    log.warn(`scoreConcept failed (${e.message}); passing concept through un-gated`);
    // Fail-open: a scorer outage must not block the weekly plan.
    return { overall: threshold, categories: {}, passed: true, threshold, explanation: 'Scorer unavailable; not gated.', model: null };
  }
}

module.exports = { scoreConcept, CATEGORIES };
