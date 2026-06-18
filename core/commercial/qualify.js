/**
 * core/commercial/qualify.js — Stage 1 LOW-COST candidate qualification.
 *
 * Deterministic, zero-AI classification of a raw search result so we only spend
 * Claude + page-fetch budget on candidates worth deep research. Uses title,
 * snippet, URL/domain, query, profile, date clues, product clues, negatives.
 */

const { profileByKey } = require('./scoring');
const { sourceTier, sourceType, domainOf } = require('./sources');

const NEGATIVE = ['wikipedia.org', 'results', 'photos', 'recap', 'finishers list', 'login', 'sign in', 'job', 'careers', 'obituary'];
const PAST_HINTS = ['results are in', 'thanks to everyone', 'see you next year', 'was a success', 'recap'];
const PRODUCT_HINTS = ['medal', 'finisher', 'award', 'trophy', 'coin', 'plaque', 'pin', 'recognition', 'commemorative', 'keepsake', 'sponsor'];
const REGISTRATION_HINTS = ['register', 'registration', 'sign up', 'tickets', 'rsvp', 'sponsorship', 'exhibitor'];

const CLASS = {
  STRONG: 'Strong Candidate',
  POSSIBLE: 'Possible Candidate',
  SERIES: 'Future-Series Evidence',
  RESEARCH: 'Research Needed',
  IRRELEVANT: 'Irrelevant',
  PAST: 'Past Event Only',
  INVALID: 'Invalid Source',
};

function yearsIn(text) {
  const now = new Date().getFullYear();
  const found = (String(text).match(/\b(20\d\d)\b/g) || []).map(Number);
  return { future: found.filter((y) => y >= now), past: found.filter((y) => y < now), all: found };
}

/**
 * Classify a raw search result. Returns { class, score (0-100 heuristic),
 * reasons[], tier, type }. `score` is a cheap pre-rank, NOT the final fit score.
 */
function qualifyCandidate(result, profileKey, query) {
  const title = String(result.title || '');
  const snippet = String(result.snippet || '');
  const link = String(result.link || result.url || '');
  const hay = `${title} ${snippet}`.toLowerCase();
  const dom = domainOf(link);
  const reasons = [];

  if (!link || !dom) return { class: CLASS.INVALID, score: 0, reasons: ['no url'], tier: 4, type: 'unknown' };
  if (NEGATIVE.some((n) => hay.includes(n) || dom.includes(n))) return { class: CLASS.IRRELEVANT, score: 0, reasons: ['negative term'], tier: sourceTier(link), type: sourceType(link) };

  const p = profileByKey(profileKey);
  const tier = sourceTier(link);
  const type = sourceType(link);
  let score = 0;

  // Profile term match
  const termHit = p && p.terms.some((t) => hay.includes(t));
  if (termHit) { score += 25; reasons.push('profile term'); }

  // Product opportunity clue
  const prodHit = PRODUCT_HINTS.some((t) => hay.includes(t));
  if (prodHit) { score += 20; reasons.push('product clue'); }

  // Registration / sponsorship clue = forward-looking + actionable
  const regHit = REGISTRATION_HINTS.some((t) => hay.includes(t));
  if (regHit) { score += 15; reasons.push('registration/sponsorship'); }

  // Source tier weighting
  score += [0, 20, 12, 8, 2][tier] || 0;
  reasons.push(`tier ${tier}`);

  // Date clues
  const yrs = yearsIn(hay);
  const past = PAST_HINTS.some((t) => hay.includes(t));
  if (yrs.future.length) { score += 12; reasons.push('future year'); }
  else if (yrs.past.length && !yrs.future.length) { score -= 10; reasons.push('past year only'); }

  // Decide class
  let klass;
  if (past && !yrs.future.length) klass = (p && termHit) ? CLASS.SERIES : CLASS.PAST;
  else if (!termHit && !prodHit) klass = CLASS.IRRELEVANT;
  else if (score >= 60 && tier <= 2) klass = CLASS.STRONG;
  else if (score >= 40) klass = CLASS.POSSIBLE;
  else if (score >= 25) klass = CLASS.RESEARCH;
  else klass = CLASS.IRRELEVANT;

  return { class: klass, score: Math.max(0, Math.min(100, score)), reasons, tier, type };
}

// Whether a stage-1 class warrants paid deep research.
function worthDeepResearch(klass) {
  return klass === CLASS.STRONG || klass === CLASS.POSSIBLE || klass === CLASS.RESEARCH || klass === CLASS.SERIES;
}

module.exports = { qualifyCandidate, worthDeepResearch, CLASS };
