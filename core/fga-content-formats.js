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
// The FGA logo asset is now a transparent PNG with pure-white pixels —
// Sharp.tint() recolors it cleanly to whatever the background needs.
//   - Midnight / photo / dark slides → tint:'white' (a no-op, keeps it white)
//   - Light Gray slides → tint with Midnight so it doesn't fight the bg
//   - Slides where a wordmark already brands the top → logo:null (no
//     second mark cluttering the corner)
const brandLogoBR = { wellmorBenefits: null, logo: { position: 'bottom-right', tint: C.midnight } };
const brandLogoBRWhite = { wellmorBenefits: null, logo: { position: 'bottom-right', tint: 'white' } };
// Top-center logo at 'normal' size (16% of canvas width = ~164px) leaves
// a clear band between the logo bottom and the upper-center headline at
// y=0.20. Was 'large' (25%) which collided directly with the headline on
// Format 7 + 8 hooks.
const brandLogoTC = { wellmorBenefits: null, logo: { position: 'top-center', size: 'normal', tint: 'white' } };
// brandFGATop renders the "FIRST GEN AUTOMATE" wordmark across the top.
// We drop the bottom-right logo so the slide has ONE clean brand mark
// instead of competing wordmark + logomark in two places. Cleaner on
// the Light Gray Quote Card; Patrick called the redundant logo "out
// of place" — this fixes it.
const brandFGATop = {
  wellmorBenefits: { position: 'top-center', color: C.midnight },
  logo: null,
};
const brandFGATopLight = {
  wellmorBenefits: { position: 'top-center', color: C.lightGray },
  logo: null,
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
          // The One-Liner headline is rendered HUGE (bold sans large)
          // — without a tight maxChars the wide glyphs of "M" / "W" /
          // "&" bleed off the canvas. 20 keeps a ~3-line headline
          // safely inside the safe zone at 63px font.
          maxChars: 20,
        },
        body: null,
      },
      branding: brandLogoBRWhite,
    },
  ],
  contentStructure: {
    type: 'single_statement',
    slideInstructions: {
      hook: 'A single sentence-case contrarian statement, 3-10 words. ONE core idea, no qualifier, no body text.',
    },
  },
};

// =========================================================================
// FORMAT 2 — THE FOUNDER NOTE (single image, editorial founder perspective)
// =========================================================================
const format2_quoteCard = {
  id: 2,
  name: 'The Founder Note',
  slideCount: 1,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'solid',
      bgPalette: { base: C.lightGray, gradient: C.white },
      textLayout: {
        // Restrained editorial marks frame the principle without presenting
        // model-written language as a direct founder quotation.
        decorations: [
          { type: 'corner-mark', color: C.signalGreen, position: 'top-right', size: 0.035, opacity: 0.85 },
        ],
        headline: {
          position: 'center',
          color: C.midnight,
          font: 'bold serif',
          shadow: 'none',
        },
        // Dropped the divider — the giant Signal Green quote marks
        // already structure the slide visually, and the divider was
        // landing on the same baseline as the attribution line, looking
        // like a strike-through through the name.
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
    type: 'founder_note',
    slideInstructions: {
      hook:
        'An approved founder principle as a sentence-case headline (3-10 words) + one supporting sentence (12 words maximum). Do not use quotation marks, a Patrick attribution, or an invented first-person anecdote.',
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
        // Tight Signal Green ring framing JUST the giant stat in the
        // upper-middle of the canvas. Explanation + citation sit BELOW
        // the ring (outside), giving the slide a clear focal hierarchy:
        // stat is the hero, words are supporting context.
        decorations: [
          { type: 'ring', color: C.signalGreen, cx: 0.50, cy: 0.34, radius: 0.24, strokeWidth: 0.012, opacity: 0.80 },
          { type: 'corner-mark', color: C.signalGreen, position: 'top-right', size: 0.035, opacity: 0.85 },
        ],
        // Headline IS the giant stat ("$38.2B", "78%", "$15,340"). Anchored
        // at customY=0.39 so the glyph visually centers inside the ring at
        // cy=0.34. fontSizeMultiplier 1.7x makes it the unambiguous focal
        // point of the slide.
        headline: {
          customY: 0.39,
          color: C.signalGreen,
          font: 'bold sans large',
          shadow: 'none',
          maxChars: 10,
          fontSizeMultiplier: 1.7,
        },
        // Plain-English explanation BELOW the ring. customY=0.66 puts it
        // clear of the ring's bottom arc (ring bottom = 0.34+0.24 = 0.58).
        subtitle: {
          customY: 0.66,
          color: 'white',
          font: 'regular sans',
          shadow: 'none',
          maxChars: 28,
        },
        // Source citation small-caps. customY pulled up from 0.86 → 0.80
        // so the wide line doesn't visually collide with the bottom-right
        // FGA logo (logo top sits around y=0.80). Also tightened maxChars
        // 42 → 32 so the citation wraps within the safe zone and never
        // touches the logo even when sources have long names.
        body: {
          customY: 0.80,
          color: C.slate,
          font: 'small caps',
          shadow: 'none',
          maxChars: 32,
        },
      },
      branding: brandLogoBRWhite,
    },
  ],
  contentStructure: {
    type: 'stat_card',
    slideInstructions: {
      hook:
        'A real cited statistic. Use these EXACT JSON field assignments — do not swap them:\n' +
        '  - "headline": the bare stat itself (2-7 chars, e.g. "78%", "$3K", "4.7★", "$38.2B")\n' +
        '  - "subtext": one-line plain-English explanation, 10-15 words, ends with a period\n' +
        '  - "body": the source citation, 5-10 words, e.g. "Invoca 2024 Home Services Call Study"\n' +
        'NEVER invent statistics. If you don\'t have a real source from the FACTS YOU MAY CITE block, return an error.',
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
      // Pillar 4 was reframed in Phase 11 from "Client Proof" to
      // "Industry Proof" — the slide dramatizes a real industry stat
      // from the FACTS YOU MAY CITE block as a before/after, NOT a
      // named-client outcome. The prior instructions said "use a real
      // client (A Kut Above)" which directly contradicted the global
      // "DO NOT name a client by name" rule, so Claude was returning
      // empty slides for every format-4 request.
      before:
        'Headline naming the BEFORE state — the small-business problem the industry-wide statistic describes (4-8 words). NO body text.\n' +
        'INDUSTRY-CORRECT NOUNS — use the term real owners use, NOT generic "shop":\n' +
        '  Plumbing → "shop" or "crew"; HVAC → "shop" or "company"; Electrical → "shop" or "crew";\n' +
        '  Landscaping & Tree Service → "crew", "team", or "company" (NEVER "shop");\n' +
        '  Roofing → "crew" or "company"; Cleaning Services → "service" or "team".\n' +
        'Describe the problem generically (e.g. "Every plumbing crew is leaking 62% of inbound calls"). NEVER name a specific client. NEVER invent a number — use only a statistic from the FACTS YOU MAY CITE block in the system prompt.',
      after:
        'Headline naming what changes (4-8 words) + one supporting sentence (16 words maximum). Cite the approved stat in the caption, not as a paragraph on the slide. Use industry-correct nouns. No client names or fabricated outcomes.',
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
      // 2026-05-26: enriched the flat warm-amber solid with SVG-only
      // decorations (no Gemini call, no failure risk):
      //   - radial gradient: warmer center → cooler amber edge for depth
      //   - vertical accent band on the left in deeper midnight for visual structure
      //   - small midnight corner mark top-right as a graphic anchor
      //   - subtle outlined ring behind text as negative-space anchor
      // 2026-05-27: moved headline down with customY 0.26 (was upper-center
      // at 0.20 which sat too close to the top edge — risk of IG crop
      // clipping the title). Body re-anchored at customY 0.50 to stay
      // visually centered inside the ring.
      backgroundType: 'solid',
      bgPalette: { base: C.warmAmber, gradient: '#D97706' }, // deeper amber edge
      textLayout: {
        decorations: [
          { type: 'accent-band', color: C.midnight, side: 'left', width: 0.018, height: 1.0, opacity: 0.85 },
          { type: 'corner-mark', color: C.midnight, position: 'top-right', size: 0.04, opacity: 0.90 },
          { type: 'ring', color: C.midnight, cx: 0.5, cy: 0.55, radius: 0.32, strokeWidth: 0.008, opacity: 0.12 },
        ],
        headline: {
          customY: 0.26,
          color: C.midnight,
          font: 'bold sans',
          shadow: 'none',
        },
        body: {
          customY: 0.50,
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
      // 2026-05-26: same treatment as slide 1 but on the midnight
      // "right way" panel, with signal-green accents instead of amber.
      // 2026-05-27: headline customY adjustment matches slide 1.
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: '#1A3A5C' }, // slightly lighter mid-blue edge
      textLayout: {
        decorations: [
          { type: 'accent-band', color: C.signalGreen, side: 'left', width: 0.018, height: 1.0, opacity: 0.95 },
          { type: 'corner-mark', color: C.signalGreen, position: 'top-right', size: 0.04, opacity: 0.95 },
          { type: 'ring', color: C.signalGreen, cx: 0.5, cy: 0.55, radius: 0.32, strokeWidth: 0.008, opacity: 0.18 },
        ],
        headline: {
          customY: 0.26,
          color: 'white',
          font: 'bold sans',
          shadow: 'none',
        },
        body: {
          customY: 0.50,
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
        'Name the bad pattern as a sentence-case headline (4-8 words). Add one concrete supporting sentence, 16 words maximum.',
      right:
        'Name the alternative as a sentence-case headline (4-8 words). Add one concrete supporting sentence, 16 words maximum.',
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
        'Sentence-case scene or observation (3-7 words). NO body or subtext. Specific beats sensational.',
      insight:
        'Headline (3-7 words) + ONE supporting sentence (8-16 words), OR 3 short structured visual_data.steps. Never a paragraph or full script.',
      cta:
        'Closing headline (3-7 words) + optional body of 10 words maximum. A CTA is optional. No keyword DM, fake quote, or repeated website.',
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
      context: 'Headline (4-8 words) + one sentence (16 words maximum) setting a concrete industry scene.',
      insight: 'Headline (4-8 words) + one sentence (16 words maximum) naming the pressure outsiders miss.',
      value: 'Headline (4-8 words) + one sentence (16 words maximum) showing the practical move.',
      cta: 'Closing headline (3-8 words) + optional body (10 words maximum). CTA optional; no keyword bait.',
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
      problem: 'Headline (4-8 words) + one sentence (16 words maximum) naming the manual task.',
      insight: 'Headline (4-8 words) + 3 short visual_data.steps showing the verified workflow. Body optional, 12 words maximum.',
      value: 'Headline (4-8 words) + one sentence (16 words maximum) showing the operational change.',
      cta: 'Closing headline (3-8 words) + optional body (10 words maximum). CTA optional; no keyword bait.',
    },
  },
};

// =========================================================================
// FORMAT 9 — MODULE SPOTLIGHT (5-slide, Problem → Module → Solution)
// =========================================================================
const format9_moduleSpotlight = {
  id: 9,
  name: 'Module Spotlight',
  slideCount: 5,
  slides: [
    {
      slideNumber: 1,
      role: 'hook',
      backgroundType: 'image',
      imagePrompt:
        `Documentary photograph of a small-business owner looking stressed or busy — hands on a phone that's ringing, a missed-call notification on screen, an overflowing inbox, a stack of unanswered messages. {INDUSTRY_SUBJECT}. DARK tone — must support white text overlay. Generous negative space in upper-center for headline. No identifiable faces. Editorial lighting.`,
      textLayout: {
        headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'strong-black' },
      },
      branding: brandLogoTC,
    },
    {
      slideNumber: 2,
      role: 'problem',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: '#1A3A5C' },
      textLayout: {
        headline: { position: 'upper-center', color: C.signalGreen, font: 'bold sans' },
        body: { position: 'center', color: C.lightGray, font: 'regular sans' },
      },
      branding: brandLogoBRWhite,
    },
    {
      slideNumber: 3,
      role: 'module',
      backgroundType: 'solid',
      bgPalette: { base: C.signalGreen, gradient: '#2ECC71' },
      textLayout: {
        headline: { position: 'upper-center', color: C.midnight, font: 'bold sans' },
        body: { position: 'center', color: C.midnight, font: 'regular sans' },
      },
      branding: brandLogoBR,
    },
    {
      slideNumber: 4,
      role: 'result',
      backgroundType: 'solid',
      bgPalette: { base: C.midnight, gradient: '#1A3A5C' },
      textLayout: {
        headline: { position: 'upper-center', color: 'white', font: 'bold sans' },
        body: { position: 'center', color: C.lightGray, font: 'regular sans' },
      },
      branding: brandLogoBRWhite,
    },
    {
      slideNumber: 5,
      role: 'cta',
      backgroundType: 'image',
      imagePrompt:
        `Documentary photograph — close on a small-business owner's hands using a phone, relaxed posture, warm light. The mood is "handled, under control." {INDUSTRY_SUBJECT}. DARK composition for white text. Negative space in upper-center. No identifiable faces, no text, no logos.`,
      textLayout: {
        headline: { position: 'center', color: 'white', font: 'bold sans', shadow: 'strong-black' },
        body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' },
        website: { position: 'bottom-center', color: C.signalGreen, shadow: 'black' },
      },
      branding: brandLogoBRWhite,
    },
  ],
  contentStructure: {
    type: 'module_spotlight',
    slideInstructions: {
      hook: 'Bold scroll-stopper naming the PROBLEM (5-10 words). Should make the reader feel seen. NO body text.',
      problem: 'Headline names the workaround (4-8 words) + one concrete sentence (16 words maximum).',
      module: 'Headline is the real FGA module name + one plain-English sentence (16 words maximum) explaining verified behavior.',
      result: 'Headline (4-8 words) + one sentence (16 words maximum) showing the day-to-day operational change.',
      cta: 'Closing headline (3-8 words) + optional body (10 words maximum). Website is rendered separately; CTA optional.',
    },
  },
};

// ---------------------------------------------------------------------------
// Export the 9 formats in rotation order
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
  format9_moduleSpotlight,
];

// 2026-05-26: live lookup so consumers can fetch the CURRENT format
// definition by id instead of relying on a snapshot saved into a
// draft's campaign_payload. Lets format changes (palettes, layouts,
// new backgroundTypes) apply on regeneration of older drafts.
function getFormatById(id) {
  const numId = parseInt(String(id || '').replace(/^format-/, ''), 10);
  if (!Number.isFinite(numId)) return null;
  return FGA_CONTENT_FORMATS.find(f => f.id === numId) || null;
}

module.exports = {
  FGA_CONTENT_FORMATS,
  getFormatById,
  INDUSTRY_IMAGE_SUBJECTS,
  INDUSTRY_SUBJECT_FALLBACK,
  INDUSTRY_TONE_HINTS,
  INDUSTRY_TONE_FALLBACK,
};
