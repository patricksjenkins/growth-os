/**
 * FORMAT TEMPLATES — 8 distinct visual formats for round-robin carousel rotation.
 *
 * Post 1 = Format 1, Post 2 = Format 2, ... Post 8 = Format 8, Post 9 = Format 1 (wraps).
 *
 * Each template defines:
 * - Slide count and structure
 * - Color palette and text colors
 * - Visual/photography direction per slide
 * - Text layout and positioning
 * - Branding rules (WELLMOR BENEFITS placement, logo placement)
 * - Content structure type for Claude copywriting
 */

const FORMAT_TEMPLATES = [

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 1 — Warm Earth Editorial (5 slides)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 1,
    name: 'Warm Earth Editorial',
    slideCount: 5,

    // --- SLIDES DEFINITION ---
    slides: [
      {
        slideNumber: 1,
        role: 'hook',
        backgroundType: 'image',
        imagePrompt: `Dark, moody architectural interior scene with premium natural materials.
Materials: dark marble, green stone, warm wood, linen curtain, concrete floor.
Architectural elements: arched wall or doorway, clean surfaces. Include a tree or plant.
Colors: deep browns, dark greens, charcoal, warm amber accents.
Overall DARK tone — this image needs to support white text overlay.
CRITICAL: Leave BIG open space in the CENTER of the image for headline text.
Style: luxury boutique hotel lobby, art gallery, premium wellness space.
Moody editorial lighting with warm highlights.
No text, no people.`,
        textLayout: {
          headline: { position: 'center', color: 'white', font: 'bold serif', shadow: 'strong-black' },
          body: null,
        },
        branding: {
          wellmorBenefits: null,
          logo: { position: 'top-center', size: 'large' },
        },
      },
      {
        slideNumber: 2,
        role: 'problem',
        backgroundType: 'solid',
        bgPalette: { base: '#F5F0EB', gradient: '#FAF7F4' },
        textLayout: {
          headline: { position: 'center', color: '#2C1810', font: 'bold serif', shadow: 'none' },
          body: { position: 'center', color: '#5A4A3F', font: 'regular sans', shadow: 'none' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: '#8B7D6B' },
          logo: { position: 'bottom-right' },
        },
      },
      {
        slideNumber: 3,
        role: 'insight',
        backgroundType: 'solid',
        bgPalette: { base: '#E8E2D9', gradient: '#F0EBE4' },
        textLayout: {
          headline: { position: 'center', color: '#2C1810', font: 'bold serif', shadow: 'none' },
          body: { position: 'center', color: '#5A4A3F', font: 'regular sans', shadow: 'none' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: '#8B7D6B' },
          logo: { position: 'bottom-right' },
        },
      },
      {
        slideNumber: 4,
        role: 'value',
        backgroundType: 'solid',
        bgPalette: { base: '#2E3B2F', gradient: '#3A4A3B' },
        textLayout: {
          headline: { position: 'center', color: '#F5F0EB', font: 'bold serif', shadow: 'none' },
          body: { position: 'center', color: '#D4CCC2', font: 'regular sans', shadow: 'none' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: '#8B9A7B' },
          logo: { position: 'bottom-right' },
        },
      },
      {
        slideNumber: 5,
        role: 'cta',
        backgroundType: 'image',
        imagePrompt: `Warm, moody, object-focused scene. Dark overall tone.
Single calming object: lit candle in clay holder, warm tea in ceramic cup, smooth stones,
or soft fabric draped on a natural surface.
Warm golden/amber lighting. Dark but warm background.
MUST be darker overall to support white text.
Generous negative space in the center/upper area for text.
No people, no text.`,
        textLayout: {
          headline: { position: 'center', color: 'white', font: 'bold serif', shadow: 'strong-black' },
          body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' },
          website: { position: 'bottom-center', color: 'white', shadow: 'black' },
        },
        branding: {
          wellmorBenefits: null,
          logo: { position: 'bottom-right' },
        },
      },
    ],

    contentStructure: {
      type: 'narrative',
      slideInstructions: {
        hook: 'Bold, scroll-stopping headline ONLY (5-10 words). No body text.',
        problem: 'Headline (6-10 words) + body paragraph (20-35 words MAX). Keep body concise — it must fit on an Instagram slide.',
        insight: 'Headline (6-10 words) + body paragraph (20-35 words MAX). Keep body concise — it must fit on an Instagram slide.',
        value: 'Headline (6-10 words) + body paragraph (20-35 words MAX). Keep body concise — it must fit on an Instagram slide.',
        cta: 'Soft closing headline (5-8 words) + warm body (12-20 words MAX, include wellmorbenefits.com).',
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 2 — Sage Green Nature (3 slides)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 2,
    name: 'Sage Green Nature',
    slideCount: 3,

    slides: [
      {
        slideNumber: 1,
        role: 'hook',
        imagePrompt: `Split composition: LEFT side is solid sage/olive green color fill.
RIGHT side: large circular photo cutout showing nature imagery — ferns, delicate leaves,
soft green plants, botanical close-up. The circle should take up roughly 40% of the image
and be positioned on the right side.
Clean, minimal, premium feel. Instagram-native.
No text, no people.`,
        textLayout: {
          headline: { position: 'left-center', color: 'white', font: 'bold serif', shadow: 'none' },
          body: null,
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: 'black' },
          logo: { position: 'bottom-right' },
        },
      },
      {
        slideNumber: 2,
        role: 'content',
        imagePrompt: `Clean cream/off-white background. Minimal and editorial.
Small stacked geometric shapes in the center — half-circles or semi-circles with nature/texture
photos composited inside them (forest, earth, water, stone). These are decorative, small,
centered vertically. Think: stacked pebble shapes with photo fills.
Generous space above and below the shapes for text.
No people, no text.`,
        textLayout: {
          sectionLabel: { position: 'top-center', color: '#6B7B3A', font: 'small caps' },
          headline: { position: 'upper-center', color: '#2C1810', font: 'elegant serif', shadow: 'none' },
          sectionLabel2: { position: 'lower-center', color: '#6B7B3A', font: 'small caps' },
          body: { position: 'lower-center', color: '#5A5A5A', font: 'regular sans', shadow: 'none' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: 'black' },
          logo: { position: 'bottom-right' },
        },
      },
      {
        slideNumber: 3,
        role: 'cta',
        imagePrompt: `Full background nature photograph: dense trees, misty forest, lush green foliage.
Moody, atmospheric, slightly desaturated greens. Think: Pacific Northwest forest or
misty mountain woodland.
CRITICAL: The CENTER of the image must be relatively uniform (no strong focal point)
because a large white shape will be overlaid in the center.
No text, no people.`,
        textLayout: {
          // Rotating shapes: circle, square (rounded corners), hexagon
          centerShape: { type: 'rotate', options: ['circle', 'rounded-square', 'hexagon'], fill: 'white', border: true },
          headline: { position: 'inside-shape', color: '#2C1810', font: 'elegant serif' },
          website: { position: 'bottom-center', color: 'black', shadow: 'white' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: 'black' },
          logo: { position: 'bottom-right' },
        },
      },
    ],

    contentStructure: {
      type: 'vision_mission',
      slideInstructions: {
        hook: 'Bold hook headline (5-10 words). No body text.',
        content: 'Two sections: a vision statement (headline, 8-12 words) and a mission statement (body paragraph, 30-50 words). Editorial, warm, purposeful.',
        cta: 'Soft CTA headline inside shape (5-10 words). Website at bottom.',
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 3 — Photo-Ring Circle (1 slide)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 3,
    name: 'Photo-Ring Circle',
    slideCount: 1,

    slides: [
      {
        slideNumber: 1,
        role: 'hook',
        imagePrompt: `Clean cream/off-white background with a LARGE circle in the center of the image.
The circle is a RING (border) made up of segmented photographs — like a pie chart where each
segment is a different photo. 6-8 segments showing: nature landscapes, flowers, ocean waves,
green forest canopy, sandy beach, mountain sunset, botanical close-up.
ROTATE the photos across posts.
The CENTER of the ring is empty/cream — this is where text will go.
The ring should take up about 70% of the image.
Premium, editorial, wellness brand aesthetic.
No text.`,
        textLayout: {
          headline: { position: 'inside-ring-center', color: '#2C1810', font: 'bold serif', maxLines: 4 },
          body: null,
        },
        branding: {
          wellmorBenefits: null, // no header
          logo: { position: 'bottom-right' },
        },
      },
    ],

    contentStructure: {
      type: 'single_statement',
      slideInstructions: {
        hook: 'Bold, punchy headline statement. 4 lines maximum (15-25 words total). No body text. This is a single powerful message.',
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 4 — Numbered Tips Pinwheel (Dynamic: 5-6 slides)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 4,
    name: 'Numbered Tips Pinwheel',
    slideCount: 'dynamic', // determined by content (4-6 slides total)

    slides: [
      {
        slideNumber: 1,
        role: 'overview',
        imagePrompt: `Warm beige/cream background. Centered pinwheel/petal circle graphic.
The pinwheel has 4-5 petal/segment shapes arranged in a circle, each a different muted earth tone:
white, light blue, sage green, mauve/lavender, tan/camel, warm brown.
Each segment should have space for a number (01-05) and a one-word label.
Center circle: cream/beige, space for a number and title text.
Premium, clean, editorial infographic style — NOT corporate, NOT clipart.
Think: wellness brand meets premium magazine.
No text rendered in image.`,
        textLayout: {
          centerNumber: { position: 'center-circle', color: '#5A4A3A', font: 'large elegant' },
          centerTitle: { position: 'center-circle-below', color: '#5A4A3A', font: 'caps spaced' },
          segmentLabels: { color: '#5A4A3A', font: 'small elegant' },
        },
        branding: {
          wellmorBenefits: { position: 'bottom-center', color: 'black' },
          logo: null, // no logo on slide 1
        },
      },
      {
        slideNumber: 2,
        role: 'tip',
        imagePrompt: `Editorial collage layout with 2-3 rectangular color blocks in warm tones (cream, beige, blush, mauve).
Include 1-2 rectangular photo cutouts showing: coral, cream/white organic elements, seashells,
white stones, dried flowers, cotton, ceramic textures. NO PEOPLE on this slide.
Small decorative circle connector element.
Space for large headline word upper-left and body text.
Slide number "01" large and light in bottom-left.
Premium editorial collage style.`,
        textLayout: {
          headline: { position: 'upper-left', color: '#5A4A3A', font: 'large caps serif' },
          body: { position: 'below-headline-left', color: '#6B6B6B', font: 'regular serif' },
          slideNumber: { position: 'bottom-left', color: '#D4C8BC', font: 'large light' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
      {
        slideNumber: 3,
        role: 'tip',
        imagePrompt: `Editorial collage layout with 2-3 rectangular color blocks in warm tones.
Include 1-2 rectangular photo cutouts showing: nature textures, abstract organic forms,
botanical close-ups, textured fabrics, or a person seen from behind (cropped, no face).
ALTERNATE photo position from previous slide — if slide 2 had photos lower-right,
this slide should have photos lower-LEFT.
Small decorative circle connector element.
Slide number "02" large and light in bottom-right.`,
        textLayout: {
          headline: { position: 'upper-right', color: '#5A4A3A', font: 'large caps serif' },
          body: { position: 'below-headline-right', color: '#6B6B6B', font: 'regular serif' },
          slideNumber: { position: 'bottom-right', color: '#D4C8BC', font: 'large light' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
      {
        slideNumber: 4,
        role: 'tip',
        imagePrompt: `Editorial collage layout — alternate position from previous slide.
Color blocks in warm tones. Photo cutouts: abstract textures, nature, editorial lifestyle
(person from behind OK, rotate ethnicities, no face).
Slide number "03" large and light.
Decorative circle connector.`,
        textLayout: {
          headline: { position: 'lower-right', color: '#5A4A3A', font: 'large caps serif' },
          body: { position: 'below-headline-right', color: '#6B6B6B', font: 'regular serif' },
          slideNumber: { position: 'upper-left', color: '#D4C8BC', font: 'large light' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
      // Additional tip slides generated dynamically...
      {
        slideNumber: -1, // placeholder: always the LAST slide
        role: 'tip_final',
        imagePrompt: `Editorial collage layout — final tip. Alternate position from previous slide.
Warm color blocks and photo cutouts. Last slide number.
Decorative circle connector.`,
        textLayout: {
          headline: { position: 'upper-left', color: '#5A4A3A', font: 'large caps serif' },
          body: { position: 'below-headline-left', color: '#6B6B6B', font: 'regular serif' },
          slideNumber: { position: 'bottom-left', color: '#D4C8BC', font: 'large light' },
        },
        branding: {
          wellmorBenefits: null,
          logo: { position: 'bottom-right' }, // logo ONLY on last slide
        },
      },
    ],

    contentStructure: {
      type: 'numbered_tips',
      slideInstructions: {
        overview: 'A number (3-5) + topic title (2-4 words). Example: "5 RETENTION STRATEGIES" or "4 BENEFITS MISTAKES".',
        tip: 'One-word headline in ALL CAPS + body paragraph (20-40 words) explaining that tip.',
        tip_final: 'Same as tip — this is the last numbered item.',
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 5 — Hands & Nature Bullets (2+ slides)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 5,
    name: 'Hands & Nature Bullets',
    slideCount: 2,

    slides: [
      {
        slideNumber: 1,
        role: 'hook',
        imagePrompt: `Close-up of human hands and arms in a gentle, open pose — palms up, relaxed, receiving.
Portrait-mode style: shallow depth of field, soft blurred warm background.
ROTATE ethnicities: Black, White, Asian.
Only hands and forearms visible. No face, no full body.
Warm, soft lighting. Dreamy, editorial.
Colors: warm skin tones, soft cream/beige/blush background.
Generous space in the CENTER and TOP for text overlay.`,
        textLayout: {
          headline: { position: 'center', color: 'white', font: 'large bold serif', shadow: 'subtle-dark' },
          subtitle: { position: 'below-headline-center', color: 'white', font: 'italic', shape: 'pill-outline' },
          contextLine: { position: 'bottom-center', color: 'white', font: 'regular', shadow: 'subtle-dark' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: 'black' },
          logo: null,
        },
      },
      {
        slideNumber: 2,
        role: 'bullets',
        imagePrompt: `Rich, dark, lush nature photograph — full bleed background.
Options (rotate): giant tropical banana leaf close-up, dense fern forest floor,
dark green monstera leaves, moss-covered tree bark, deep green succulent rosettes.
Deep, saturated greens with dark shadows.
Moody, atmospheric, premium.
Space on the RIGHT side for text overlay (vertical bullet list).`,
        textLayout: {
          headline: { position: 'upper-left', color: 'white', font: 'large serif', shadow: 'dark' },
          bulletList: { position: 'right', color: 'white', font: 'regular sans', marker: 'circle-line', shadow: 'dark' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: 'white' },
          logo: null,
        },
      },
    ],

    contentStructure: {
      type: 'hook_and_bullets',
      slideInstructions: {
        hook: 'Large headline (5-10 words) + subtitle (5-8 words) + context line (5-8 words). Three distinct text elements.',
        bullets: 'Headline question or statement (5-8 words) + 4-5 bullet points (5-10 words each). Short, punchy list items.',
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 6 — Blush Arch Portrait (1 slide)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 6,
    name: 'Blush Arch Portrait',
    slideCount: 1,

    slides: [
      {
        slideNumber: 1,
        role: 'hook',
        imagePrompt: `Split composition — TOP HALF: solid warm blush/beige/tan color fill (no imagery, just solid color).
BOTTOM HALF: person photographed from shoulders down (NO FACE), framed inside a large arch or
circle crop shape. Person wearing neutral/white clothing, peaceful relaxed pose.
ROTATE ethnicities: Black, White, Asian.
Colors: warm blush, cream, tan, soft pink-beige.
The solid color top half must have generous space for headline text.
No text rendered.`,
        textLayout: {
          headline: { position: 'upper-center', color: '#3D2B1F', font: 'large elegant serif' },
          divider: { position: 'below-headline-center', type: 'vertical-line' },
          subtitle: { position: 'below-divider', color: '#5A4A3A', font: 'italic serif' },
          contextLine: { position: 'below-subtitle', color: '#5A4A3A', font: 'regular' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
    ],

    contentStructure: {
      type: 'single_announcement',
      slideInstructions: {
        hook: 'Headline (5-12 words, elegant) + subtitle tagline (5-10 words, italic feel) + context line (5-8 words). Three text layers stacked vertically with a divider between headline and subtitle.',
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 7 — Grid Collage Mosaic (1 slide)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 7,
    name: 'Grid Collage Mosaic',
    slideCount: 1,

    slides: [
      {
        slideNumber: 1,
        role: 'hook',
        imagePrompt: `3x3 grid collage mosaic. 9 tiles total — alternating between PHOTO tiles and SOLID COLOR tiles.
PHOTO tiles (5-6 tiles): warm lifestyle/object imagery — ceramic coffee cup close-up,
modern interior with cream furniture, hands holding coffee cups from above, cozy walking feet
on wooden floor, minimalist boutique interior, warm candle glow.
ROTATE photos across posts. No faces.
SOLID COLOR tiles (3-4 tiles): warm tan/beige/camel solid fill — these are where text will go.
All tiles should feel cohesive in color: warm tans, beiges, creams, browns.
Grid lines should be thin or seamless.
No text rendered in image.`,
        textLayout: {
          headlineTile: { position: 'grid-tile', color: 'white', font: 'large bold caps' },
          supportTile: { position: 'grid-tile', color: 'white', font: 'bold caps' },
          sublineTile: { position: 'grid-tile', color: 'white', font: 'regular' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
    ],

    contentStructure: {
      type: 'single_mosaic',
      slideInstructions: {
        hook: 'Three text elements for grid tiles: (1) Main headline, 2-4 words, ALL CAPS, bold. (2) Supporting text, 2-4 words, ALL CAPS. (3) Subline or CTA, 3-6 words.',
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // FORMAT 8 — Nature Circle Overlay (5 slides)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 8,
    name: 'Nature Circle Overlay',
    slideCount: 5,

    slides: [
      {
        slideNumber: 1,
        role: 'hook',
        imagePrompt: `Soft, blurred nature/botanical close-up as full background.
Options (rotate): frosty pine needles, cherry blossoms, lavender field soft focus,
eucalyptus branches, soft white flowers, dewy grass.
Warm, dreamy, light tones — soft and ethereal.
CRITICAL: A large white/cream CIRCLE will be overlaid in the center. The background
must be relatively uniform behind where the circle sits.
No text.`,
        textLayout: {
          centerCircle: { fill: 'white-cream', border: false },
          smallCaps: { position: 'inside-circle-upper', color: '#6B7B3A', font: 'small spaced caps' },
          headline: { position: 'inside-circle-center', color: '#2C1810', font: 'large elegant serif' },
          subtitle: { position: 'inside-circle-lower', color: '#2C1810', font: 'bold small caps' },
        },
        branding: {
          wellmorBenefits: { position: 'top-center', color: 'black' },
          logo: null,
        },
      },
      {
        slideNumber: 2,
        role: 'content',
        imagePrompt: `Soft, blurred nature/botanical close-up — DIFFERENT from slide 1.
Rotate: soft flower petals, fern fronds, moss texture, bark close-up, wheat field.
Warm, dreamy. Large white/cream circle overlay area in center.
No text.`,
        textLayout: {
          centerCircle: { fill: 'white-cream', border: false },
          headline: { position: 'inside-circle-upper', color: '#2C1810', font: 'elegant serif' },
          body: { position: 'inside-circle-lower', color: '#5A4A3A', font: 'regular serif' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
      {
        slideNumber: 3,
        role: 'content',
        imagePrompt: `Soft, blurred nature/botanical close-up — DIFFERENT from slides 1 and 2.
Rotate options. Warm, dreamy. Circle overlay area.
No text.`,
        textLayout: {
          centerCircle: { fill: 'white-cream', border: false },
          headline: { position: 'inside-circle-upper', color: '#2C1810', font: 'elegant serif' },
          body: { position: 'inside-circle-lower', color: '#5A4A3A', font: 'regular serif' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
      {
        slideNumber: 4,
        role: 'content',
        imagePrompt: `Soft, blurred nature/botanical close-up — DIFFERENT from previous slides.
Rotate options. Warm, dreamy. Circle overlay area.
No text.`,
        textLayout: {
          centerCircle: { fill: 'white-cream', border: false },
          headline: { position: 'inside-circle-upper', color: '#2C1810', font: 'elegant serif' },
          body: { position: 'inside-circle-lower', color: '#5A4A3A', font: 'regular serif' },
        },
        branding: {
          wellmorBenefits: null,
          logo: null,
        },
      },
      {
        slideNumber: 5,
        role: 'cta',
        imagePrompt: `Soft, blurred nature/botanical close-up — DIFFERENT from all previous slides.
Warm, dreamy, ethereal. Circle overlay area.
No text.`,
        textLayout: {
          centerCircle: { fill: 'white-cream', border: false },
          headline: { position: 'inside-circle-upper', color: '#2C1810', font: 'elegant serif' },
          body: { position: 'inside-circle-center', color: '#5A4A3A', font: 'regular serif' },
          website: { position: 'inside-circle-lower', color: '#6B7B3A', font: 'small spaced caps' },
        },
        branding: {
          wellmorBenefits: null,
          logo: { position: 'bottom-right' },
        },
      },
    ],

    contentStructure: {
      type: 'narrative_circle',
      slideInstructions: {
        hook: 'Small caps label (2-3 words) + large headline (5-10 words) + bold subtitle (3-5 words ALL CAPS). All text must fit inside a circle.',
        content: 'Headline (5-10 words) + body paragraph (20-35 words). Keep concise — must fit inside a circle shape.',
        cta: 'Headline (5-8 words) + short body (10-20 words) + wellmorbenefits.com. Must fit inside circle.',
      },
    },
  },

];

module.exports = { FORMAT_TEMPLATES };
