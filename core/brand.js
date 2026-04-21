/**
 * Growth OS — Brand Constants
 *
 * Source of truth for FGA's visual identity. Derived from:
 *   - Marketing site CSS tokens (marketing-site/src/index.css)
 *   - Brand guide (Desktop/FGA/docs/brand/brand-guide.md)
 *
 * Used by the image-generation agent to keep every generated image and text
 * overlay on-brand. Tenant overrides still win — tenant_config keys like
 * `image_style_guidance` / `brand_colors` let clients ship their own look
 * without changing this file.
 *
 * IMPORTANT: the hex for Midnight is #132A4A on the marketing site CSS
 * (`--color-midnight: #132A4A`). The brand-guide document lists #1B2A4A as
 * a minor docs/CSS drift. We use the CSS value because that's what the
 * public site actually renders.
 */

const FGA_BRAND = {
  name: 'First Gen Automate',
  website: 'firstgenautomate.com',
  tagline: 'We install Growth OS for your business',

  // Primary palette (from marketing-site/src/index.css)
  colors: {
    midnight: '#132A4A',          // primary brand (headers, text on white)
    signalGreen: '#22C55E',       // CTAs, success, growth metrics
    signalGreenDark: '#16A34A',   // CTA hover
    white: '#FFFFFF',
    slate: '#64748B',             // secondary text, muted UI
    lightGray: '#F1F5F9',         // page/section backgrounds
    warmAmber: '#F59E0B',         // warnings, "needs review"
    red: '#EF4444',               // errors, at-risk
  },

  // Typography (Inter on the web; DejaVu Sans on the Railway container
  // because Inter is not bundled — the web font stack falls back to
  // system sans which on Linux is DejaVu Sans. Close enough visually and
  // guaranteed to render glyphs correctly in librsvg).
  fonts: {
    uiStack: "'DejaVu Sans', 'Liberation Sans', Inter, system-ui, Arial, sans-serif",
    serifStack: "'DejaVu Serif', 'Liberation Serif', Georgia, serif",
    // Weights used on the site
    weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  },

  // AI image style — codifies the brand-guide "Photography & Imagery Style"
  // and the hard rules from section 8 ("Brand Don'ts"). Passed to Gemini as
  // the prompt style block.
  imageStyle: {
    // One paragraph style directive for Gemini. Written to be concrete
    // enough that generated images consistently match what shows up on
    // firstgenautomate.com — clean, confident, founder-forward, small-
    // business-grounded. Explicit "do not" list kills the tech-stock and
    // cyberpunk failure modes we saw on earlier runs.
    styleGuidance: `
Brand: First Gen Automate — clean, professional, trustworthy, modern but not trendy.
Target audience: busy owners of 1-10 person service businesses (plumbers, tree
service, HVAC, landscapers, contractors, cleaners). These people are on job
sites, in trucks, between appointments.

Visual style: real-world documentary photography. Natural light. Tactile,
grounded scenes from small-business life — a hand on a phone at a job site,
morning coffee on a truck dashboard, a business owner looking thoughtful,
a weathered workbench, a storefront at golden hour, tools laid out clean,
a handshake between a contractor and a customer. Warm but professional.
Earth tones grounded by deep navy (#132A4A) and occasional signal green
(#22C55E) accents. Minimal background. High contrast for text overlay.

Feel: Professional. Trustworthy. Modern. Approachable. NOT trendy.
Clean negative space on one side of the composition so text reads clearly.

STRICTLY AVOID:
- Futuristic / sci-fi / cyberpunk imagery
- Circuit boards, holograms, glowing UI, hexagons, data visualizations
- Neon, lens flares, robots, AI-as-humanoid depictions
- Stock photography of people shaking hands or pointing at screens
- Uncanny-valley photorealistic faces (use hands, backs, side profiles, environments)
- Cartoons, clipart, illustrations, 3D renders
- Any text, letters, logos, or typography baked into the image
- Signal Green (#22C55E) as a background color — use as a small accent only
`.trim(),
  },
};

module.exports = { FGA_BRAND };
