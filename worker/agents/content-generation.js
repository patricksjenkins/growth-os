/**
 * Growth OS — Content Generation Agent
 * Ported from WellMor agents/content-agent.js
 *
 * Now tenant-aware: loads content_pillars, brand_voice, and format templates
 * from tenant config instead of hardcoded values.
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { pickRandom } = require('../../core/utils');
const { FORMAT_PILLAR_MAP } = require('../../core/fga-content-playbook');
const {
  INDUSTRY_TONE_HINTS,
  INDUSTRY_TONE_FALLBACK,
} = require('../../core/fga-content-formats');
const { buildFactsBlock } = require('../../core/fga-research-stats');

// Hard ban — Claude must not name specific clients in any generated content.
// Even with prompt-level guardrails ("DO NOT name a client") we've seen
// slips like Format 4 generating "A Kut Above, our tree-service client in
// Georgia". Post-generation we scan EVERY text field on EVERY slide plus
// caption + post_theme; one hit fails the whole draft and the cron retries
// on the next schedule with a fresh prompt.
const BANNED_CLIENT_STRINGS = [
  'A Kut Above',
  'a kut above',
  'AKA Tree',
  'aka tree',
  'WellMor',
  'wellmor',
  'WellMor Benefits',
];

/**
 * Scan all text-bearing fields on a Claude content draft for banned client
 * names. Returns the first violation found, or null if clean.
 */
function findContentGuardrailViolations(result) {
  const parts = [
    result.caption || '',
    result.post_theme || '',
    result.headline || '',
  ];
  for (const slide of (result.slides || [])) {
    parts.push(slide.headline || '');
    parts.push(slide.body || '');
    parts.push(slide.subtext || '');
    if (Array.isArray(slide.bullets)) parts.push(slide.bullets.join(' '));
  }
  const text = parts.join('\n');
  for (const banned of BANNED_CLIENT_STRINGS) {
    if (text.includes(banned)) {
      return `banned client name in draft: "${banned}"`;
    }
  }
  return null;
}

/**
 * Per-process in-memory lock of topics currently being generated.
 *
 * The bug we are guarding against: on 2026-05-12 Patrick fired 4 test jobs
 * in parallel. All 4 hit the queue before any draft was written, so the
 * anti-repetition history (which reads from content_drafts) was empty for
 * every one. Result: 4 posts that all landed on the same topic.
 *
 * This Set holds (tenantId, topicKey) entries for the duration of an
 * in-flight content-generation run. The key is a normalized topic prefix;
 * if another concurrent job for the same tenant tries to use a topic that
 * overlaps, we add a "TOPIC AVOIDANCE" block to its prompt forcing Claude
 * to pick a different angle.
 *
 * Limitations:
 *   - Only works within a single Node process. Two worker pods would still
 *     collide. That's acceptable for now — Railway runs one worker.
 *   - Cleared on process restart. Acceptable: cron fires aren't simultaneous
 *     in normal operation, only in batch-test scenarios.
 */
const IN_FLIGHT_TOPICS = new Set();

function topicKey(tenantId, topic) {
  return `${tenantId}::${String(topic || '').toLowerCase().slice(0, 80).replace(/\s+/g, ' ').trim()}`;
}

/**
 * Pull the last N drafts' topics/headlines for this tenant so we can pass
 * them to Claude as "do NOT repeat any of these". Without this, Claude has
 * no memory and produces the same idea over and over (the bug Patrick saw
 * in May 2026: 4 of 10 drafts were variants of "missed opportunity").
 */
async function getRecentDraftHistory(tenantId, n = 8) {
  try {
    const { data } = await db
      .from('content_drafts')
      .select('topic, headline, body, campaign_payload, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(n);
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Extract the body+caption+slide-text string for a draft, used by the
 * stat-lock to detect which research stats have been cited recently.
 */
function draftFullText(draft) {
  const parts = [];
  if (draft.headline) parts.push(draft.headline);
  if (draft.body) parts.push(draft.body);
  const content = draft.campaign_payload?.content;
  if (content?.caption) parts.push(content.caption);
  if (Array.isArray(content?.slides)) {
    for (const s of content.slides) {
      if (s.headline) parts.push(s.headline);
      if (s.body) parts.push(s.body);
      if (Array.isArray(s.bullets)) parts.push(s.bullets.join(' '));
    }
  }
  return parts.join('\n');
}

/**
 * Build the system prompt using tenant config
 */
function buildSystemPrompt(tenant, recentHistory = [], focusIndustry = null, inFlightTopics = [], recentDraftTexts = [], regenerateFeedback = null) {
  const businessName = getConfig(tenant, 'business_name', 'Our Company');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Professional and helpful.');
  const website = getConfig(tenant, 'website', '');

  const historyBlock = recentHistory.length
    ? `\nRECENT POSTS (do NOT repeat the topic, headline structure, or angle of any of these):\n${recentHistory
        .map((d, i) => `  ${i + 1}. Topic: "${(d.topic || '').slice(0, 120)}"\n     Headline: "${d.headline || ''}"`)
        .join('\n')}\n`
    : '';

  // In-flight topic block: prevents parallel-batch collision. Even though
  // the persisted draft history is empty when 4 jobs fire simultaneously,
  // this list shows Claude what OTHER concurrent jobs are about to produce
  // so it picks a different angle.
  const inFlightBlock = inFlightTopics.length
    ? `\nCONCURRENT POSTS BEING WRITTEN RIGHT NOW (different jobs running in parallel — pick a DIFFERENT angle than these):\n${inFlightTopics
        .map((t, i) => `  ${i + 1}. "${String(t).slice(0, 120)}"`)
        .join('\n')}\n`
    : '';

  // Industry-aware tone microdose: small vocabulary tweak based on the
  // week's rotated focus industry. The base voice stays uniform; this just
  // shifts the lexicon so HVAC posts use HVAC terms, plumbing posts use
  // plumbing terms, etc.
  const toneHint = focusIndustry && INDUSTRY_TONE_HINTS[focusIndustry]
    ? INDUSTRY_TONE_HINTS[focusIndustry]
    : INDUSTRY_TONE_FALLBACK;

  const industryBlock = focusIndustry
    ? `\nINDUSTRY FOCUS THIS WEEK: ${focusIndustry}\nThe post is for ${focusIndustry} business owners specifically. Reference their tools, their typical jobs, their language. Should feel useless to anyone outside this trade.\n\nTONE NOTE FOR THIS INDUSTRY: ${toneHint}\n`
    : '';

  // Real research stats Claude is allowed to cite. Without this block,
  // Claude invents plausible-sounding numbers ("A Kut Above booked 4 of
  // their next 5 estimates" was fabricated in the 2026-05-12 test batch).
  // The buildFactsBlock returns the FACTS YOU MAY CITE list plus the
  // explicit "do not invent numbers" rules.
  //
  // Stat-lock: recentDraftTexts feeds in body+caption of the last N drafts.
  // buildFactsBlock filters out any fact whose `match` fingerprint appears
  // in those texts so Claude is forced to pick a different stat than the
  // last few posts used. Fixes the "3 of 4 test posts all cited 78%
  // Lead Connect" issue from the 2026-05-13 retest.
  const factsBlock = '\n' + buildFactsBlock(focusIndustry, recentDraftTexts) + '\n';

  return `
You are a copywriter for ${businessName}. Your reader is a 1-3 person service
business owner (plumber, electrician, tree service, landscaper, HVAC, roofer,
cleaning). They're on a job site, between calls. They don't read marketing
blogs. They don't care about technology. They care about getting more
customers without more work.

YOUR VOICE:
${brandVoice}

NON-NEGOTIABLE RULES:
- One core idea per slide. No bullet-heavy writing unless format specifically calls for bullets.
- Body text MUST be 20-35 words maximum per slide. This text is overlaid on images. Long text bleeds off the slide.
- Every post MUST include at least one concrete anchor: a real number with source, a real client name (A Kut Above OR WellMor Benefits — NEVER invent client names or numbers), a specific scenario with time/place, or a literal script/template.
- The headline of slide 1 (hook) must give away that this is for a service business specifically — not so generic it could be for any business.

BRAND CONTEXT:
- ${businessName}
${website ? `- Website: ${website}` : ''}
${industryBlock}${factsBlock}${historyBlock}${inFlightBlock}${regenerateFeedback ? `\nREGENERATION FEEDBACK FROM THE OWNER (priority — this is the human telling you what to fix):\n"""${regenerateFeedback}"""\nThe owner just rejected a prior draft for this exact format. Address the feedback explicitly in this version. If the feedback contradicts a banned phrase or guardrail above, follow the guardrail, but rephrase to honor the spirit of the feedback.\n` : ''}
Return only valid JSON.
`;
}

/**
 * Build slide instructions from format template
 */
function buildSlideInstructions(formatTemplate) {
  const cs = formatTemplate.contentStructure;
  const slideCount = typeof formatTemplate.slideCount === 'number' ? formatTemplate.slideCount : 5;

  const slideLines = formatTemplate.slides.map((s, i) => {
    const role = s.role;
    const instruction = cs.slideInstructions[role] || cs.slideInstructions.content || 'Headline + body text.';
    return `  Slide ${i + 1} (${role}): ${instruction}`;
  }).join('\n');

  return { slideLines, slideCount, contentType: cs.type };
}

/**
 * Build JSON shape example for Claude
 */
function buildJsonShape(formatTemplate, pillar) {
  const slides = formatTemplate.slides.map((s, i) => {
    const role = s.role;
    const cs = formatTemplate.contentStructure;
    const instruction = cs.slideInstructions[role] || cs.slideInstructions.content || '';

    const hasBody = !instruction.toLowerCase().includes('no body') &&
                    !instruction.toLowerCase().includes('headline only') &&
                    !instruction.toLowerCase().includes('just the headline');

    const hasBullets = instruction.toLowerCase().includes('bullet') ||
                       instruction.toLowerCase().includes('list items');

    const slide = {
      slide_number: i + 1,
      role,
      headline: `${role} headline here`,
      subtext: '',
      body: hasBody ? 'body text here...' : '',
    };

    if (hasBullets) slide.bullets = ['bullet 1', 'bullet 2', 'bullet 3'];
    return slide;
  });

  return JSON.stringify({
    type: formatTemplate.contentStructure.type,
    post_theme: pillar,
    caption: 'Social media caption (2-3 sentences, conversational, 3-5 hashtags)',
    slides,
  }, null, 2);
}

/**
 * Main agent function
 * @param {Object} tenant - Resolved tenant object
 * @param {Object} payload - { topic, custom_prompt, format_id, platform }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('content-gen', tenant.slug);
  const startTime = Date.now();

  // Load tenant-specific config
  const contentPillars = getConfig(tenant, 'content_pillars', ['General business tips']);
  const contentFormats = getConfig(tenant, 'content_formats', null);
  const businessName = getConfig(tenant, 'business_name', 'Our Company');
  const targetIndustries = getConfig(tenant, 'target_industries', []);

  // Resolve THIS week's focus industry from the prospecting rotation counter.
  // The prospecting agent advances `prospecting_industry_index` every Tuesday;
  // content uses the same counter so a given week's content posts reinforce
  // the same industry that prospecting is targeting that week.
  let focusIndustry = null;
  if (Array.isArray(targetIndustries) && targetIndustries.length > 0) {
    const industryIdx = Number(getConfig(tenant, 'prospecting_industry_index', 0)) || 0;
    focusIndustry = targetIndustries[industryIdx % targetIndustries.length];
  }
  if (focusIndustry) {
    log.info(`Industry focus this week: ${focusIndustry}`);
  }

  // Determine mode: custom_prompt (user-submitted question/idea) or pillar-based
  const customPrompt = payload.custom_prompt || null;

  // Pick format template FIRST — the pillar is determined by the format
  // (FORMAT_PILLAR_MAP) so we need the format before we can choose the pillar.
  let formatTemplate;
  if (contentFormats && contentFormats.length > 0) {
    if (payload.format_id) {
      const idx = (payload.format_id - 1) % contentFormats.length;
      formatTemplate = contentFormats[idx];
    } else {
      // Round-robin: get counter from tenant config, increment
      const counterKey = `content_format_index`;
      const currentIndex = Number(getConfig(tenant, counterKey, 0)) || 0;
      formatTemplate = contentFormats[currentIndex % contentFormats.length];

      // Update counter
      await db.from('tenant_config').upsert({
        tenant_id: tenant.id,
        key: counterKey,
        value: String((currentIndex + 1) % contentFormats.length),
      }, { onConflict: 'tenant_id,key' });
    }
  } else {
    // Fallback: simple 5-slide format
    formatTemplate = getDefaultFormat();
  }

  // Pick the pillar based on the chosen format. The 1:1 mapping in
  // FORMAT_PILLAR_MAP means Format 1 always pairs with Pillar 1 (Contrarian
  // POV), Format 2 with Pillar 2 (Founder Voice), etc. Custom_prompt and
  // payload.topic still override the pillar selection.
  let pillar;
  if (customPrompt) {
    pillar = customPrompt;
  } else if (payload.topic) {
    pillar = payload.topic;
  } else {
    const fmtId = formatTemplate.id;
    const pillarIdx = FORMAT_PILLAR_MAP[fmtId];
    if (pillarIdx != null && Array.isArray(contentPillars) && contentPillars[pillarIdx]) {
      pillar = contentPillars[pillarIdx];
      log.info(`Pillar via FORMAT_PILLAR_MAP: format ${fmtId} → pillar #${pillarIdx + 1}`);
    } else {
      // Fallback only when format isn't in the map (e.g. legacy/default format)
      pillar = pickRandom(contentPillars);
      log.warn(`No FORMAT_PILLAR_MAP entry for format ${fmtId}; falling back to pickRandom`);
    }
  }

  log.info(`Generating: format="${formatTemplate.name}" (${formatTemplate.slideCount} slides) pillar="${(pillar || '').slice(0, 60)}..."`);

  // Pull recent draft history so Claude doesn't repeat itself
  const recentHistory = await getRecentDraftHistory(tenant.id, 8);
  log.info(`Anti-repetition: passing ${recentHistory.length} recent drafts to Claude`);

  // For stat-lock: extract full body+caption+slide text from the last 4
  // drafts. Using a tighter window (4) than the headline-history window
  // (8) — stat repetition over 4 posts is what hurt us; over 8 it's
  // probably fine for a stat to come back.
  const recentDraftTexts = recentHistory.slice(0, 4).map(draftFullText);

  // Snapshot of OTHER concurrent jobs for this tenant. The current job
  // will register its own key below, after we have built the prompt.
  const inFlightTopics = Array.from(IN_FLIGHT_TOPICS)
    .filter((k) => k.startsWith(`${tenant.id}::`))
    .map((k) => k.split('::').slice(1).join('::'));

  // Register THIS job's topic so other in-flight jobs see it. Wrapped in
  // try/finally below so the key is released even on error/throw.
  const myTopicKey = topicKey(tenant.id, pillar);
  IN_FLIGHT_TOPICS.add(myTopicKey);

  try {

  // Build prompts
  const regenerateFeedback = (payload.regenerate_feedback || '').trim() || null;
  const systemPrompt = buildSystemPrompt(tenant, recentHistory, focusIndustry, inFlightTopics, recentDraftTexts, regenerateFeedback);
  const { slideLines, slideCount, contentType } = buildSlideInstructions(formatTemplate);
  const jsonShape = buildJsonShape(formatTemplate, pillar);

  const voiceModifier = formatTemplate.contentStructure?.voiceModifier || '';
  const fullSystemPrompt = systemPrompt + (voiceModifier ? `\n\nADDITIONAL VOICE DIRECTION:\n${voiceModifier}` : '');

  // Shared specificity / banned-phrase rules — appended to both prompt modes.
  const sharedQualityRules = `
SPECIFICITY (REQUIRED):
- The post MUST include at least ONE: a stat cited from the FACTS YOU MAY
  CITE block in the system prompt (source named), a specific scenario with
  time/place ("Tuesday 2pm, you're under a sink"), or a literal
  script/template the reader can copy.
- The hook headline must signal "service business" specifically, not be
  generic enough to apply to any business.
- Caption: 2-3 sentences, conversational. End with ONE specific CTA. Vary
  the CTA between posts. CRITICAL: the CTA must offer something NOT already
  shown in the post — if the script/template is already in the slides, the
  CTA can't say "comment for the script". It should offer the next thing
  (setup help, follow-up sequence, related template).

NUMBERS POLICY (HARD RULE):
- The ONLY numbers you may cite are those listed in the FACTS YOU MAY CITE
  block of the system prompt. No exceptions.
- Use 0 or 1 number per post. NEVER stack 2 or more numeric claims.
- DO NOT invent client outcomes ("A Kut Above booked 3 of their next 5
  estimates" was fabricated and is NOT allowed). You may reference clients
  by name as real businesses ("our tree-service client in Georgia") but
  never with metrics we have not measured.

BANNED PHRASES (do NOT use any variant):
- "Stop leaving money on the table"
- "Your business deserves [anything]"
- "While you sleep / while you work" (as a hook)
- "Your business runs itself"
- "Work smarter not harder"
- "Take your business to the next level"
- "What if you could..."
- "Are you tired of..."
- "Imagine if..."
- "It's time to..."
- "Here's the truth:"
- "Let me ask you..."
- "Top operators don't..."
- "stopped losing jobs to silence"
- "recovered booked work"
- "without you touching it"
- "stopped chasing quotes"
- "without lifting a finger"
- "on autopilot"
- "set it and forget it"
- "say goodbye to..."
- "no more [vague pain]"
- "more revenue / more leads / more bookings" without a specific number.
- Sentences starting with "Stop" or "Start" as a one-word imperative.

HEADLINE PATTERN (HARD BAN):
- Do NOT use the "[Statement]. [Echo statement]." headline structure. It
  was used in every test post on 2026-05-12 and is now banned. Examples
  of what NOT to write:
    BANNED: "The chipper's running. Your phone isn't."
    BANNED: "It rang. You missed it."
    BANNED: "You worked all day. And still lost money."
  Use a different structure: a question, a single declarative sentence, a
  number anchor ("3 calls between 11am and 2pm. You answered one." would
  ALSO be banned because it's still two-clause echo), or a direct
  instruction. When in doubt: one sentence, not two clauses that mirror
  each other.
- Also avoid any headline structure used by any of the RECENT POSTS listed
  in the system prompt.
`;

  // Number-of-slides label that respects the actual format (was previously
  // hardcoded to "5" for dynamic, ignored other slideCounts).
  const slideCountLabel = slideCount === 'dynamic'
    ? '4-6 (dynamic, see slide structure)'
    : String(slideCount);

  // Slide-count-aware instructions. The original prompt assumed 5 slides
  // and explicitly referenced "Slides 2-4" and "Slide 5" — wrong for
  // single-image (1), 2-slide, 3-slide formats. The new instruction trusts
  // the SLIDE STRUCTURE block below to define the post shape.
  const customPromptInstructions = slideCount === 1
    ? `INSTRUCTIONS FOR CUSTOM PROMPTS (SINGLE-IMAGE POST):
- This is a one-slide post. Your headline IS the post.
- Restate the owner's question/idea as a specific, scroll-stopping headline.
- Make it provocative and specific to service businesses.
- No body text needed unless the slide structure says otherwise.`
    : `INSTRUCTIONS FOR CUSTOM PROMPTS (${slideCount}-SLIDE CAROUSEL):
- The FIRST slide (hook) should restate the owner's question/idea as a specific, scroll-stopping headline.
- The remaining slides should answer or explore the question with real substance, following the slide-structure roles below.
- The LAST slide should tie back to what the owner's business actually does about this.`;

  const userPrompt = customPrompt ? `
Create a social media post for ${businessName} built around this specific idea/question from the owner:

"${customPrompt}"

Format: "${formatTemplate.name}" (${contentType})
Number of slides: ${slideCountLabel}

${customPromptInstructions}

SLIDE STRUCTURE (follow exactly):
${slideLines}
${sharedQualityRules}
Return JSON in exactly this shape:
${jsonShape}
` : `
Create a social media post for ${businessName}.
Format: "${formatTemplate.name}" (${contentType})
Number of slides: ${slideCountLabel}

CONTENT PILLAR: ${pillar}

SLIDE STRUCTURE (follow exactly):
${slideLines}
${sharedQualityRules}
Return JSON in exactly this shape:
${jsonShape}
`;

  // Generate content via Claude
  const result = await askClaudeJSON(fullSystemPrompt, userPrompt, {
    maxTokens: 3000,
    tenantSlug: tenant.slug
  });

  if (!result.slides || result.slides.length === 0) {
    throw new Error(`Expected slides, got ${result.slides?.length || 0}`);
  }

  // Guardrail post-check: reject the whole draft if Claude named a banned
  // client (e.g. "A Kut Above") despite the system-prompt rules. The job
  // fails, marker is logged, cron retries on the next schedule. Better to
  // skip one post than ship one with fabricated client attribution.
  const violation = findContentGuardrailViolations(result);
  if (violation) {
    log.warn(`Guardrail rejected content draft: ${violation}`);
    throw new Error(`Guardrail violation: ${violation}`);
  }

  // Normalize
  result.type = contentType || 'carousel';
  for (const slide of result.slides) {
    slide.body = slide.body || '';
    slide.subtext = slide.subtext || '';
    slide.bullets = slide.bullets || [];
  }

  // Backfill legacy fields
  result.hook = result.slides[0]?.headline || '';
  result.headline = result.slides[0]?.headline || '';
  result.post = result.caption || '';
  result.visual_style = `format-${formatTemplate.id}-${formatTemplate.name}`;

  log.success(`Generated ${result.slides.length} slides: "${pillar}"`);

  // Now generate images if image_generation module is enabled
  const { isModuleEnabled } = require('../../core/modules');
  let images = [];

  if (formatTemplate.slides.some(s => s.backgroundType === 'image' || s.backgroundType === 'solid')) {
    try {
      const imageAgent = require('./image-generation');
      images = await imageAgent.generateCarouselImages(tenant, {
        slides: result.slides,
        post_theme: result.post_theme || pillar,
        formatTemplate,
        focusIndustry, // industry-aware imagery substitution
      });
      log.success(`Generated ${images.length} carousel images`);
    } catch (err) {
      log.error('Image generation failed, saving draft without images', err);
    }
  }

  // Persist the focus industry on the generated payload so we can audit
  // cross-system consistency after the fact (verification step:
  // campaign_payload.content.focus_industry should equal that week's
  // prospecting_industry_index → target_industries[idx]).
  result.focus_industry = focusIndustry || null;

  // Save to content_drafts
  const { data: draft, error: dbError } = await db
    .from('content_drafts')
    .insert({
      tenant_id: tenant.id,
      content_type: result.type,
      platform: payload.platform || 'instagram',
      status: 'draft',
      headline: result.headline,
      body: result.post,
      image_urls: images.map(img => img.public_url || img.file_name),
      campaign_payload: {
        content: result,
        carousel_images: images,
        // Persist the FULL template (including slide-level backgroundType,
        // imagePrompt, textLayout, branding). Without this, re-running the
        // image-generation agent from the draft ID later has no slide-level
        // info, so every slide becomes a Gemini photo with no text overlay.
        formatTemplate,
        focus_industry: focusIndustry || null,
      },
      format_template: `format-${formatTemplate.id}`,
      topic: pillar,
    })
    .select()
    .single();

  if (dbError) throw dbError;

  log.success(`Draft saved: ${draft.id}`);

  return {
    draft_id: draft.id,
    topic: pillar,
    format: formatTemplate.name,
    format_id: formatTemplate.id,
    slide_count: formatTemplate.slideCount,
    slides: result.slides.length,
    images: images.length,
    focus_industry: focusIndustry || null,
    duration_ms: Date.now() - startTime,
  };

  } finally {
    IN_FLIGHT_TOPICS.delete(myTopicKey);
  }
}

/**
 * Fallback format if tenant has no content_formats configured
 */
function getDefaultFormat() {
  return {
    id: 0,
    name: 'Default 5-Slide',
    slideCount: 5,
    slides: [
      { slideNumber: 1, role: 'hook', backgroundType: 'image', imagePrompt: 'Professional, clean background image. Dark tones.', textLayout: { headline: { position: 'center', color: 'white', font: 'bold serif', shadow: 'strong-black' } }, branding: {} },
      { slideNumber: 2, role: 'problem', backgroundType: 'solid', bgPalette: { base: '#F5F0EB', gradient: '#FAF7F4' }, textLayout: { headline: { position: 'center', color: '#2C1810', font: 'bold serif' }, body: { position: 'center', color: '#5A4A3F', font: 'regular sans' } }, branding: {} },
      { slideNumber: 3, role: 'insight', backgroundType: 'solid', bgPalette: { base: '#E8E2D9', gradient: '#F0EBE4' }, textLayout: { headline: { position: 'center', color: '#2C1810', font: 'bold serif' }, body: { position: 'center', color: '#5A4A3F', font: 'regular sans' } }, branding: {} },
      { slideNumber: 4, role: 'value', backgroundType: 'solid', bgPalette: { base: '#2E3B2F', gradient: '#3A4A3B' }, textLayout: { headline: { position: 'center', color: '#F5F0EB', font: 'bold serif' }, body: { position: 'center', color: '#D4CCC2', font: 'regular sans' } }, branding: {} },
      { slideNumber: 5, role: 'cta', backgroundType: 'image', imagePrompt: 'Warm, calming object scene. Dark tones for white text.', textLayout: { headline: { position: 'center', color: 'white', font: 'bold serif', shadow: 'strong-black' }, body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' } }, branding: {} },
    ],
    contentStructure: {
      type: 'narrative',
      slideInstructions: {
        hook: 'Bold, scroll-stopping headline ONLY (5-10 words). No body text.',
        problem: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
        insight: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
        value: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
        cta: 'Call to action headline + short body with website.',
      }
    }
  };
}

module.exports = run;
