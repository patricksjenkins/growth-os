/**
 * Strategy-first content planner.
 *
 * Replaces the old format-first round-robin. Produces a weekly plan of TWO
 * concepts (Monday + Thursday) by starting from a business objective →
 * audience problem → FGA point of view → module/theme → angle → format (chosen
 * to serve the idea, from a loose library) → evidence. NO final copy and NO
 * images here — concepts are cheap (Claude only) and require owner approval
 * before any visual cost.
 *
 * Enforces the rolling-12 content mix, tone balance, the ≤10-15% stat policy,
 * 15-25% founder-led, the ~1/3 module vs broader-managed-AI split, and steers
 * away from overused themes (missed-call / competitor / speed / 62-74-78%).
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../logger');
const { getConfig } = require('../config');
const { db } = require('../../db/client');
const { BRAND_VOICE } = require('../fga-content-playbook');
const founder = require('./founder-perspectives');
const stats = require('./statistics');
const pillarsLib = require('./pillars');
const visualTypesLib = require('./visual-types');
const hooksLib = require('./hooks');
const moduleRotation = require('./module-rotation');

// Business objectives the planner picks from (goal §"CONTENT BUSINESS OBJECTIVES").
const OBJECTIVES = [
  'Build Trust', 'Educate the Audience', 'Explain Managed AI', 'Demonstrate a Workflow',
  'Introduce a Module', 'Show How Modules Work Together', 'Address an Objection',
  'Build Founder Credibility', 'Create Category Awareness', 'Show a Micro-Business Scenario',
  'Explain a Business Problem', 'Show a Before-and-After Workflow', 'Generate Discovery Calls',
  'Promote FGA Directly', 'Show Behind-the-Scenes Operations', 'Explain What FGA Manages After Go-Live',
];

// Angle library (goal §"CONTENT ANGLE LIBRARY").
const ANGLES = [
  'Managed Service vs Software', 'Workflow Walkthrough', 'Before and After Operations',
  'Owner Capacity', 'Customer Experience', 'Module Combination', 'Behind the Build',
  'Common Objection', 'Founder Point of View', 'Operational Blind Spot', 'Practical Checklist',
  'Decision Framework', 'Seasonal Workflow', 'What Happens After',
];

// FGA modules (plain-English names) for module-specific posts.
const MODULES = [
  'Speed-to-Lead', 'Missed Call Text-Back', 'Follow-Up Sequences', 'Review Requests',
  'Content Engine + Content Approval', 'AI Voice Receptionist', 'Referral Engine',
  'Prospecting Engine', 'AI Chat Agent', 'Done-For-You Website', 'Lead Capture & CRM',
  'Command Center',
];

// Loose format library → base renderer id (1-9) in core/fga-content-formats.js.
// New conceptual formats reuse a proven visual base so the image pipeline keeps
// working. needsScreenshot flags concepts that want a real product screenshot.
const FORMAT_LIBRARY = [
  { name: 'One-Liner', base: 1 },
  { name: 'Founder Note', base: 2 },
  { name: 'Stat Card', base: 3 },
  { name: 'Before and After', base: 4 },
  { name: 'Anti-Pattern', base: 5 },
  { name: 'Tactical How-To', base: 6 },
  { name: 'Industry Spotlight', base: 7 },
  { name: 'Behind the Build', base: 8 },
  { name: 'Module Spotlight', base: 9 },
  { name: 'Workflow Walkthrough', base: 6 },
  { name: 'Screenshot Breakdown', base: 8, needsScreenshot: true },
  { name: 'Agent Handoff Diagram', base: 8 },
  { name: 'Myth vs Reality', base: 5 },
  { name: 'Checklist', base: 6 },
  { name: 'Decision Tree', base: 6 },
  { name: 'What Happens After', base: 6 },
  { name: 'Objection Answer', base: 5 },
  { name: 'Managed Service Comparison', base: 5 },
  { name: 'Module Combination', base: 9 },
  { name: 'Owner Capacity', base: 4 },
  { name: 'Customer Experience Sequence', base: 6 },
];

// Rolling-12 target mix (goal §"ROLLING CONTENT MIX").
const TARGET_MIX = {
  practical_education: 3, module_or_workflow: 2, founder_perspective: 2,
  industry_scenario: 2, customer_transformation: 1, objection: 1, promotional: 1,
};

function resolveFormat(name) {
  if (!name) return null;
  const norm = String(name).toLowerCase();
  return FORMAT_LIBRARY.find((f) => f.name.toLowerCase() === norm)
    || FORMAT_LIBRARY.find((f) => norm.includes(f.name.toLowerCase()))
    || null;
}

// Map a chosen format to a renderable base id (1-9).
function selectFormatLoose(name, recentFormatIds = []) {
  const f = resolveFormat(name) || FORMAT_LIBRARY.find((x) => !recentFormatIds.includes(x.base)) || FORMAT_LIBRARY[5];
  return { name: f.name, base: f.base, needsScreenshot: !!f.needsScreenshot };
}

// Default visual_type per renderable base format, used when the planner omits
// or returns an unknown visual_type. Biased toward SHOW-the-idea types.
const FORMAT_BASE_VISUAL = {
  1: 'pain_scenario', 2: 'founder_pov', 3: 'stat_visual', 4: 'before_after',
  5: 'before_after', 6: 'service_business', 7: 'service_business',
  8: 'product_workflow', 9: 'command_center',
};
function coerceVisualType(vt, formatBase) {
  if (vt && visualTypesLib.getById(vt)) return vt;
  return FORMAT_BASE_VISUAL[formatBase] || 'service_business';
}

/**
 * Rolling-12 snapshot — what's been produced recently, so the planner can
 * balance the next two posts. Reads recent concepts + fingerprints.
 */
async function computeMixSnapshot(tenantId) {
  const snap = {
    recent_objectives: [], recent_modules: [], recent_industries: [],
    recent_theme_tags: [], recent_formats: [], recent_stat_keys: [],
    founder_count: 0, module_count: 0, stat_count: 0, total: 0,
  };
  try {
    const { data: concepts } = await db.from('content_plan_concepts')
      .select('objective,module_theme,industry,format_id,evidence_kind,is_module_post,created_at')
      .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(12);
    for (const c of concepts || []) {
      snap.total++;
      if (c.objective) snap.recent_objectives.push(c.objective);
      if (c.module_theme) snap.recent_modules.push(c.module_theme);
      if (c.industry) snap.recent_industries.push(c.industry);
      if (c.format_id) snap.recent_formats.push(c.format_id);
      if (c.evidence_kind === 'founder_perspective') snap.founder_count++;
      if (c.evidence_kind === 'stat') snap.stat_count++;
      if (c.is_module_post) snap.module_count++;
    }
    const { data: fps } = await db.from('content_fingerprints')
      .select('theme_tags,statistic_key,created_at')
      .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(12);
    for (const f of fps || []) {
      for (const t of (f.theme_tags || [])) snap.recent_theme_tags.push(t);
      if (f.statistic_key) snap.recent_stat_keys.push(f.statistic_key);
    }
  } catch (_) { /* empty history is fine */ }
  return snap;
}

function buildPlannerSystemPrompt(tenant) {
  const website = getConfig(tenant, 'website', 'firstgenautomate.com');
  return `You are the content strategist for First Gen Automate (FGA), a MANAGED AI + automation service for micro businesses (1-9 people). FGA is NOT software the owner configures and NOT a marketing agency — FGA identifies the workflow, configures the solution, implements it, connects the systems, then monitors, maintains, and improves it. Tagline (use only when it fits, never mechanically): "Automate the Overhead. Focus on the Work."

Your job: produce TWO strategy-first post CONCEPTS (Monday + Thursday) for Instagram + Facebook. A concept is a PLAN, not finished copy. Start from a business objective, then the audience's real problem, then FGA's point of view, then the module/theme, then the angle, then choose the format that best serves the idea, then pick evidence. The format SERVES the idea — never invent an idea just to fill a format.

AUDIENCE: owner-operated micro businesses, any trade (plumber, HVAC, electrician, landscaper, roofer, cleaner, salon, gym, accountant, photographer, dental, food truck, consultant). Owners work in the field, have no marketing team, no receptionist, no automation specialist, and tasks depend on memory.

FGA DIFFERENTIATORS to communicate often: Managed AI (owner needn't become an expert); Done-for-You setup (configured for how their business runs, not another empty tool); Ongoing Management (monitored, maintained, improved after go-live); Connected Modules (work together as an operating system); Built for micro businesses; Practical outcomes (faster response, less manual follow-up, better organization, fewer forgotten tasks, more owner capacity).

FLAGSHIP: the 24/7 AI Voice Receptionist (a lead calls, the AI answers, captures the caller's details, qualifies the request, and sends the owner the info to follow up) and the Command Center (one simple place to see calls, leads, follow-ups, and activity). Feature these regularly.

PRIMARY SIX-MODULE CONTENT PROGRAM:
${moduleRotation.promptBlock()}
These six modules are the feed's backbone. Complete them in the required round-robin order. One post teaches one module; do not collapse the six into generic "automation" content. On later rotations, change the industry example, angle, format, and visual proof.

EVERY CONCEPT MUST COMMIT TO:
- One STRONG hook (use or riff on the hook bank — never a flat headline, never the banned "[clause]. [echo clause]." pattern).
- A visual_type that SHOWS the pain, product, workflow, or outcome — NOT words on a card. Prefer product_workflow / pain_scenario / before_after / command_center / service_business / carousel_story. Use the text-card types (founder_pov, stat_visual) sparingly.
- A clear ending. A CTA is optional. If one genuinely fits, invite a normal conversation or a visit to the website. Never use keyword DMs, keyword comments, engagement bait, false urgency, or a forced sales close.

VOICE:
${BRAND_VOICE}

HARD RULES:
- Do NOT promise guaranteed leads, revenue, savings, bookings, or specific outcomes.
- Do NOT claim FGA sees the owner's calendar, schedule, dispatch, inventory, or pricing. No "we'll book/dispatch/get you on the schedule".
- Customer examples are FICTIONAL (a tree-service owner, an HVAC company, etc.) with realistic PROCESS outcomes (the inquiry is captured, the follow-up is scheduled, the review request is sent) — never invented revenue/conversion/lead numbers, never a real customer name, never framed as a case study.
- Founder-led concepts must use ONLY an approved founder perspective from the list provided; never fabricate a personal story or convert generated wording into a Patrick quote. The approved perspective informs the point of view without attribution on the graphic.
- Reduce fear-based framing. Lead with possibility, education, workflow clarity, and what happens automatically — not "you lost the job / missed the call / competitor won".

Website: ${website}. Return ONLY valid JSON.`;
}

function buildPlannerUserPrompt(ctx) {
  const { snapshot, feedback, eligibleStats, founderList, weekStart } = ctx;
  const recentThemes = [...new Set(snapshot.recent_theme_tags)].join(', ') || 'none';
  const recentObj = [...new Set(snapshot.recent_objectives)].join(', ') || 'none';
  const recentMods = [...new Set(snapshot.recent_modules)].join(', ') || 'none';
  const recentInd = [...new Set(snapshot.recent_industries)].join(', ') || 'none';
  const fb = (feedback || []).slice(0, 8).map((f) => `- [${f.reason_code || f.decision}] ${f.reason_text || ''}`).join('\n') || 'none yet';
  const statList = (eligibleStats || []).slice(0, 6).map((s, i) => `  ${i + 1}. (${s.id}) ${s.stat_text} — ${s.theme_tag || 'general'}`).join('\n') || '  (none eligible — write non-stat concepts)';
  const founders = (founderList || []).map((p) => `  - (${p.id}) "${p.perspective}"`).join('\n');
  const requiredModules = moduleRotation.nextModules(snapshot.recent_modules, { count: 2, weekStart });

  return `Plan the week of ${weekStart}. Produce exactly TWO concepts: one slot="monday", one slot="thursday".

REQUIRED MODULE ROTATION FOR THIS WEEK:
- Monday: ${requiredModules[0].name}. Product truth: ${requiredModules[0].truth} Visual: ${requiredModules[0].visual}
- Thursday: ${requiredModules[1].name}. Product truth: ${requiredModules[1].truth} Visual: ${requiredModules[1].visual}
Both concepts MUST be module-specific, use the exact assigned module_theme, and teach a different part of the FGA product story. Broader managed-service, founder, education, objection, or industry ideas may shape the ANGLE, but may not replace the assigned module.

ROLLING-12 SUPPORTING MIX (use as angle variety inside the module program): practical education, workflow demonstration, founder perspective, industry scenario, transformation, objection-handling, and occasional direct promotion. Stat-led posts ≤10-15%; most concepts should not use a statistic.

RECENT CONTENT (avoid repeating these — pick materially different objectives, themes, industries, modules):
- Recent objectives: ${recentObj}
- Recent modules: ${recentMods}
- Recent industries: ${recentInd}
- OVERUSED themes to AVOID this week: ${recentThemes}
- Founder posts in last 12: ${snapshot.founder_count}; Module posts: ${snapshot.module_count}; Stat posts: ${snapshot.stat_count}

OWNER FEEDBACK to honor:
${fb}

APPROVED FOUNDER PERSPECTIVES (use one of these ids if a concept is founder-led; do not invent stories):
${founders}

ELIGIBLE STATISTICS (only if a concept is genuinely stat-led — at most ONE of the two concepts, ideally zero; cite by id):
${statList}

FORMAT LIBRARY (choose the best fit by name; do not force variety for its own sake): One-Liner, Founder Note, Stat Card, Before and After, Anti-Pattern, Tactical How-To, Industry Spotlight, Behind the Build, Module Spotlight, Workflow Walkthrough, Screenshot Breakdown, Agent Handoff Diagram, Myth vs Reality, Checklist, Decision Tree, What Happens After, Objection Answer, Managed Service Comparison, Module Combination, Owner Capacity, Customer Experience Sequence.

FGA PILLARS (reach for these regularly — they carry the current positioning):
${pillarsLib.promptBlock()}

VISUAL TYPES (pick the one that best SHOWS the idea; avoid defaulting to a text card):
${visualTypesLib.promptBlock()}

HOOK BANK (use or riff — do not paste verbatim):
${hooksLib.promptBlock()}

For EACH concept return this exact JSON shape:
{
  "objective_summary": "one line describing the week's two-post strategy",
  "concepts": [
    {
      "slot": "monday",
      "objective": "<one of the business objectives>",
      "audience": "general | <specific trade>",
      "industry": "<trade or 'general'>",
      "audience_problem": "the concrete micro-business problem/opportunity this addresses",
      "fga_pov": "FGA's point of view / what FGA actually does about it (plain English, no overpromise)",
      "module_theme": "<module name if module-specific, else the broader theme>",
      "is_module_post": true|false,
      "angle": "<one of the angle library>",
      "pillar": "<one pillar id, e.g. ai_voice_receptionist, missed_calls_cost_money, command_center, managed_ai_not_another_app, followup_admin_overhead, micro_business_reality, before_after_fga — or '' if it fits the older editorial pillars>",
      "format_name": "<one format from the library>",
      "visual_type": "<product_workflow | pain_scenario | before_after | command_center | service_business | carousel_story | founder_pov | stat_visual — choose one that SHOWS the idea>",
      "evidence_kind": "stat | founder_perspective | scenario | none",
      "evidence_ref": { "stat_id": "<id if stat>", "perspective_id": "<id if founder>", "scenario": "<short fictional scenario if scenario>" },
      "tone": "constructive | educational | founder | reassuring | confident",
      "emotional_framing": "possibility | clarity | relief | curiosity | pride | (avoid pure fear)",
      "cta_type": "save | reflect | follow | learn_more | message | book_call | website | share | ask",
      "needs_screenshot": true|false,
      "concept_plan": {
        "hook": "proposed scroll-stopping hook line (NOT final copy, just the idea)",
        "visual_direction": "what the visual should show (scene, diagram, screenshot, card)",
        "cta": "ending or optional next-step idea; use an empty string when no CTA improves the post",
        "slide_outline": ["beat 1", "beat 2", "..."]
      },
      "selection_reason": "why this concept now (mix balance, freshness vs recent, objective)"
    },
    { "slot": "thursday", ... }
  ]
}

The two concepts MUST have different objectives and different angles. At most one may be stat-led. Keep claims safe. Monday must use module_theme="${requiredModules[0].name}" and Thursday must use module_theme="${requiredModules[1].name}". Return ONLY the JSON.`;
}

/**
 * Generate the weekly plan (2 concepts). Claude only — no images, no drafts.
 * @returns {Promise<{objective_summary:string, concepts:Object[]}>}
 */
async function buildWeeklyPlan(tenant, opts = {}) {
  const log = createLogger('strategy-planner', tenant.slug);
  const snapshot = opts.mixSnapshot || await computeMixSnapshot(tenant.id);
  const eligibleStats = await stats.getEligibleStats(tenant.id, {
    industry: null,
    recentStatKeys: snapshot.recent_stat_keys,
    recentThemeTags: snapshot.recent_theme_tags,
  });
  const founderList = founder.all();

  const system = buildPlannerSystemPrompt(tenant);
  const user = buildPlannerUserPrompt({
    snapshot, feedback: opts.feedback, eligibleStats, founderList, weekStart: opts.weekStart,
  });

  const result = await askClaudeJSON(system, user, {
    maxTokens: 3000, tenant, tenantSlug: tenant.slug,
    agentName: 'content-plan', operationType: 'content_plan',
  });

  let concepts = Array.isArray(result.concepts) ? result.concepts : [];
  const requiredModules = moduleRotation.nextModules(snapshot.recent_modules, { count: 2, weekStart: opts.weekStart });
  if (concepts.length < 2 || concepts.slice(0, 2).some((concept, index) => !moduleRotation.matchesModule(concept.module_theme, requiredModules[index]))) {
    throw new Error(`Module rotation violation: expected ${requiredModules.map((module) => module.name).join(' then ')}`);
  }
  // Normalize: resolve format → renderable base id; clamp to 2 concepts.
  concepts = concepts.slice(0, 2).map((c) => {
    const f = selectFormatLoose(c.format_name, snapshot.recent_formats);
    return {
      ...c,
      format_name: f.name,
      format_id: f.base,
      visual_type: coerceVisualType(c.visual_type, f.base),
      pillar: c.pillar && pillarsLib.getById(c.pillar) ? c.pillar : (c.pillar || null),
      needs_screenshot: !!(c.needs_screenshot || f.needsScreenshot),
      hook: (c.concept_plan && c.concept_plan.hook) || c.hook || '',
      cta: (c.concept_plan && c.concept_plan.cta) || c.cta || '',
    };
  });
  log.info(`Planned ${concepts.length} concepts: ${concepts.map((c) => `${c.slot}=${c.objective}/${c.format_name}`).join(', ')}`);
  return { objective_summary: result.objective_summary || '', concepts };
}

/**
 * Build ONE strategy-first concept on demand — for the owner "+ Request Post"
 * flow on a planner-enabled tenant. Seeded by the owner's topic/prompt when
 * given; otherwise picks the freshest worthwhile idea. Honors an explicitly
 * chosen format. Returns a normalized concept (same shape as the planner's),
 * or null on failure so the caller can fall back to the legacy path.
 */
async function buildAdhocConcept(tenant, { topic, customPrompt, preferredFormatId } = {}) {
  const log = createLogger('strategy-planner', tenant.slug);
  const snapshot = await computeMixSnapshot(tenant.id);
  const eligibleStats = await stats.getEligibleStats(tenant.id, {
    industry: null, recentStatKeys: snapshot.recent_stat_keys, recentThemeTags: snapshot.recent_theme_tags,
  });
  const founderList = founder.all();
  const ask = (customPrompt || topic || '').trim();
  const nextModule = moduleRotation.nextModules(snapshot.recent_modules, { count: 1 })[0];

  const system = buildPlannerSystemPrompt(tenant);
  const user = `Create ONE strong, strategy-first post CONCEPT for First Gen Automate (a plan, not final copy).
${ask
  ? `The owner requested a post about:\n"""${ask}"""\nStay on that subject, but shape it into the strongest FGA angle (managed service vs software, a workflow walkthrough, a specific module, a founder POV, an objection, or a micro-business scenario).`
  : `Build the next module in the primary rotation: ${nextModule.name}. Product truth: ${nextModule.truth}. Visual direction: ${nextModule.visual}. Set module_theme="${nextModule.name}" and is_module_post=true.`}

Avoid repeating recent content. Recent objectives: ${[...new Set(snapshot.recent_objectives)].join(', ') || 'none'}. OVERUSED themes to avoid: ${[...new Set(snapshot.recent_theme_tags)].join(', ') || 'none'}.
Use a statistic ONLY if it genuinely strengthens the point (most posts should not). Eligible stats (cite by id if used): ${(eligibleStats || []).slice(0, 4).map((s) => `(${s.id}) ${s.stat_text}`).join(' | ') || 'none'}.
Approved founder perspectives (use one id if founder-led; never invent a story): ${founderList.map((p) => `(${p.id}) ${p.perspective}`).join(' | ')}.
${preferredFormatId ? `The owner chose format id ${preferredFormatId} — use it.` : 'Choose the format that best serves the idea from the library.'}

Return JSON exactly:
{ "concept": { "objective": "", "audience": "general|<trade>", "industry": "<trade or general>", "audience_problem": "", "fga_pov": "", "module_theme": "", "is_module_post": true|false, "angle": "", "pillar": "<pillar id or ''>", "format_name": "", "visual_type": "<product_workflow|pain_scenario|before_after|command_center|service_business|carousel_story|founder_pov|stat_visual>", "evidence_kind": "stat|founder_perspective|scenario|none", "evidence_ref": { "stat_id": "", "perspective_id": "", "scenario": "" }, "tone": "", "emotional_framing": "possibility|clarity|relief|curiosity|pride", "cta_type": "save|reflect|follow|learn_more|message|book_call|website|share|ask", "needs_screenshot": false, "concept_plan": { "hook": "", "visual_direction": "", "cta": "", "slide_outline": [] }, "selection_reason": "" } }`;

  let r;
  try {
    r = await askClaudeJSON(system, user, {
      maxTokens: 1600, tenant, tenantSlug: tenant.slug,
      agentName: 'content-generation', operationType: 'content_adhoc_concept',
    });
  } catch (e) { log.warn(`buildAdhocConcept failed: ${e.message}`); return null; }

  const c = (r && r.concept) || r;
  if (!c || !c.objective) return null;
  const f = preferredFormatId
    ? { name: (FORMAT_LIBRARY.find((x) => x.base === Number(preferredFormatId)) || {}).name || 'Module Spotlight', base: Number(preferredFormatId), needsScreenshot: false }
    : selectFormatLoose(c.format_name, snapshot.recent_formats);
  return {
    ...c,
    format_name: f.name, format_id: f.base,
    visual_type: coerceVisualType(c.visual_type, f.base),
    pillar: c.pillar || null,
    needs_screenshot: !!(c.needs_screenshot || f.needsScreenshot),
    hook: (c.concept_plan && c.concept_plan.hook) || c.hook || '',
    cta: (c.concept_plan && c.concept_plan.cta) || c.cta || '',
  };
}

module.exports = {
  OBJECTIVES, ANGLES, MODULES, FORMAT_LIBRARY, TARGET_MIX,
  resolveFormat, selectFormatLoose, computeMixSnapshot, buildWeeklyPlan, buildAdhocConcept,
};
