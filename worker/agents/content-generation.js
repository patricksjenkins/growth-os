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
      .select('topic, headline, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(n);
    return data || [];
  } catch {
    return [];
  }
}

/**
 * Build the system prompt using tenant config
 */
function buildSystemPrompt(tenant, recentHistory = [], focusIndustry = null) {
  const businessName = getConfig(tenant, 'business_name', 'Our Company');
  const brandVoice = getConfig(tenant, 'brand_voice', 'Professional and helpful.');
  const website = getConfig(tenant, 'website', '');

  const historyBlock = recentHistory.length
    ? `\nRECENT POSTS (do NOT repeat the topic, headline structure, or angle of any of these):\n${recentHistory
        .map((d, i) => `  ${i + 1}. Topic: "${(d.topic || '').slice(0, 120)}"\n     Headline: "${d.headline || ''}"`)
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
${industryBlock}${historyBlock}
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

  // Build prompts
  const systemPrompt = buildSystemPrompt(tenant, recentHistory, focusIndustry);
  const { slideLines, slideCount, contentType } = buildSlideInstructions(formatTemplate);
  const jsonShape = buildJsonShape(formatTemplate, pillar);

  const voiceModifier = formatTemplate.contentStructure?.voiceModifier || '';
  const fullSystemPrompt = systemPrompt + (voiceModifier ? `\n\nADDITIONAL VOICE DIRECTION:\n${voiceModifier}` : '');

  // Shared specificity / banned-phrase rules — appended to both prompt modes.
  const sharedQualityRules = `
SPECIFICITY (REQUIRED):
- The post MUST include at least ONE: real cited statistic, real client name
  (A Kut Above or WellMor Benefits — never invent), specific scenario with
  time/place, or literal script/template.
- The hook headline must signal "service business" specifically, not be
  generic enough to apply to any business.
- Caption: 2-3 sentences, conversational. End with ONE specific CTA — not a
  generic site visit. Acceptable: "DM me 'system'", "Comment 'script' for the
  template", "Visit the link in bio". Vary the CTA between posts.

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
- Sentences starting with "Stop" or "Start" as a one-word imperative.

HEADLINE PATTERNS (avoid repeating):
- Do NOT use the "[Statement]. [Echo statement]." pattern more than once in
  this single post. Reading the recent-posts list above, also avoid headline
  structures any of those used.
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
