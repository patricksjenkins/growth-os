/**
 * Growth OS — FGA Content Format Templates
 *
 * Six distinct visual formats for round-robin carousel rotation. Each Monday's
 * content generation advances `content_format_index` in tenant_config, so over
 * a 6-week cycle every format is used once before repeating.
 *
 * Style source of truth: core/brand.js + Desktop/FGA/docs/brand/brand-guide.md
 *
 * Colors (from marketing-site/src/index.css):
 *   - Midnight       #132A4A   primary brand
 *   - Signal Green   #22C55E   accent (CTAs only, never a whole slide)
 *   - Slate          #64748B   secondary text
 *   - Light Gray     #F1F5F9   soft background
 *   - Warm Amber     #F59E0B   attention
 *   - White          #FFFFFF
 *
 * Each template is 5 slides with roles:
 *   hook → problem → insight → value → cta
 * matching the narrative Claude is already trained to produce in content-generation.js.
 *
 * Format IDs and names (rotate in this order):
 *   1. Midnight Hero       — dark confident, photo + solid midnight
 *   2. Signal Green Breakthrough — growth-focused, light + green accent
 *   3. Numbered Tips       — typography-driven how-to (1, 2, 3...)
 *   4. Documentary         — full-bleed photos, minimal text
 *   5. Split Contrast      — before/after, comparison content
 *   6. Editorial Quote     — thought-leadership, large-type quotes
 */

// Common branding block — FGA name top-center, logo bottom-right on solid slides.
// We use the business_name tenant_config value (not "WELLMOR BENEFITS") via the
// image-generation agent's `branding.wellmorBenefits` path; that name is a
// legacy field key — don't rename it or we break the image renderer.
const brandTop = { wellmorBenefits: { position: 'top-center', color: '#132A4A' }, logo: { position: 'bottom-right' } };
const brandTopLight = { wellmorBenefits: { position: 'top-center', color: '#F1F5F9' }, logo: { position: 'bottom-right' } };
const brandTopSlate = { wellmorBenefits: { position: 'top-center', color: '#64748B' }, logo: { position: 'bottom-right' } };
const brandPhotoHook = { wellmorBenefits: null, logo: { position: 'top-center', size: 'large' } };
const brandPhotoCTA = { wellmorBenefits: null, logo: { position: 'bottom-right' } };

// Standard slide instructions — the narrative shape Claude already produces.
const NARRATIVE_INSTRUCTIONS = {
  type: 'narrative',
  slideInstructions: {
    hook: 'Bold, scroll-stopping headline ONLY (5-10 words). No body text.',
    problem: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
    insight: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
    value: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
    cta: 'Call to action headline + short body with website URL.',
  },
};

// ---------------------------------------------------------------------------
// FORMAT 1 — Midnight Hero
//   Dark, confident. Hook + CTA are documentary photos (dashboard, truck,
//   hands) with white text. Body slides are solid midnight (#132A4A) with
//   white text — the site's hero-section aesthetic translated to slides.
// ---------------------------------------------------------------------------
const midnightHero = {
  id: 1,
  name: 'Midnight Hero',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1, role: 'hook', backgroundType: 'image',
      imagePrompt: `Documentary photograph of a small-business job site at dusk or dawn. Subjects: a contractor's truck dashboard with a phone, work gloves, a thermos; or a craftsman's workbench with clean tools; or a local shop-front at blue hour. Moody deep-blue ambient light that matches FGA's Midnight brand (#132A4A). Overall DARK tone — the image must support white text overlay. Generous negative space in the upper-center for the headline. No people's faces, no text. Premium editorial lighting, natural but cinematic.`,
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'strong-black' }, body: null },
      branding: brandPhotoHook,
    },
    {
      slideNumber: 2, role: 'problem', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#1D3A5F' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#CBD5E1', font: 'regular sans', shadow: 'none' } },
      branding: brandTopLight,
    },
    {
      slideNumber: 3, role: 'insight', backgroundType: 'solid',
      bgPalette: { base: '#F1F5F9', gradient: '#FFFFFF' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#64748B', font: 'regular sans', shadow: 'none' } },
      branding: brandTop,
    },
    {
      slideNumber: 4, role: 'value', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#0F2040' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#CBD5E1', font: 'regular sans', shadow: 'none' } },
      branding: brandTopLight,
    },
    {
      slideNumber: 5, role: 'cta', backgroundType: 'image',
      imagePrompt: `Documentary photograph — close on a contractor's hands on a phone screen (no face visible), at a job site or in a truck cab. Late-day warm light mixing with blue tones. Background blurred. DARK composition overall to support white text. Feels like someone just got a text and is responding. Negative space in upper-center for a headline. No text, no logos, no identifiable faces.`,
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'strong-black' }, body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' }, website: { position: 'bottom-center', color: 'white', shadow: 'black' } },
      branding: brandPhotoCTA,
    },
  ],
  contentStructure: NARRATIVE_INSTRUCTIONS,
};

// ---------------------------------------------------------------------------
// FORMAT 2 — Signal Green Breakthrough
//   Growth-focused. Alternates light backgrounds with a single signal-green
//   value slide. Best for transformation stories: "This is what changed".
// ---------------------------------------------------------------------------
const signalGreenBreakthrough = {
  id: 2,
  name: 'Signal Green Breakthrough',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1, role: 'hook', backgroundType: 'solid',
      bgPalette: { base: '#F1F5F9', gradient: '#FFFFFF' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold sans', shadow: 'none' }, body: null },
      branding: brandTop,
    },
    {
      slideNumber: 2, role: 'problem', backgroundType: 'solid',
      bgPalette: { base: '#FFFFFF', gradient: '#F8FAFC' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#475569', font: 'regular sans', shadow: 'none' } },
      branding: brandTopSlate,
    },
    {
      slideNumber: 3, role: 'insight', backgroundType: 'solid',
      bgPalette: { base: '#F1F5F9', gradient: '#E2E8F0' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#475569', font: 'regular sans', shadow: 'none' } },
      branding: brandTopSlate,
    },
    {
      slideNumber: 4, role: 'value', backgroundType: 'solid',
      // Signal green used ONLY on the value slide — the brand guide says green
      // should pop, not be everywhere. This is the "breakthrough" beat.
      bgPalette: { base: '#22C55E', gradient: '#16A34A' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#F0FDF4', font: 'regular sans', shadow: 'none' } },
      branding: { wellmorBenefits: { position: 'top-center', color: '#F0FDF4' }, logo: { position: 'bottom-right' } },
    },
    {
      slideNumber: 5, role: 'cta', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#0F2040' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#CBD5E1', font: 'regular sans', shadow: 'none' }, website: { position: 'bottom-center', color: '#22C55E', shadow: 'none' } },
      branding: brandTopLight,
    },
  ],
  contentStructure: NARRATIVE_INSTRUCTIONS,
};

// ---------------------------------------------------------------------------
// FORMAT 3 — Numbered Tips
//   Typography-driven how-to: "3 things small shops get wrong about…".
//   Large numbers, Inter-style sans. Minimal imagery. Clean and scannable.
//   Hook is a solid slide with big type; body slides show numbers prominently.
// ---------------------------------------------------------------------------
const numberedTips = {
  id: 3,
  name: 'Numbered Tips',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1, role: 'hook', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#1D3A5F' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans large', shadow: 'none' }, body: null },
      branding: brandTopLight,
    },
    {
      slideNumber: 2, role: 'problem', backgroundType: 'solid',
      bgPalette: { base: '#FFFFFF', gradient: '#F8FAFC' },
      textLayout: {
        headline: { position: 'upper-left', color: '#132A4A', font: 'bold sans', shadow: 'none' },
        body: { position: 'center-left', color: '#64748B', font: 'regular sans', shadow: 'none' },
      },
      branding: brandTop,
    },
    {
      slideNumber: 3, role: 'insight', backgroundType: 'solid',
      bgPalette: { base: '#F1F5F9', gradient: '#FFFFFF' },
      textLayout: {
        headline: { position: 'upper-left', color: '#132A4A', font: 'bold sans', shadow: 'none' },
        body: { position: 'center-left', color: '#64748B', font: 'regular sans', shadow: 'none' },
      },
      branding: brandTop,
    },
    {
      slideNumber: 4, role: 'value', backgroundType: 'solid',
      bgPalette: { base: '#FFFFFF', gradient: '#F8FAFC' },
      textLayout: {
        headline: { position: 'upper-left', color: '#132A4A', font: 'bold sans', shadow: 'none' },
        body: { position: 'center-left', color: '#64748B', font: 'regular sans', shadow: 'none' },
      },
      branding: brandTop,
    },
    {
      slideNumber: 5, role: 'cta', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#0F2040' },
      textLayout: {
        headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' },
        body: { position: 'center', color: '#CBD5E1', font: 'regular sans', shadow: 'none' },
        website: { position: 'bottom-center', color: '#22C55E', shadow: 'none' },
      },
      branding: brandTopLight,
    },
  ],
  contentStructure: NARRATIVE_INSTRUCTIONS,
};

// ---------------------------------------------------------------------------
// FORMAT 4 — Documentary (photo hook + CTA only, warm-earth body slides)
//   "Day in the life" storytelling — warm, grounded, human. Photos bookend
//   the carousel for emotional pull; middle slides are warm solid earth
//   tones so the format still FEELS documentary without burning Gemini API
//   calls on every slide. Only 2 images per post instead of 4.
// ---------------------------------------------------------------------------
const documentary = {
  id: 4,
  name: 'Documentary',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1, role: 'hook', backgroundType: 'image',
      imagePrompt: `Wide documentary photograph of a small-business owner in their element — a tree-service crew loading gear onto a truck at dawn, a plumber walking into a customer's house with a tool bag, a landscaper starting up a mower, a contractor in the driver's seat of a pickup. Warm golden-hour light. Natural, grounded, real. NO faces visible — use hands, back of head, silhouette, or environmental context. Generous negative space in upper-center for headline text. Subject anchored in lower third. Feels like a Kinfolk editorial. Brand colors compatible (deep blues, warm earth tones).`,
      textLayout: { headline: { position: 'upper-center', color: 'white', font: 'bold sans', shadow: 'strong-black' }, body: null },
      branding: brandPhotoHook,
    },
    {
      slideNumber: 2, role: 'problem', backgroundType: 'solid',
      // Warm cream — documentary-mag aesthetic without a photo
      bgPalette: { base: '#FAF5EC', gradient: '#F5EDE0' },
      textLayout: { headline: { position: 'center', color: '#2C1810', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#5A4A3F', font: 'regular sans', shadow: 'none' } },
      branding: { wellmorBenefits: { position: 'top-center', color: '#8B7D6B' }, logo: { position: 'bottom-right' } },
    },
    {
      slideNumber: 3, role: 'insight', backgroundType: 'solid',
      bgPalette: { base: '#FFFFFF', gradient: '#F8FAFC' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#475569', font: 'regular sans', shadow: 'none' } },
      branding: brandTop,
    },
    {
      slideNumber: 4, role: 'value', backgroundType: 'solid',
      // Deep forest green — warm, grounded, signals transformation
      bgPalette: { base: '#2E3B2F', gradient: '#3A4A3B' },
      textLayout: { headline: { position: 'center', color: '#F5F0EB', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#D4CCC2', font: 'regular sans', shadow: 'none' } },
      branding: { wellmorBenefits: { position: 'top-center', color: '#8B9A7B' }, logo: { position: 'bottom-right' } },
    },
    {
      slideNumber: 5, role: 'cta', backgroundType: 'image',
      imagePrompt: `Closing documentary shot — open road from a contractor's truck at sunset, or a well-lit storefront at dusk, or a craftsman's workshop with afternoon light streaming in. Calm, optimistic, grounded. DARK enough in the upper-center to support white headline text. No people's faces. Feels like "here's what's possible".`,
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'strong-black' }, body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' }, website: { position: 'bottom-center', color: 'white', shadow: 'black' } },
      branding: brandPhotoCTA,
    },
  ],
  contentStructure: NARRATIVE_INSTRUCTIONS,
};

// ---------------------------------------------------------------------------
// FORMAT 5 — Split Contrast
//   Before / After, Problem / Solution. Each body slide uses top-half and
//   bottom-half split in the text layout — visually echoes "what you have
//   vs. what's possible". Solid backgrounds, type-driven.
// ---------------------------------------------------------------------------
const splitContrast = {
  id: 5,
  name: 'Split Contrast',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1, role: 'hook', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#0F2040' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' }, body: null },
      branding: brandTopLight,
    },
    {
      slideNumber: 2, role: 'problem', backgroundType: 'solid',
      // Warm amber muted — "attention, here's what's broken"
      bgPalette: { base: '#FEF3C7', gradient: '#FDE68A' },
      textLayout: { headline: { position: 'upper-center', color: '#132A4A', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#64748B', font: 'regular sans', shadow: 'none' } },
      branding: brandTop,
    },
    {
      slideNumber: 3, role: 'insight', backgroundType: 'solid',
      // Transition — neutral, the "but here's why"
      bgPalette: { base: '#F1F5F9', gradient: '#E2E8F0' },
      textLayout: { headline: { position: 'upper-center', color: '#132A4A', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#475569', font: 'regular sans', shadow: 'none' } },
      branding: brandTop,
    },
    {
      slideNumber: 4, role: 'value', backgroundType: 'solid',
      // Signal green muted — "and here's the unlock"
      bgPalette: { base: '#DCFCE7', gradient: '#BBF7D0' },
      textLayout: { headline: { position: 'upper-center', color: '#14532D', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#166534', font: 'regular sans', shadow: 'none' } },
      branding: { wellmorBenefits: { position: 'top-center', color: '#166534' }, logo: { position: 'bottom-right' } },
    },
    {
      slideNumber: 5, role: 'cta', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#0F2040' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' }, body: { position: 'center', color: '#CBD5E1', font: 'regular sans', shadow: 'none' }, website: { position: 'bottom-center', color: '#22C55E', shadow: 'none' } },
      branding: brandTopLight,
    },
  ],
  contentStructure: NARRATIVE_INSTRUCTIONS,
};

// ---------------------------------------------------------------------------
// FORMAT 6 — Editorial Quote
//   Thought-leadership. Minimal, typography-forward. Large serif quotes on
//   clean white backgrounds. For founder-voice content ("It's not software.
//   It's a system.").
// ---------------------------------------------------------------------------
const editorialQuote = {
  id: 6,
  name: 'Editorial Quote',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1, role: 'hook', backgroundType: 'solid',
      bgPalette: { base: '#FFFFFF', gradient: '#F8FAFC' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold serif', shadow: 'none' }, body: null },
      branding: brandTop,
    },
    {
      slideNumber: 2, role: 'problem', backgroundType: 'solid',
      bgPalette: { base: '#F1F5F9', gradient: '#FFFFFF' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#475569', font: 'regular serif italic', shadow: 'none' } },
      branding: brandTop,
    },
    {
      slideNumber: 3, role: 'insight', backgroundType: 'solid',
      bgPalette: { base: '#FFFFFF', gradient: '#F8FAFC' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#475569', font: 'regular serif italic', shadow: 'none' } },
      branding: brandTop,
    },
    {
      slideNumber: 4, role: 'value', backgroundType: 'solid',
      bgPalette: { base: '#F1F5F9', gradient: '#FFFFFF' },
      textLayout: { headline: { position: 'center', color: '#132A4A', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#475569', font: 'regular serif italic', shadow: 'none' } },
      branding: brandTop,
    },
    {
      slideNumber: 5, role: 'cta', backgroundType: 'solid',
      bgPalette: { base: '#132A4A', gradient: '#0F2040' },
      textLayout: { headline: { position: 'center', color: 'white', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#CBD5E1', font: 'regular sans', shadow: 'none' }, website: { position: 'bottom-center', color: '#22C55E', shadow: 'none' } },
      branding: brandTopLight,
    },
  ],
  contentStructure: NARRATIVE_INSTRUCTIONS,
};

const FGA_CONTENT_FORMATS = [
  midnightHero,
  signalGreenBreakthrough,
  numberedTips,
  documentary,
  splitContrast,
  editorialQuote,
];

module.exports = { FGA_CONTENT_FORMATS };
