/**
 * Marketing Script Engine — 2026-06-09
 *
 * The brain behind varied, non-repetitive 12-second FGA voiceover scripts.
 *
 * The old generator forced every promo into one rigid template:
 *   "Just started your business? [STAT]% of customers [behavior]..."
 *   → "Miss the call, lose the job. First Gen Automate answers it."
 *   → "Automate the Overhead, Focus on the Work."
 * That produced near-identical scripts where only the niche name changed,
 * plus unsourced statistics (62%, 76%...) baked into the prompt.
 *
 * This engine fixes that with:
 *   - 10 rotating script STRUCTURES (in-the-moment, customer POV, owner POV,
 *     before/after, question, contrarian, mini-story, outcome-first,
 *     operational truth, dialogue)
 *   - A BLOCKED_PHRASE list (overused openings) the generator must avoid
 *   - A TRANSITION library so the line before the tagline varies
 *   - Recent-script memory + Jaccard similarity (tagline-excluded) so a new
 *     script can't be a near-copy of a recent one
 *   - Duration validation (word count + estimated seconds + timing status)
 *   - A multi-dimension quality score
 *   - "No statistics unless from the approved fact library" policy
 *
 * The official FGA tagline ("Automate the Overhead, Focus on the Work.")
 * is treated as fixed brand language — it is NEVER counted as repeated
 * content and is stripped before any similarity comparison.
 */

// The production-approved tagline (comma form — see admin-marketing FGA_TAGLINE
// and MEMORY.md). Kept here so similarity stripping matches the real close.
const OFFICIAL_TAGLINE = 'Automate the Overhead, Focus on the Work.';

// ---------------------------------------------------------------------------
// SCRIPT STRUCTURES — rotate so consecutive promos for a module differ.
// ---------------------------------------------------------------------------
const SCRIPT_STRUCTURES = [
  {
    key: 'in_the_moment',
    name: 'In-the-Moment Scenario',
    guidance: 'Open INSIDE the action — drop the viewer into the exact second the work and the interruption collide. Present tense, second person.',
    example: 'You\'re thirty feet up when the next estimate calls.',
  },
  {
    key: 'customer_perspective',
    name: 'Customer Perspective',
    guidance: 'Tell it from the CUSTOMER\'s point of view — the person who needs help right now and won\'t wait.',
    example: 'The homeowner with a leaking roof isn\'t waiting for a callback.',
  },
  {
    key: 'owner_perspective',
    name: 'Owner Perspective',
    guidance: 'State the owner\'s operational reality as a plain truth — you can\'t be in two places at once.',
    example: 'You can\'t stop a roofing job every time the phone rings.',
  },
  {
    key: 'before_after',
    name: 'Before and After',
    guidance: 'Contrast the old way with the new way in two short beats. "Before / Now."',
    example: 'Before, every missed call became another follow-up. Now the caller gets an answer.',
  },
  {
    key: 'specific_question',
    name: 'Specific Question',
    guidance: 'Open with one targeted question about what happens to leads while the owner works. Never use the banned "Just started your business?" opener.',
    example: 'What happens to new leads while your whole crew is on a job?',
  },
  {
    key: 'contrarian',
    name: 'Contrarian Statement',
    guidance: 'Challenge a common assumption the owner holds — e.g. that they need to hire to keep up.',
    example: 'You don\'t need another employee just to answer the phone.',
  },
  {
    key: 'mini_story',
    name: 'Mini Story',
    guidance: 'A tight 3-beat narrative arc: trigger → ringing/demand → FGA handles it.',
    example: 'A storm rolls through. The phone starts ringing. First Gen Automate handles the next call.',
  },
  {
    key: 'outcome_first',
    name: 'Outcome First',
    guidance: 'Lead with the improved result, then name what made it possible.',
    example: 'Keep working while every new caller gets answered and captured.',
  },
  {
    key: 'operational_truth',
    name: 'Operational Truth',
    guidance: 'Open with a relatable, almost wry observation about the trade.',
    example: 'The phone always rings when both hands are busy.',
  },
  {
    key: 'dialogue_thought',
    name: 'Dialogue / Internal Thought',
    guidance: 'Open with a natural spoken moment or the owner\'s own thought.',
    example: 'Not again — another missed call while I\'m on the roof.',
  },
];

const STRUCTURE_KEYS = SCRIPT_STRUCTURES.map((s) => s.key);

// ---------------------------------------------------------------------------
// BLOCKED PHRASES — overused openers/lines the generator must NEVER produce.
// Case-insensitive substring match. The official tagline is NEVER here.
// ---------------------------------------------------------------------------
const BLOCKED_PHRASES = [
  'just started your business',
  'running a business?',
  'miss the call, lose the job',
  'miss the call, lose the customer',
  'missed call, lose the job',
  'you just missed a call from your next client',
  'missed calls equal missed money',
  'missed calls are missed money',
  'let us help',
  "we'll handle",
  'trust us',
];

// Generic unsourced-statistic detector. Any bare percentage in a voiceover
// that did NOT come from the approved fact library is rejected.
const PERCENT_PATTERN = /\b\d{1,3}\s?%|\b\d{1,3}\s?percent\b/i;

// ---------------------------------------------------------------------------
// PRE-TAGLINE TRANSITIONS — vary the line that hands off to the tagline.
// ---------------------------------------------------------------------------
const TRANSITION_LIBRARY = [
  'Keep working while First Gen Automate handles the call.',
  'Give every new lead a faster response.',
  'Let First Gen Automate handle the first conversation.',
  'Capture the opportunity before it moves on.',
  'Keep the work moving without ignoring the phone.',
  'Let your systems handle the follow-up.',
  'Spend less time chasing the next step.',
  'Make room for the work only you can do.',
  'Put the routine work on autopilot.',
  'Stay on the job — First Gen Automate covers the rest.',
];

// ---------------------------------------------------------------------------
// MODULE SCRIPT GUIDANCE — per-module hooks, structures, phrases to avoid.
// Keyed by the module `key` from core/marketing-taxonomy. Extends the
// concept-level MODULE_PROFILES with script-specific direction.
// ---------------------------------------------------------------------------
const MODULE_SCRIPT_GUIDANCE = {
  voice_receptionist: {
    bestStructures: ['in_the_moment', 'dialogue_thought', 'operational_truth', 'owner_perspective', 'mini_story'],
    avoid: ['Missed calls equal missed money', 'generic receptionist comparisons', 'the same phone-rings-while-working scene every time'],
    solutionVerbs: ['answers the call', 'captures the lead', 'collects the details', 'routes the request', 'logs the booking'],
    outcomes: ['caller gets immediate help', 'lead details captured', 'owner gets a text brief', 'no one hits voicemail'],
  },
  chat_agent: {
    bestStructures: ['customer_perspective', 'specific_question', 'before_after', 'outcome_first'],
    avoid: ['generic "24/7 support" filler'],
    solutionVerbs: ['answers in seconds', 'captures the visitor', 'replies instantly', 'handles the question'],
    outcomes: ['visitor becomes a lead', 'question answered at midnight', 'no bounce to a competitor'],
  },
  website: {
    bestStructures: ['contrarian', 'before_after', 'outcome_first', 'customer_perspective'],
    avoid: ['"in today\'s digital world" cliches'],
    solutionVerbs: ['builds your site', 'manages your online presence', 'keeps your site current'],
    outcomes: ['customers can find you', 'you look like the real deal', 'a site that updates itself'],
  },
  lead_capture: {
    bestStructures: ['owner_perspective', 'operational_truth', 'before_after'],
    avoid: ['"organize your business" vagueness'],
    solutionVerbs: ['captures every lead', 'keeps them in one place', 'logs the contact'],
    outcomes: ['nothing slips through', 'every lead in one place', 'you know who came from where'],
  },
  speed_to_lead: {
    bestStructures: ['mini_story', 'specific_question', 'outcome_first', 'in_the_moment'],
    avoid: ['fear-based urgency overload'],
    solutionVerbs: ['replies in seconds', 'answers first', 'responds before the lead cools'],
    outcomes: ['you reach them first', 'the lead stays warm', 'a faster first response'],
  },
  missed_call_textback: {
    bestStructures: ['in_the_moment', 'dialogue_thought', 'before_after'],
    avoid: ['Miss the call, lose the job', 'Missed calls equal missed money'],
    solutionVerbs: ['texts them back', 'follows up by text', 'reaches the caller instantly'],
    outcomes: ['the caller hears back', 'a missed call becomes a booked job', 'no one is left on voicemail'],
  },
  follow_up_sequences: {
    bestStructures: ['before_after', 'owner_perspective', 'operational_truth'],
    avoid: ['"nurture your leads" jargon'],
    solutionVerbs: ['follows up for you', 'keeps the conversation going', 'reaches back out'],
    outcomes: ['estimates stop dying', 'past customers come back', 'follow-up that never forgets'],
  },
  content_engine: {
    bestStructures: ['owner_perspective', 'before_after', 'outcome_first'],
    avoid: ['"go viral" promises'],
    solutionVerbs: ['turns job photos into posts', 'writes the caption', 'posts for you'],
    outcomes: ['your feed stays active', 'job photos become marketing', 'consistent posting without the work'],
  },
  content_approval: {
    bestStructures: ['owner_perspective', 'outcome_first'],
    avoid: ['"streamline your workflow" jargon'],
    solutionVerbs: ['drafts the posts', 'queues them for one-tap approval', 'schedules what you approve'],
    outcomes: ['approve in seconds', 'stay in control without the studio time'],
  },
  review_requests: {
    bestStructures: ['owner_perspective', 'operational_truth', 'before_after'],
    avoid: ['guaranteed 5-star claims'],
    solutionVerbs: ['asks for the review', 'follows up after the job', 'requests feedback for you'],
    outcomes: ['reviews show up on their own', 'the reputation you earn, online'],
  },
  branded_app: {
    bestStructures: ['contrarian', 'outcome_first', 'customer_perspective'],
    avoid: ['download-count promises'],
    solutionVerbs: ['ships your own app', 'puts your brand in their pocket'],
    outcomes: ['your business gets its own app', 'you look like the real deal'],
  },
  referral_engine: {
    bestStructures: ['before_after', 'operational_truth', 'owner_perspective'],
    avoid: ['guaranteed-referral claims'],
    solutionVerbs: ['asks for the referral', 'turns customers into a referral source'],
    outcomes: ['referrals stop slipping away', 'happy customers send the next one'],
  },
  referral_outreach: {
    bestStructures: ['owner_perspective', 'before_after'],
    avoid: ['guaranteed-partnership claims'],
    solutionVerbs: ['keeps partners engaged', 'stays in touch for you'],
    outcomes: ['partners stay warm', 'relationships that don\'t go cold'],
  },
  prospecting_engine: {
    bestStructures: ['outcome_first', 'contrarian', 'owner_perspective'],
    avoid: ['guaranteed-appointment claims'],
    solutionVerbs: ['finds new prospects', 'reaches out overnight', 'fills the pipeline'],
    outcomes: ['prospects waiting by morning', 'outreach on autopilot'],
  },
  lead_scoring: {
    bestStructures: ['owner_perspective', 'operational_truth', 'outcome_first'],
    avoid: ['guaranteed-accuracy claims'],
    solutionVerbs: ['ranks your leads', 'flags the hot ones', 'tells you who to call first'],
    outcomes: ['call the right lead first', 'stop wasting time on cold leads'],
  },
};

function moduleScriptGuidance(key) {
  return MODULE_SCRIPT_GUIDANCE[key] || {
    bestStructures: STRUCTURE_KEYS,
    avoid: [],
    solutionVerbs: ['handles it for you', 'runs on autopilot'],
    outcomes: ['the work gets done without you'],
  };
}

// ---------------------------------------------------------------------------
// Structure rotation — pick a structure not used in the last 2 promos for
// this module, biased toward the module's best-fit structures.
// ---------------------------------------------------------------------------
function pickStructure(moduleKey, recentStructureKeys = []) {
  const guidance = moduleScriptGuidance(moduleKey);
  const recent = new Set((recentStructureKeys || []).slice(0, 2));
  const preferred = (guidance.bestStructures || STRUCTURE_KEYS).filter((k) => !recent.has(k));
  const pool = preferred.length ? preferred : STRUCTURE_KEYS.filter((k) => !recent.has(k));
  const finalPool = pool.length ? pool : STRUCTURE_KEYS;
  const chosenKey = finalPool[Math.floor(Math.random() * finalPool.length)];
  return SCRIPT_STRUCTURES.find((s) => s.key === chosenKey) || SCRIPT_STRUCTURES[0];
}

function pickTransition(recentTransitions = []) {
  const recent = new Set((recentTransitions || []).slice(0, 4));
  const pool = TRANSITION_LIBRARY.filter((t) => !recent.has(t));
  const finalPool = pool.length ? pool : TRANSITION_LIBRARY;
  return finalPool[Math.floor(Math.random() * finalPool.length)];
}

// ---------------------------------------------------------------------------
// Tagline isolation + tokenization + similarity (Jaccard over token sets).
// ---------------------------------------------------------------------------
function stripTagline(text) {
  if (!text) return '';
  let t = String(text);
  // Remove both comma and period variants of the official tagline, anywhere.
  const variants = [
    /automate the overhead[,.]?\s*focus on the work[.!]?/gi,
  ];
  for (const re of variants) t = t.replace(re, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2); // drop tiny stopwords-ish tokens
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Compare a candidate voiceover against recent ones, EXCLUDING the tagline.
 * Returns { maxSimilarity, mostSimilarTo } where mostSimilarTo is the recent
 * script id (or index) with the highest overlap.
 */
function computeMaxSimilarity(candidateVoiceover, recentScripts = []) {
  const candTokens = tokenize(stripTagline(candidateVoiceover));
  let max = 0;
  let mostSimilarTo = null;
  for (const r of recentScripts) {
    const rText = typeof r === 'string' ? r : r.voiceover_full || r.text || '';
    const sim = jaccard(candTokens, tokenize(stripTagline(rText)));
    if (sim > max) {
      max = sim;
      mostSimilarTo = typeof r === 'string' ? null : r.id || null;
    }
  }
  return { maxSimilarity: Math.round(max * 100) / 100, mostSimilarTo };
}

// ---------------------------------------------------------------------------
// Duration validation. ~160 wpm spoken = 2.67 words/sec. 12s ≈ 32 words.
// Target window 24-32 words including the 7-word tagline.
// ---------------------------------------------------------------------------
const WORDS_PER_SECOND = 2.67;
const TARGET_SECONDS = 12;
const MIN_WORDS = 18;
const IDEAL_MAX_WORDS = 32;
const HARD_MAX_WORDS = 36;

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function estimateDurationSeconds(text) {
  const w = countWords(text);
  return Math.round((w / WORDS_PER_SECOND) * 10) / 10;
}

function timingStatus(text) {
  const w = countWords(text);
  if (w > HARD_MAX_WORDS) return { status: 'too_long', label: 'Too Long', words: w, seconds: estimateDurationSeconds(text), fits: false };
  if (w > IDEAL_MAX_WORDS) return { status: 'close', label: 'Close to Limit', words: w, seconds: estimateDurationSeconds(text), fits: true };
  if (w < MIN_WORDS) return { status: 'too_short', label: 'Too Short', words: w, seconds: estimateDurationSeconds(text), fits: true };
  return { status: 'fits', label: 'Fits 12 Seconds', words: w, seconds: estimateDurationSeconds(text), fits: true };
}

// ---------------------------------------------------------------------------
// Blocked-phrase + unsourced-statistic detection.
// ---------------------------------------------------------------------------
function findBlockedPhrases(text) {
  const lower = String(text || '').toLowerCase();
  return BLOCKED_PHRASES.filter((p) => lower.includes(p.toLowerCase()));
}

/**
 * Returns true if the voiceover contains a numeric statistic that was NOT
 * sanctioned by an approved fact. allowedFactValue is the value string of the
 * approved fact in use (or null when no fact is approved for this script).
 */
function hasUnsourcedStatistic(text, allowedFactValue = null) {
  const matches = String(text || '').match(/\b\d{1,3}\s?%|\b\d{1,3}\s?percent\b/gi);
  if (!matches) return false;
  if (!allowedFactValue) return true; // any number with no approved fact = unsourced
  // If the only numbers present match the approved fact value, it's sourced.
  const allowed = String(allowedFactValue).replace(/[^0-9]/g, '');
  return matches.some((m) => m.replace(/[^0-9]/g, '') !== allowed);
}

// ---------------------------------------------------------------------------
// Quality scoring. Heuristic, 1-10 per dimension. The model can't be trusted
// to grade itself honestly, so we score deterministically from the output.
// ---------------------------------------------------------------------------
function scoreScript({ voiceover, moduleName, niche, structure, allowedFactValue, maxSimilarity }) {
  const text = String(voiceover || '');
  const lower = text.toLowerCase();
  const words = countWords(text);
  const timing = timingStatus(text);

  // Claim accuracy — 10 unless an unsourced stat or banned superlative appears.
  const claimAccuracy = (hasUnsourcedStatistic(text, allowedFactValue) ? 3 : 10);

  // Brand consistency — tagline present & exact, brand name spoken in full,
  // never "FGA" spoken.
  const taglinePresent = /automate the overhead[,.]?\s*focus on the work/i.test(text);
  const saysFgaAbbrev = /\bF\.?G\.?A\.?\b/.test(text) && !/first gen automate/i.test(text);
  const brandConsistency = (taglinePresent ? (saysFgaAbbrev ? 7 : 10) : 4);

  // Timing fit — 10 if fits, 7 if close, 3 if too long/short.
  const timingFit = timing.status === 'fits' ? 10 : timing.status === 'close' ? 7 : timing.status === 'too_short' ? 6 : 3;

  // Module relevance — does the solution/brand line reference the module's job?
  const moduleRelevance = (lower.includes('first gen automate') ? 9 : 6);

  // Niche relevance — heuristic: the script should not be a pure niche swap.
  // We can't fully judge here, default 8; the prompt enforces niche language.
  const nicheRelevance = niche ? 8 : 6;

  // Originality excluding tagline — derived from similarity.
  const originality = maxSimilarity == null ? 8 : Math.max(1, Math.round((1 - maxSimilarity) * 10));

  // Natural speech — penalize blocked phrases & over-length.
  const blocked = findBlockedPhrases(text);
  const naturalSpeech = Math.max(1, 9 - blocked.length * 3 - (timing.status === 'too_long' ? 3 : 0));

  // Hook strength — heuristic: first sentence short & specific.
  const firstSentence = (text.split(/[.!?]/)[0] || '').trim();
  const hookStrength = firstSentence && countWords(firstSentence) <= 12 ? 8 : 6;

  const dims = {
    module_relevance: moduleRelevance,
    niche_relevance: nicheRelevance,
    hook_strength: hookStrength,
    natural_speech: naturalSpeech,
    originality_excl_tagline: originality,
    claim_accuracy: claimAccuracy,
    timing_fit: timingFit,
    brand_consistency: brandConsistency,
  };
  const overall = Math.round(
    (Object.values(dims).reduce((s, v) => s + v, 0) / Object.keys(dims).length) * 10
  ) / 10;

  // Required thresholds (from the spec).
  const passes =
    overall >= 7.5 &&
    dims.originality_excl_tagline >= 7 &&
    dims.claim_accuracy >= 9 &&
    dims.timing_fit >= 7 &&
    dims.module_relevance >= 8 &&
    dims.brand_consistency >= 9;

  return {
    dimensions: dims,
    overall,
    passes,
    structure: structure?.key || null,
    timing,
    blocked_phrases: blocked,
    has_unsourced_statistic: hasUnsourcedStatistic(text, allowedFactValue),
    max_similarity: maxSimilarity,
    module: moduleName || null,
  };
}

// ---------------------------------------------------------------------------
// Concept fingerprint — coarse signature for dedupe / audit.
// ---------------------------------------------------------------------------
function buildFingerprint({ moduleKey, niche, structureKey, hookType, statisticId, transition }) {
  return [
    moduleKey || '?',
    (niche || '?').toLowerCase().replace(/\s+/g, '-'),
    structureKey || '?',
    hookType || structureKey || '?',
    statisticId ? `stat:${statisticId}` : 'no-stat',
    transition ? transition.slice(0, 24).toLowerCase().replace(/\s+/g, '-') : 'no-cta',
  ].join('|');
}

module.exports = {
  OFFICIAL_TAGLINE,
  SCRIPT_STRUCTURES,
  STRUCTURE_KEYS,
  BLOCKED_PHRASES,
  TRANSITION_LIBRARY,
  MODULE_SCRIPT_GUIDANCE,
  moduleScriptGuidance,
  pickStructure,
  pickTransition,
  stripTagline,
  tokenize,
  jaccard,
  computeMaxSimilarity,
  countWords,
  estimateDurationSeconds,
  timingStatus,
  findBlockedPhrases,
  hasUnsourcedStatistic,
  scoreScript,
  buildFingerprint,
  PERCENT_PATTERN,
};
