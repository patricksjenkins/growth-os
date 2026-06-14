/**
 * Content fingerprinting + repetition control.
 *
 * Replaces the old "last 8 headlines" check with a multi-dimensional concept
 * fingerprint so the planner can detect that an idea is substantially similar
 * to recent content even when the wording differs. Also flags overuse of the
 * specific themes that dominated the old feed (missed-call, competitor-won,
 * speed, voicemail, 62%/74%/78%).
 *
 * Pure functions — no DB, no network. The agents persist the returned
 * fingerprint rows into content_fingerprints.
 */

const crypto = require('crypto');

// Overused theme detectors. Each maps a tag → regex over the concept's
// combined text. These are the themes Patrick called out as repetitive.
const THEME_PATTERNS = {
  missed_call: /missed call|voicemail|missed the call|didn'?t answer|unanswered|call back/i,
  competitor: /competitor|someone else|your rival|lost the (job|lead)|picked a competitor|went with another/i,
  speed: /speed[- ]to[- ]lead|respond(ed)? (fast|first|in)|within (60 )?seconds|first to respond|response time/i,
  voicemail: /voicemail|left a message|straight to voicemail/i,
  reviews: /\breview(s)?\b|5[- ]star|google review/i,
  stat_62: /\b62%\b/,
  stat_74: /\b74%\b/,
  stat_78: /\b78%\b/,
  fear: /lost|losing|miss(ed|ing)?|fail(ed|ing)?|gone|too late|slipping|falling through/i,
};

// Themes considered "overused" — flagged when they recur in the recent window.
const OVERUSED_TAGS = ['missed_call', 'competitor', 'speed', 'voicemail', 'stat_62', 'stat_74', 'stat_78'];

function conceptText(c = {}) {
  const cp = c.concept_plan || {};
  return [
    c.objective, c.audience_problem, c.angle, c.module_theme, c.hook || cp.hook,
    c.fga_pov, c.cta || cp.cta, cp.visual_direction,
    Array.isArray(cp.slide_outline) ? cp.slide_outline.join(' ') : cp.slide_outline,
  ].filter(Boolean).join(' \n ');
}

function detectThemeTags(c = {}) {
  const text = conceptText(c);
  const tags = [];
  for (const [tag, re] of Object.entries(THEME_PATTERNS)) {
    if (re.test(text)) tags.push(tag);
  }
  return tags;
}

// Classify a hook/headline's structural shape so we can avoid repeating the
// same structure (question vs imperative vs two-clause echo vs number-anchor).
function classifyHeadlinePattern(text = '') {
  const t = String(text || '').trim();
  if (!t) return 'none';
  if (/\?$/.test(t)) return 'question';
  // Two-clause echo: "X. Y." (the banned pattern)
  if (/^[^.?!]{3,}[.?!]\s+[^.?!]{3,}[.?!]?$/.test(t)) return 'two_clause';
  if (/^\d|\b\d+%|\$\d/.test(t)) return 'number_anchor';
  if (/^(stop|start|do|send|ask|build|try|get|use)\b/i.test(t)) return 'imperative';
  return 'declarative';
}

function classifyOpeningStructure(c = {}) {
  const cp = c.concept_plan || {};
  const first = String(c.hook || cp.hook || c.audience_problem || '').trim();
  if (/^(you'?re|you are|imagine|picture|it'?s)\b/i.test(first)) return 'scene';
  if (/\?/.test(first)) return 'question';
  if (/^\d|\$\d|\b\d+%/.test(first)) return 'number';
  return 'statement';
}

/**
 * Build a fingerprint row from a concept (or a finalized draft-shaped object).
 */
function computeFingerprint(c = {}) {
  const hook = c.hook || (c.concept_plan && c.concept_plan.hook) || c.headline || '';
  const statKey = c.evidence_kind === 'stat'
    ? (c.evidence_ref && (c.evidence_ref.stat_id || c.evidence_ref.value_label || c.evidence_ref.stat)) || null
    : null;
  const fp = {
    objective: c.objective || null,
    topic: c.module_theme || c.angle || null,
    industry: c.industry || null,
    module: c.is_module_post ? (c.module_theme || null) : null,
    painpoint: (c.audience_problem || '').slice(0, 160) || null,
    hook_pattern: classifyHeadlinePattern(hook),
    headline_pattern: classifyHeadlinePattern(hook),
    statistic_key: statKey ? String(statKey) : null,
    scenario: (c.scenario || '').slice(0, 160) || null,
    format_id: c.format_id != null ? Number(c.format_id) : null,
    cta_type: c.cta_type || null,
    opening_structure: classifyOpeningStructure(c),
    emotional_framing: c.emotional_framing || c.tone || null,
    theme_tags: detectThemeTags(c),
  };
  fp.combined_hash = crypto
    .createHash('sha1')
    .update([fp.objective, fp.topic, fp.industry, fp.module, fp.statistic_key, fp.hook_pattern].join('|').toLowerCase())
    .digest('hex');
  return fp;
}

function jaccard(a = [], b = []) {
  const sa = new Set((a || []).map((x) => String(x).toLowerCase()));
  const sb = new Set((b || []).map((x) => String(x).toLowerCase()));
  if (!sa.size && !sb.size) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

const eq = (a, b) => (a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0);

// Weighted similarity 0..1 over the highest-signal dimensions.
const WEIGHTS = {
  statistic_key: 0.18,
  painpoint: 0.16,
  headline_pattern: 0.10,
  module: 0.12,
  objective: 0.10,
  topic: 0.12,
  format_id: 0.07,
  theme_tags: 0.15,
};

function similarityScore(a = {}, b = {}) {
  let score = 0;
  let total = 0;
  for (const [dim, w] of Object.entries(WEIGHTS)) {
    let comp;
    if (dim === 'theme_tags') {
      const ea = !(a.theme_tags && a.theme_tags.length);
      const eb = !(b.theme_tags && b.theme_tags.length);
      if (ea && eb) continue; // both absent → not a dimension of similarity
      comp = jaccard(a.theme_tags, b.theme_tags);
    } else if (dim === 'painpoint') {
      const ta = String(a.painpoint || '').toLowerCase().split(/\W+/).filter(Boolean);
      const tb = String(b.painpoint || '').toLowerCase().split(/\W+/).filter(Boolean);
      if (!ta.length && !tb.length) continue;
      comp = jaccard(ta, tb);
    } else {
      const ea = a[dim] == null || a[dim] === '';
      const eb = b[dim] == null || b[dim] === '';
      if (ea && eb) continue; // both empty → skip, don't penalize
      comp = eq(a[dim], b[dim]);
    }
    total += w;
    score += w * comp;
  }
  return total ? score / total : 0;
}

/**
 * Flag overused themes given the candidate + recent fingerprints.
 */
function detectOveruse(candidate = {}, recent = []) {
  const warnings = [];
  const counts = {};
  for (const fp of recent) for (const tag of (fp.theme_tags || [])) counts[tag] = (counts[tag] || 0) + 1;
  for (const tag of (candidate.theme_tags || [])) {
    if (OVERUSED_TAGS.includes(tag) && (counts[tag] || 0) >= 1) {
      warnings.push(`Theme "${tag}" was used ${counts[tag]} time(s) in recent content — vary the angle.`);
    }
  }
  return warnings;
}

/**
 * Compare a candidate fingerprint against recent ones.
 * @returns {{maxScore:number, mostSimilar:Object|null, warnings:string[], reject:boolean}}
 */
function checkRepetition(candidate = {}, recent = [], opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.82;
  let maxScore = 0;
  let mostSimilar = null;
  for (const fp of recent) {
    const s = similarityScore(candidate, fp);
    if (s > maxScore) { maxScore = s; mostSimilar = fp; }
  }
  const warnings = detectOveruse(candidate, recent);
  if (maxScore >= threshold) warnings.push(`Very similar (${Math.round(maxScore * 100)}%) to a recent concept — needs a materially different angle.`);
  return { maxScore, mostSimilar, warnings, reject: maxScore >= threshold };
}

module.exports = {
  THEME_PATTERNS,
  OVERUSED_TAGS,
  detectThemeTags,
  classifyHeadlinePattern,
  computeFingerprint,
  similarityScore,
  detectOveruse,
  checkRepetition,
};
