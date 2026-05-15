/**
 * Growth OS — FGA Content Format Templates (v3 — Launch Edition)
 *
 * Eight visual formats covering FOUR distinct post types:
 *   • 3 single-image posts (Formats 1, 2, 3)
 *   • 2 short carousels (Formats 4, 5)
 *   • 1 mid carousel (Format 6)
 *   • 2 long carousels (Formats 7, 8)
 *
 * Each format is paired 1:1 with a content pillar via FORMAT_PILLAR_MAP in
 * core/fga-content-playbook.js. The pairing is rigid — the Monday/Thursday
 * rotation advances `content_format_index` in tenant_config, and the pillar
 * is derived from the format (not chosen randomly).
 *
 * All formats use ONLY the FGA brand palette in core/brand.js. No pastels.
 *
 * Photo slides use `{INDUSTRY_SUBJECT}` placeholder in their imagePrompt —
 * image-generation.js substitutes it at render time with the current week's
 * industry from INDUSTRY_IMAGE_SUBJECTS (below). This makes hero and CTA
 * imagery on weekly-rotated industries (HVAC week, Plumbing week, etc.)
 * actually industry-specific.
 *
 * INDUSTRY_TONE_HINTS adds a per-industry vocabulary tweak that
 * content-generation.js appends to the Claude prompt for the same purpose.
 */

const { FGA_BRAND } = require('./brand');

// FGA brand colors — single source of truth
const C = FGA_BRAND.colors;

// ---------------------------------------------------------------------------
// Branding blocks — reused across formats
// ---------------------------------------------------------------------------
const brandLogoBR = { wellmorBenefits: null, logo: { position: 'bottom-right' } };
const brandLogoBRWhite = { wellmorBenefits: null, logo: { position: 'bottom-right', tint: 'white' } };
const brandLogoTC = { wellmorBenefits: null, logo: { position: 'top-center', size: 'large' } };
const brandFGATop = {
  wellmorBenefits: { position: 'top-center', color: C.midnight },
  logo: { position: 'bottom-right' },
};
const brandFGATopLight = {
  wellmorBenefits: { position: 'top-center', color: C.lightGray },
  logo: { position: 'bottom-right' },
};

// ---------------------------------------------------------------------------
// Per-industry photo subjects (substituted into {INDUSTRY_SUBJECT})
// Keys MUST match strings in tenant_config.target_industries exactly.
// ---------------------------------------------------------------------------
const INDUSTRY_IMAGE_SUBJECTS = {
  'Plumbing':
    'Subject: Plumbing work — a wrench on a copper joint, a plumber under a sink with a flashlight, a service truck with pipe stock and PEX coils visible, a hand on a water shutoff valve. Working-class, dignified, NOT corporate.',
  'HVAC':
    'Subject: HVAC work — a tech installing a heat pump condenser, a manifold gauge on a service truck dashboard, a furnace tech reading a thermostat, a service van with HVAC branding. Industrial, precise, hands and tools.',
  'Electrical':
    'Subject: Electrical work — a journeyman in an open panel box with a multimeter, a hand stripping wire, an electrical service truck with reel gear, a breaker panel close-up. Safety-conscious, technical, NO arc/spark drama.',
  'Landscaping & Tree Service':
    'Subject: Tree service / landscaping work — a crew loading chainsaws into a truck at dawn, a chipper in action, a hand on a mower deck, a ground crew with safety helmets and chaps. Outdoor, physical, weather-aware.',
  'Roofing':
    'Subject: Roofing work — a roofer on a pitched roof with shingles, a nail gun close-up, a service truck with ladder rack, a foreman pointing up at a roof. High-stakes, safety harness visible, weather present.',
  'Cleaning Services':
    'Subject: Cleaning service work — a cleaner with a caddy entering a customer home, a microfiber cloth on a counter surface, a service van with branded magnets, a clipboard with a checklist. Detail-oriented, neat, customer-trust angle.',
};

// Fallback when industry isn't set or doesn't match a key
const INDUSTRY_SUBJECT_FALLBACK =
  'Subject: A small service-trade business — hands working, a service truck, a job-site tool laid out clean. Documentary, no faces. NOT corporate.';

// ---------------------------------------------------------------------------
// Per-industry tone hints (appended to Claude system prompt)
// ---------------------------------------------------------------------------
const INDUSTRY_TONE_HINTS = {
  'Plumbing':
    'Gritty, direct, no-nonsense. Tools and water imagery. Mention specific fittings or service calls ("kitchen sink shutoff," "water heater anode," "PEX vs copper").',
  'HVAC':
    'Technical-precise vocabulary. Name specific parts ("manifold gauge," "refrigerant," "condensate line," "EER rating") when relevant. Seasonal urgency (cooling crunch, heating crunch).',
  'Electrical':
    'Code-aware, safety-conscious. Reference panels, breakers, ground wires, AFCI/GFCI. "Per code" lands here in a way it doesn\'t elsewhere.',
  'Landscaping & Tree Service':
    'Physical, weather-aware. Reference season, equipment ("the chipper," "the stump grinder," "the climbing line"), crew size. Outdoor-job rhythm.',
  'Roofing':
    'High-stakes, weather-driven. Storm references, insurance claims, the brief working window after a hailstorm, the difference between 3-tab and architectural shingles.',
  'Cleaning Services':
    'Detail-oriented, trust-building. Reference recurring schedules, the "corners they check" mindset, customer comfort with you being in their space, deep clean vs maintenance.',
};

const INDUSTRY_TONE_FALLBACK =
  'Plain-spoken service-trade tone. Specific tools and tasks over abstract talk about "business."';

// ---------------------------------------------------------------------------
// Standard slide instructions for each post type
// (per-format slideInstructions are inline on each format below — these are
// shared baseline content rules)
// ---------------------------------------------------------------------------

// =========================================================================
// FORMAT 1 — THE ONE-LINER (single image, midnight bg, contrarian POV)
// =========================================================================
const format1_oneLiner = {
  id: 1,
  name: 'The One-Liner',
  slideCount: 1,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: C.midnight },
      textLayout: {
        headline: {
          position: 'center',
          color: 'white',
          font: 'bold sans large',
          shadow: 'none',
        },
        body: null,
      },
      branding: brandLogoBRWhite,
    },
  ],
  contentStructure: {
    type: 'single_statement',
    slideInstructions: {
      hook: 'A single bold contrarian statement. 15-25 words total. ONE core idea, no qualifier. Reader either nods or argues back — never shrugs. No body text.',
    },
  },
};

// =========================================================================
// FORMAT 2 — THE QUOTE CARD (single image, light gray bg + serif, founder voice)
// =========================================================================
const format2_quoteCard = {
  id: 2,
  name: 'The Quote Card',
  slideCount: 1,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'solid',
      bgPalette: { base: C.lightGray, gradient: C.white },
      textLayout: {
        // Giant decorative quote glyphs in Signal Green frame the quote.
        // No photo, no people — just a graphic anchor so the slide doesn't
        // feel like "just words on a background".
        decorations: [
          { type: 'quote-marks', color: C.signalGreen, opacity: 0.18, size: 0.32 },
          { type: 'corner-mark', color: C.signalGreen, position: 'top-right', size: 0.035, opacity: 0.85 },
        ],
        headline: {
          position: 'center',
          color: C.midnight,
          font: 'bold serif',
          shadow: 'none',
        },
        divider: { color: C.signalGreen, position: 'below-headline' }, // signal-green divider line
        subtitle: {
          position: 'center',
          color: C.slate,
          font: 'italic serif',
          shadow: 'none',
        },
      },
      branding: brandFGATop,
    },
  ],
  contentStructure: {
    type: 'founder_quote',
    slideInstructions: {
      hook:
        'A quotable founder-voice line (12-25 words) + a 5-10 word attribution/context line. Sounds like something a founder posts on LinkedIn after a long day — not a brand statement. First-person ("I…") or direct-address ("You think…") preferred.',
    },
  },
};

// =========================================================================
// FORMAT 3 — THE STAT CARD (single image, signal-green stat on midnight, industry data)
// =========================================================================
const format3_statCard = {
  id: 3,
  name: 'The Stat Card',
  slideCount: 1,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: C.midnight },
      textLayout: {
        // Signal Green ring frames the giant stat number — turns a
        // text-on-color slide into an infographic. Plus a small
        // corner accent mark for extra graphic anchor. No photos, no
        // people — pure brand-color shapes.
        decorations: [
          { type: 'ring', color: C.signalGreen, cx: 0.50, cy: 0.40, radius: 0.34, strokeWidth: 0.010, opacity: 0.55 },
          { type: 'corner-mark', color: C.signalGreen, position: 'top-right', size: 0.035, opacity: 0.85 },
        ],
        // bigStat is rendered larger than headline — image-generation.js
        // treats it like an oversized headline.
        bigStat: {
          position: 'upper-center',
          color: C.signalGreen,
          font: 'bold sans large',
          shadow: 'none',
        },
        headline: {
          position: 'center',
          color: 'white',
          font: 'regular sans',
          shadow: 'none',
        },
        subtitle: {
          position: 'bottom-center',
          color: C.slate,
          font: 'small caps',
          shadow: 'none',
        },
      },
      branding: brandLogoBRWhite,
    },
  ],
  contentStructure: {
    type: 'stat_card',
    slideInstructions: {
      hook:
        'A real cited statistic. Return THREE text fields: (1) the big stat itself as a 2-5 character string (e.g. "78%", "$3K", "4.7★"), (2) a 10-15 word one-line plain-English explanation, (3) a 5-10 word source citation. NEVER invent statistics. If you don\'t have a real source, return an error.',
    },
  },
};

// =========================================================================
// FORMAT 4 — BEFORE / AFTER (2 slides, photo + photo, client proof)
// =========================================================================
const format4_beforeAfter = {
  id: 4,
  name: 'Before / After',
  slideCount: 2,
  slides: [
    {
      slideNumber: 1,
      role: 'before',
      backgroundType: 'image',
      imagePrompt:
        `Documentary photograph of a "before" state. {INDUSTRY_SUBJECT}. The scene must visually convey a problem or missed opportunity — phone with missed calls, a cluttered workbench, a quiet waiting room, an empty appointment book. Moody natural light, slightly tense. No people's faces — hands, back of head, environment. Generous negative space upper-center for white headline text. DARK enough overall to support white text.`,
      textLayout: {
        headline: {
          position: 'upper-center',
          color: 'white',
          font: 'bold sans',
          shadow: 'strong-black',
        },
        body: null,
      },
      branding: brandLogoBR,
    },
    {
      slideNumber: 2,
      role: 'after',
      backgroundType: 'image',
      imagePrompt:
        `Documentary photograph of an "after" state — relief, transformation, momentum. {INDUSTRY_SUBJECT}. Same industry as previous slide but a different scene — a phone showing texts going out, a booked schedule, a clean workbench, a happy handshake (hands only). Warm golden-hour light. No faces. Generous negative space upper-center for headline + body text. DARK enough overall to support white text.`,
      textLayout: {
        headline: {
          position: 'upper-center',
          color: 'white',
          font: 'bold sans',
          shadow: 'strong-black',
        },
        body: {
          position: 'center',
          color: 'white',
          font: 'regular sans',
          shadow: 'black',
        },
      },
      branding: brandLogoBR,
    },
  ],
  contentStructure: {
    type: 'before_after',
    slideInstructions: {
      before:
        'Headline naming the before state (8-12 words). NO body text. Describe the problem in the headline alone. Use a real client (A Kut Above or WellMor Benefits) — never invent.',
      after:
        'Headline naming what changed (8-12 words) + body with the specific result (25-40 words). The body must include at least one real number tied to the named client.',
    },
  },
};

// =========================================================================
// FORMAT 5 — PATTERN / ANTI-PATTERN (2 slides, amber + midnight w/ green stripe)
// =========================================================================
const format5_patternAntiPattern = {
  id: 5,
  name: 'Pattern / Anti-Pattern',
  slideCount: 2,
  slides: [
    {
      slideNumber: 1,
      role: 'wrong',
      backgroundType: 'solid',
      // Warm Amber — FGA's "attention/needs review" color
      bgPalette: { base: C.warmAmber, gradient: C.warmAmber },
      textLayout: {
        headline: {
          position: 'upper-center',
          color: C.midnight,
          font: 'bold sans',
          shadow: 'none',
        },
        body: {
          position: 'center',
          color: C.midnight,
          font: 'regular sans',
          shadow: 'none',
        },
      },
      branding: brandFGATop,
    },
    {
      slideNumber: 2,
      role: 'right',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: C.midnight },
      // accentStripe: left-edge signal-green vertical band (rendered if supported,
      // otherwise the slide still reads correctly)
      accentStripe: { color: C.signalGreen, position: 'left-edge', width: 0.04 },
      textLayout: {
        headline: {
          position: 'upper-center',
          color: 'white',
          font: 'bold sans',
          shadow: 'none',
        },
        body: {
          position: 'center',
          color: C.lightGray,
          font: 'regular sans',
          shadow: 'none',
        },
      },
      branding: brandFGATopLight,
    },
  ],
  contentStructure: {
    type: 'pattern_antipattern',
    slideInstructions: {
      wrong:
        'Name the bad pattern as a headline (8-12 words). Body (25-40 words) describes the specific behavior concretely — not feelings. Show the cost in the body.',
      right:
        'Name the alternative as a headline (8-12 words). Body (25-40 words) describes what it looks like in practice. Include a specific scenario or script.',
    },
  },
};

// =========================================================================
// FORMAT 6 — THE THREE-BEAT (3 slides — photo hook, solid insight, photo cta)
// =========================================================================
const format6_threeBeat = {
  id: 6,
  name: 'The Three-Beat',
  slideCount: 3,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'image',
      imagePrompt:
        `Documentary photograph. {INDUSTRY_SUBJECT}. Warm golden-hour light. Real-world job-site scene. No faces. Generous negative space upper-center for white headline. DARK enough overall to support white text overlay.`,
      textLayout: {
        headline: {
          position: 'center',
          color: 'white',
          font: 'bold sans',
          shadow: 'strong-black',
        },
        body: null,
      },
      branding: brandLogoTC,
    },
    {
      slideNumber: 2,
      role: 'insight',
      backgroundType: 'solid',
      bgPalette: { base: C.lightGray, gradient: C.white },
      textLayout: {
        headline: {
          position: 'upper-center',
          color: C.midnight,
          font: 'bold sans',
          shadow: 'none',
        },
        body: {
          position: 'center',
          color: C.slate,
          font: 'regular sans',
          shadow: 'none',
        },
        bullets: null, // Phase 2 Feature 2 will enable this slot
      },
      branding: brandFGATop,
    },
    {
      slideNumber: 3,
      role: 'cta',
      backgroundType: 'image',
      imagePrompt:
        `Closing documentary photograph. {INDUSTRY_SUBJECT}. Same industry, calm + optimistic scene. Late-day warm light. No faces. DARK enough in the upper-center to support white headline + body text. Generous negative space.`,
      textLayout: {
        headline: {
          position: 'upper-center',
          color: 'white',
          font: 'bold sans',
          shadow: 'strong-black',
        },
        body: {
          position: 'center',
          color: 'white',
          font: 'regular sans',
          shadow: 'black',
        },
        website: {
          position: 'bottom-center',
          color: 'white',
          font: 'regular sans',
          shadow: 'black',
        },
      },
      branding: brandLogoBR,
    },
  ],
  contentStructure: {
    type: 'three_beat',
    slideInstructions: {
      hook:
        'Bold scroll-stopper headline (8-12 words). NO body text. Should signal "service business" specifically.',
      insight:
        'Headline (8-12 words) + meaty body (40-60 words — longer than other formats). Include a literal script, template, or step the reader can apply this week.',
      cta:
        'CTA headline (5-10 words) + short body (15-25 words). End with a specific CTA + website at the bottom.',
    },
  },
};

// =========================================================================
// FORMAT 7 — MIDNIGHT HERO (5 slides, industry spotlight)
// =========================================================================
const format7_midnightHero = {
  id: 7,
  name: 'Midnight Hero',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'image',
      imagePrompt:
        `Documentary photograph at dusk or dawn. {INDUSTRY_SUBJECT}. Moody deep-blue ambient light that matches FGA's Midnight brand (${C.midnight}). DARK overall. Generous negative space upper-center for white headline. No faces, no text. Cinematic but natural.`,
      textLayout: {
        headline: {
          position: 'center',
          color: 'white',
          font: 'bold sans',
          shadow: 'strong-black',
        },
        body: null,
      },
      branding: brandLogoTC,
    },
    {
      slideNumber: 2,
      role: 'context',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: C.midnight },
      textLayout: {
        headline: { position: 'upper-center', color: 'white', font: 'bold sans', shadow: 'none' },
        body: { position: 'center', color: C.lightGray, font: 'regular sans', shadow: 'none' },
      },
      branding: brandFGATopLight,
    },
    {
      slideNumber: 3,
      role: 'insight',
      backgroundType: 'solid',
      bgPalette: { base: C.lightGray, gradient: C.white },
      textLayout: {
        headline: { position: 'upper-center', color: C.midnight, font: 'bold sans', shadow: 'none' },
        body: { position: 'center', color: C.slate, font: 'regular sans', shadow: 'none' },
      },
      branding: brandFGATop,
    },
    {
      slideNumber: 4,
      role: 'value',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: C.midnight },
      textLayout: {
        headline: { position: 'upper-center', color: 'white', font: 'bold sans', shadow: 'none' },
        body: { position: 'center', color: C.lightGray, font: 'regular sans', shadow: 'none' },
      },
      branding: brandFGATopLight,
    },
    {
      slideNumber: 5,
      role: 'cta',
      backgroundType: 'image',
      imagePrompt:
        `Closing documentary photograph. {INDUSTRY_SUBJECT}. Late-day warm light mixing with blue tones. No faces. DARK enough in upper-center to support white headline. Generous negative space.`,
      textLayout: {
        headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'strong-black' },
        body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' },
        website: { position: 'bottom-center', color: 'white', shadow: 'black' },
      },
      branding: brandLogoBR,
    },
  ],
  contentStructure: {
    type: 'industry_spotlight',
    slideInstructions: {
      hook: 'Bold scroll-stopper headline (5-10 words). NO body. Should signal THIS WEEK\'S industry specifically — useless to anyone in a different trade.',
      context: 'Headline (8-12 words) + body (25-40 words). Set the scene: what\'s unique about this industry right now — season, regulation, customer behavior.',
      insight: 'Headline (8-12 words) + body (25-40 words). The hidden truth or pressure that defines this industry that outsiders miss.',
      value: 'Headline (8-12 words) + body (25-40 words). What winning looks like in this industry — the specific move that separates good shops from great ones.',
      cta: 'CTA headline (5-10 words) + body (15-25 words). End with a specific CTA + website.',
    },
  },
};

// =========================================================================
// FORMAT 8 — DOCUMENTARY (5 slides, behind the build)
// =========================================================================
const format8_documentary = {
  id: 8,
  name: 'Documentary',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'image',
      imagePrompt:
        `Documentary photograph of a small-business owner in their element. {INDUSTRY_SUBJECT}. Warm golden-hour light. Natural, grounded, real. NO faces visible — use hands, back of head, silhouette, environmental context. Generous negative space upper-center for headline text. Subject anchored in lower third.`,
      textLayout: {
        headline: { position: 'upper-center', color: 'white', font: 'bold sans', shadow: 'strong-black' },
        body: null,
      },
      branding: brandLogoTC,
    },
    {
      slideNumber: 2,
      role: 'problem',
      backgroundType: 'solid',
      bgPalette: { base: C.lightGray, gradient: C.white },
      textLayout: {
        headline: { position: 'center', color: C.midnight, font: 'bold sans', shadow: 'none' },
        body: { position: 'center', color: C.slate, font: 'regular sans', shadow: 'none' },
      },
      branding: brandFGATop,
    },
    {
      slideNumber: 3,
      role: 'insight',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: C.midnight },
      textLayout: {
        headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'none' },
        body: { position: 'center', color: C.lightGray, font: 'regular sans', shadow: 'none' },
      },
      branding: brandFGATopLight,
    },
    {
      slideNumber: 4,
      role: 'value',
      backgroundType: 'solid',
      bgPalette: { base: C.lightGray, gradient: C.white },
      textLayout: {
        headline: { position: 'center', color: C.midnight, font: 'bold sans', shadow: 'none' },
        body: { position: 'center', color: C.slate, font: 'regular sans', shadow: 'none' },
      },
      branding: brandFGATop,
    },
    {
      slideNumber: 5,
      role: 'cta',
      backgroundType: 'image',
      imagePrompt:
        `Closing documentary shot. {INDUSTRY_SUBJECT}. Calm, optimistic, grounded. DARK enough in the upper-center to support white headline text. No faces. Feels like "here's what's possible."`,
      textLayout: {
        headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'strong-black' },
        body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' },
        website: { position: 'bottom-center', color: 'white', shadow: 'black' },
      },
      branding: brandLogoBR,
    },
  ],
  contentStructure: {
    type: 'behind_the_build',
    slideInstructions: {
      hook: 'Bold scroll-stopper (5-10 words). NO body. Should name a specific FGA agent or workflow, not "automation" generically.',
      problem: 'Headline (8-12 words) + body (25-40 words). What the small-business owner is doing manually today that the agent will replace.',
      insight: 'Headline (8-12 words) + body (25-40 words). Walk through what the agent does. Name the steps. Show the timing.',
      value: 'Headline (8-12 words) + body (25-40 words). What changes for the owner — their morning, their week, their cash flow.',
      cta: 'CTA headline (5-10 words) + body (15-25 words). End with a specific CTA + website.',
    },
  },
};

// ---------------------------------------------------------------------------
// Export the 8 formats in rotation order
// ---------------------------------------------------------------------------
const FGA_CONTENT_FORMATS = [
  format1_oneLiner,
  format2_quoteCard,
  format3_statCard,
  format4_beforeAfter,
  format5_patternAntiPattern,
  format6_threeBeat,
  format7_midnightHero,
  format8_documentary,
];

module.exports = {
  FGA_CONTENT_FORMATS,
  INDUSTRY_IMAGE_SUBJECTS,
  INDUSTRY_SUBJECT_FALLBACK,
  INDUSTRY_TONE_HINTS,
  INDUSTRY_TONE_FALLBACK,
};
