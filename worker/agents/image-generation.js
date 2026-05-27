/**
 * Growth OS — Image Generation Agent
 * Ported from WellMor agents/image-agent.js
 *
 * Supports two modes:
 * - 'image': Gemini API generates photographic background
 * - 'solid': Local SVG → PNG solid color background (no API call)
 *
 * Then composites text overlay + logo via Sharp.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { generateImage: geminiGenerate } = require('../../integrations/gemini');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { getServiceClient } = require('../../db/client');
const { FGA_BRAND } = require('../../core/brand');
const {
  INDUSTRY_IMAGE_SUBJECTS,
  INDUSTRY_SUBJECT_FALLBACK,
  getFormatById,
} = require('../../core/fga-content-formats');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'static', 'images');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const STORAGE_BUCKET = 'content-images';

/**
 * Upload image to Supabase Storage and return public URL
 */
async function uploadToStorage(filePath, fileName, tenantSlug) {
  const log = createLogger('image-gen', tenantSlug);
  try {
    const db = getServiceClient();
    const fileBuffer = fs.readFileSync(filePath);
    const storagePath = `${tenantSlug}/${fileName}`;

    const { error } = await db.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: 'image/png',
        upsert: true,
      });

    if (error) throw error;

    const { data: urlData } = db.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(storagePath);

    log.info(`Uploaded to storage: ${storagePath}`);
    return urlData.publicUrl;
  } catch (err) {
    log.error(`Storage upload failed: ${err.message}`);
    return null;
  }
}

// === HELPERS ===

function slugify(text = '') {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function escapeXML(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrapText(text, maxCharsPerLine) {
  const words = (text || '').split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length > maxCharsPerLine && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

async function isImageLight(imagePath) {
  try {
    const stats = await sharp(imagePath)
      .flatten({ background: { r: 128, g: 128, b: 128 } })
      .resize(50, 50, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { data } = stats;
    let totalBrightness = 0;
    const pixelCount = data.length / 3;
    for (let i = 0; i < data.length; i += 3) {
      totalBrightness += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return (totalBrightness / pixelCount) > 145;
  } catch {
    return false;
  }
}

function resolveColor(templateColor, useDarkText, darkDefault = '#2C1810', lightDefault = 'white') {
  if (!templateColor || templateColor === 'adaptive') return useDarkText ? darkDefault : lightDefault;
  if (templateColor === 'black') return '#1A1A1A';
  if (templateColor === 'white') return '#FFFFFF';
  return templateColor;
}

function resolveShadow(shadowType) {
  if (!shadowType || shadowType === 'none') return null;
  if (shadowType === 'strong-black') return { color: 'black', opacity: '0.8', blur: 8, dy: 3 };
  if (shadowType === 'black') return { color: 'black', opacity: '0.6', blur: 6, dy: 2 };
  if (shadowType === 'white') return { color: 'white', opacity: '0.6', blur: 4, dy: 1 };
  if (shadowType === 'subtle-dark') return { color: 'black', opacity: '0.3', blur: 3, dy: 1 };
  if (shadowType === 'subtle-black') return { color: 'black', opacity: '0.3', blur: 3, dy: 1 };
  if (shadowType === 'dark') return { color: 'black', opacity: '0.5', blur: 5, dy: 2 };
  return null;
}

function getXAnchor(position, width) {
  // Max-chars-per-line. Controls how many characters fit before wrapping.
  // These must be conservative enough that no line overflows the canvas
  // edge — character count is an approximation since glyphs vary in width.
  // Safe margins: left/right-anchored text starts at 8% with ~84% usable
  // width; center-anchored text has ~80% usable width (10% margin each side).
  if (position && (position.includes('right'))) return { x: Math.floor(width * 0.92), anchor: 'end', headlineMaxChars: 24, bodyMaxChars: 38 };
  if (position && (position.includes('left'))) return { x: Math.floor(width * 0.08), anchor: 'start', headlineMaxChars: 24, bodyMaxChars: 38 };
  if (position && position.includes('center')) return { x: Math.floor(width * 0.50), anchor: 'middle', headlineMaxChars: 24, bodyMaxChars: 36 };
  return { x: Math.floor(width * 0.50), anchor: 'middle', headlineMaxChars: 24, bodyMaxChars: 36 };
}

function getStartY(position, height) {
  if (!position) return Math.floor(height * 0.15);
  // 'upper' used to start at 0.13 but a Format 3 stat at 1.8x font size
  // clips off the top of the canvas at that y-baseline. Nudged to 0.20
  // — gives a 115px-tall glyph at the giant stat ~50px headroom while
  // still reading as "upper" for normal-sized headlines.
  if (position.includes('upper')) return Math.floor(height * 0.20);
  if (position.includes('lower')) return Math.floor(height * 0.58);
  if (position.includes('bottom')) return Math.floor(height * 0.88);
  if (position.includes('center')) return Math.floor(height * 0.35);
  return Math.floor(height * 0.15);
}

// === SOLID BACKGROUND ===
//
// 2026-05-26: switched from square (1024×1024) to 4:5 portrait
// (1080×1350) to match Instagram's profile-grid display ratio so
// text-overlay headlines stop getting clipped on the sides in the
// grid view. width and height are now independent — callers that
// need the legacy square can pass { width: 1024, height: 1024 }.

async function generateSolidBackground({ bgColor, gradientColor, width = 1080, height = 1350, size }) {
  // Back-compat: if legacy callers pass `size`, honor it as both.
  const w = size || width;
  const h = size || height;
  const bg = bgColor || '#F5F0EB';
  const grad = gradientColor || bg;
  const svgBg = `
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="40%" r="80%">
        <stop offset="0%" stop-color="${grad}"/>
        <stop offset="100%" stop-color="${bg}"/>
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
  </svg>`;
  return sharp(Buffer.from(svgBg)).png().toBuffer();
}

// === HYBRID PHOTO + SOLID BLOCK BACKGROUND (Option B layout) ===
//
// 2026-05-26: a premium magazine-cover style. Top 60% (1080×810) is a
// Gemini-generated atmospheric photograph; bottom 40% (1080×540) is a
// solid brand color block where the text overlay will land. A thin
// accent-color hairline separates the two regions.
//
// Slide formats opt in via `backgroundType: 'hybrid_photo_block'` and
// supply `bgPalette: { base: <block hex>, accent: <hairline hex> }`
// plus an `imagePrompt`. Text positions in the format should land in
// the bottom 40% (customY ≈ 0.65-0.90) so they sit on the solid block.

async function generateHybridPhotoBlock({
  imagePrompt,
  blockColor,
  accentColor,
  tenantSlug,
  businessName,
  styleGuidance,
  postTheme,
}) {
  const photoPrompt = `Create a premium editorial Instagram photograph for ${businessName}.
${postTheme ? `Post theme: ${postTheme}` : ''}

CRITICAL: NO text, NO words, NO letters, NO typography. Pure photograph.

${imagePrompt}

BRAND STYLE:
${styleGuidance}

COMPOSITION: Cinematic mood, atmospheric, documentary feel. Strong negative space, intentional framing. Subject placed deliberately, not centered by default. Editorial quality — think New York Times Magazine, not stock photo.

OUTPUT: Photorealistic. 4:3 landscape composition (image will be cropped to fill the top region of a 4:5 portrait card; design with that crop in mind).`;

  const rawPhoto = await geminiGenerate(photoPrompt, { tenantSlug, aspectRatio: '4:3' });
  // Force exact 1080×810 — top 60% of the 1350-tall canvas.
  const photoBuf = await sharp(rawPhoto)
    .resize(1080, 810, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  // Solid color block 1080×540 — bottom 40%. Subtle radial gradient
  // gives it depth without looking flat.
  const blockSVG = `<svg width="1080" height="540" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="20%" cy="20%" r="120%">
        <stop offset="0%" stop-color="${blockColor}" stop-opacity="1"/>
        <stop offset="100%" stop-color="${blockColor}" stop-opacity="0.92"/>
      </radialGradient>
    </defs>
    <rect width="1080" height="540" fill="url(#bg)"/>
  </svg>`;
  const blockBuf = await sharp(Buffer.from(blockSVG)).png().toBuffer();

  // Hairline divider — 3px tall, full width, accent color.
  const dividerSVG = `<svg width="1080" height="3" xmlns="http://www.w3.org/2000/svg">
    <rect width="1080" height="3" fill="${accentColor}"/>
  </svg>`;
  const dividerBuf = await sharp(Buffer.from(dividerSVG)).png().toBuffer();

  // Composite: photo (0-810) + divider (810-813) + block (813-1353,
  // but block is 540 tall so it ends at 1353 — close enough to 1350,
  // bottom 3px get clipped by canvas which is fine).
  const combined = await sharp({
    create: { width: 1080, height: 1350, channels: 4, background: { r: 11, g: 17, b: 32, alpha: 1 } },
  })
    .composite([
      { input: photoBuf, top: 0, left: 0 },
      { input: blockBuf, top: 810, left: 0 },
      // Divider drawn last so it sits ON TOP of the block (visible hairline).
      { input: dividerBuf, top: 810, left: 0 },
    ])
    .png()
    .toBuffer();

  return combined;
}

// === TEXT OVERLAY SVG ===

function buildTextOverlaySVG({ headline, subtext, body, bullets, width, height, slideTemplate, useDarkText, tenant }) {
  const layout = slideTemplate?.textLayout || {};
  const branding = slideTemplate?.branding || {};
  let svgElements = [];
  let filterDefs = [];
  let gradientDefs = [];
  let currentY = 0;

  function addShadowFilter(id, shadowDef) {
    if (!shadowDef) return id;
    const filterId = `shadow_${id}`;
    filterDefs.push(`<filter id="${filterId}" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="${shadowDef.dy}" stdDeviation="${shadowDef.blur}" flood-color="${shadowDef.color}" flood-opacity="${shadowDef.opacity}"/></filter>`);
    return filterId;
  }

  function renderTextBlock({ text, positionKey, colorDef, fontDef, shadowDef, fontSize: fSize, maxChars, maxLines, isFirstInGroup }) {
    if (!text || !text.trim()) return 0;
    const xa = getXAnchor(positionKey, width);
    const color = resolveColor(colorDef, useDarkText);
    const shadow = resolveShadow(shadowDef);
    const filterId = addShadowFilter(`t${svgElements.length}`, shadow);
    const isHeadline = fontDef && (fontDef.includes('bold') || fontDef.includes('large'));
    const baseFontSize = isHeadline ? Math.floor(width * 0.055) : Math.floor(width * 0.033);
    const finalFontSize = fSize || baseFontSize;
    const lineHeight = finalFontSize * (isHeadline ? 1.25 : 1.50);
    // Font stack — DejaVu ships with Railway/Debian containers and has full
    // glyph coverage. Earlier runs picked Helvetica Neue/Georgia which are
    // not installed, causing librsvg to fall back to a font without required
    // glyphs → text rendered as tofu (□). See core/brand.js.
    let fontFamily = FGA_BRAND.fonts.uiStack;
    let fontWeightVal = String(FGA_BRAND.fonts.weights.regular);
    if (fontDef) {
      if (fontDef.includes('serif') && !fontDef.includes('sans')) {
        fontFamily = FGA_BRAND.fonts.serifStack;
      }
      if (fontDef.includes('bold')) fontWeightVal = String(FGA_BRAND.fonts.weights.bold);
      if (fontDef.includes('semibold')) fontWeightVal = String(FGA_BRAND.fonts.weights.semibold);
    }
    const defaultChars = isHeadline ? (xa.headlineMaxChars || 32) : (xa.bodyMaxChars || 42);
    const chars = maxChars || defaultChars;
    const lines = wrapText(text, chars);
    // Safety: if maxLines would truncate the text, DON'T. Cutting sentences
    // mid-word makes slides look broken. Only apply maxLines when the source
    // text actually fits in that many lines; otherwise render everything and
    // let the font size breathe. Upstream Claude is already instructed to
    // keep bodies under 35 words, so letting them run prevents truncation
    // without blowing the layout.
    const limitedLines = (maxLines && lines.length <= maxLines)
      ? lines.slice(0, maxLines)
      : lines;
    const startY = isFirstInGroup ? getStartY(positionKey, height) : currentY;
    const letterSpacing = (fontDef && (fontDef.includes('caps') || fontDef.includes('spaced'))) ? 'letter-spacing="2"' : '';
    const textContent = (fontDef && fontDef.includes('caps')) ? limitedLines.map(l => l.toUpperCase()) : limitedLines;
    const fontStyle = (fontDef && fontDef.includes('italic')) ? 'font-style="italic"' : '';
    const filterAttr = shadow ? `filter="url(#${filterId})"` : '';

    for (let i = 0; i < textContent.length; i++) {
      const y = startY + i * lineHeight;
      svgElements.push(`<text x="${Math.floor(xa.x)}" y="${Math.floor(y)}" text-anchor="${xa.anchor}" font-family="${fontFamily}" font-weight="${fontWeightVal}" font-size="${finalFontSize}" fill="${color}" ${letterSpacing} ${fontStyle} ${filterAttr}>${escapeXML(textContent[i])}</text>`);
    }
    const totalHeight = textContent.length * lineHeight;
    currentY = startY + totalHeight + Math.floor(lineHeight * 0.3);
    return totalHeight;
  }

  function renderDivider(positionKey, color) {
    const xa = getXAnchor(positionKey || 'center', width);
    const dividerWidth = Math.floor(width * 0.08);
    const x = xa.anchor === 'middle' ? Math.floor(xa.x - dividerWidth / 2) : Math.floor(xa.x);
    const dividerColor = resolveColor(color || '#8B6914', useDarkText, '#8B6914', 'rgba(255,220,160,0.6)');
    svgElements.push(`<rect x="${x}" y="${Math.floor(currentY)}" width="${dividerWidth}" height="2" fill="${dividerColor}" rx="1"/>`);
    currentY += 22;
  }

  // Gradient scrim for readability
  const headlineColor = layout.headline?.color || 'adaptive';
  if (headlineColor === 'white' || headlineColor === '#FFFFFF') {
    gradientDefs.push(`<radialGradient id="textBg" cx="50%" cy="45%" r="75%"><stop offset="0%" stop-color="black" stop-opacity="0.30"/><stop offset="100%" stop-color="black" stop-opacity="0.08"/></radialGradient>`);
    svgElements.unshift(`<rect x="0" y="0" width="${width}" height="${height}" fill="url(#textBg)"/>`);
  }

  // Decorations — graphic elements (quote marks, rings, accent bands) that
  // sit under the text. Used by Format 2 (Quote Card) and Format 3 (Stat
  // Card) to give text-only slides a visual hook without resorting to
  // people-photography. Each decoration is purely SVG so it costs nothing
  // to render (no extra Gemini call) and renders crisp at any size.
  if (Array.isArray(layout.decorations)) {
    for (const deco of layout.decorations) {
      if (!deco || !deco.type) continue;
      const decoColor = deco.color || '#22C55E';
      const opacity = deco.opacity !== undefined ? deco.opacity : 1;

      if (deco.type === 'quote-marks') {
        // Giant decorative open + close quote glyphs, top-left + bottom-right.
        // Renders BEHIND text by being added to svgElements first.
        const quoteSize = Math.floor(width * (deco.size || 0.28));
        const openX = Math.floor(width * 0.10);
        const openY = Math.floor(height * 0.30);
        const closeX = Math.floor(width * 0.90);
        const closeY = Math.floor(height * 0.78);
        svgElements.push(`<text x="${openX}" y="${openY}" text-anchor="start" font-family="${FGA_BRAND.fonts.serifStack}" font-weight="700" font-size="${quoteSize}" fill="${decoColor}" opacity="${opacity}">&#8220;</text>`);
        svgElements.push(`<text x="${closeX}" y="${closeY}" text-anchor="end" font-family="${FGA_BRAND.fonts.serifStack}" font-weight="700" font-size="${quoteSize}" fill="${decoColor}" opacity="${opacity}">&#8221;</text>`);
      } else if (deco.type === 'ring') {
        // Centered circular ring — stroke only. Used to frame a big stat.
        const cx = Math.floor(width * (deco.cx ?? 0.50));
        const cy = Math.floor(height * (deco.cy ?? 0.42));
        const r = Math.floor(width * (deco.radius ?? 0.32));
        const sw = Math.floor(width * (deco.strokeWidth ?? 0.012));
        svgElements.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${decoColor}" stroke-width="${sw}" opacity="${opacity}"/>`);
      } else if (deco.type === 'accent-band') {
        // Vertical accent stripe along the left edge — used by Format 5
        // (Pattern/Anti-Pattern) "right way" slide. Optional.
        const bandW = Math.floor(width * (deco.width || 0.012));
        const bandH = Math.floor(height * (deco.height || 1.0));
        const bandX = deco.side === 'right' ? width - bandW : 0;
        const bandY = Math.floor((height - bandH) / 2);
        svgElements.push(`<rect x="${bandX}" y="${bandY}" width="${bandW}" height="${bandH}" fill="${decoColor}" opacity="${opacity}"/>`);
      } else if (deco.type === 'corner-mark') {
        // Subtle Signal Green corner mark (square in the corner) — adds a
        // small graphic anchor without dominating. Light visual variety.
        const sz = Math.floor(width * (deco.size || 0.04));
        const margin = Math.floor(width * 0.06);
        let cx, cy;
        if (deco.position === 'top-right') { cx = width - margin - sz; cy = margin; }
        else if (deco.position === 'bottom-left') { cx = margin; cy = height - margin - sz; }
        else { cx = margin; cy = margin; }
        svgElements.push(`<rect x="${cx}" y="${cy}" width="${sz}" height="${sz}" fill="${decoColor}" opacity="${opacity}"/>`);
      } else if (deco.type === 'center-shape') {
        // Phase 2 Feature 1: filled center shape (circle | rounded-square |
        // arch | hexagon) that the format's text renders ON TOP OF. Used by
        // Format 2 (Quote Card with arch frame) and Format 3 (Stat Card
        // with circle behind the stat). Format text blocks position
        // themselves via customY to land inside the shape.
        //
        // Config:
        //   shape: 'circle' | 'rounded-square' | 'arch' | 'hexagon'
        //   fill:  fill color (default #FFFFFF for light frames on photo bg)
        //   size:  fraction of width (default 0.65)
        //   cx, cy: center anchor as 0-1 fractions (default 0.5, 0.5)
        //   border: { color, width } optional stroke
        const shape = deco.shape || 'circle';
        const fill = deco.fill || '#FFFFFF';
        const size = deco.size ?? 0.65;
        const cx = Math.floor(width * (deco.cx ?? 0.5));
        const cy = Math.floor(height * (deco.cy ?? 0.5));
        const sw = deco.border?.width ? Math.floor(width * deco.border.width) : 0;
        const stroke = deco.border?.color || 'none';
        const strokeAttr = sw > 0 ? `stroke="${stroke}" stroke-width="${sw}"` : '';

        if (shape === 'circle') {
          const r = Math.floor((width * size) / 2);
          svgElements.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${strokeAttr} opacity="${opacity}"/>`);
        } else if (shape === 'rounded-square') {
          const sz = Math.floor(width * size);
          const x = cx - Math.floor(sz / 2);
          const y = cy - Math.floor(sz / 2);
          const rx = Math.floor(sz * (deco.cornerRadius ?? 0.10));
          svgElements.push(`<rect x="${x}" y="${y}" width="${sz}" height="${sz}" rx="${rx}" ry="${rx}" fill="${fill}" ${strokeAttr} opacity="${opacity}"/>`);
        } else if (shape === 'hexagon') {
          // Pointy-top hexagon
          const r = (width * size) / 2;
          const pts = [];
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i - Math.PI / 2;
            pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
          }
          svgElements.push(`<polygon points="${pts.join(' ')}" fill="${fill}" ${strokeAttr} opacity="${opacity}"/>`);
        } else if (shape === 'arch') {
          // Bottom-flat, rounded-top arch shape — width = w, height = h,
          // top semicircle of radius w/2. Used as the editorial arch frame
          // behind quote-card text.
          const w = width * size;
          const h = w * (deco.archRatio ?? 1.3);
          const x = cx - Math.floor(w / 2);
          const y = cy - Math.floor(h / 2);
          const r = Math.floor(w / 2);
          // M x,(y+r) v(h-r) h(w) v-(h-r) a r,r 0 0,0 -w,0 z
          const path = `M ${x} ${y + r} L ${x} ${y + h} L ${x + w} ${y + h} L ${x + w} ${y + r} A ${r} ${r} 0 0 0 ${x} ${y + r} Z`;
          svgElements.push(`<path d="${path}" fill="${fill}" ${strokeAttr} opacity="${opacity}"/>`);
        }
      } else if (deco.type === 'editorial-collage') {
        // Phase 2 renderer: Editorial Collage.
        // Magazine-spread composition — one large hero block + 2 smaller
        // satellite blocks arranged asymmetrically. Each block is a flat
        // colored rectangle that text can render on top of, evoking a
        // photo-collage layout without requiring multiple Gemini calls.
        //
        // Config:
        //   palette: array of fill colors (uses first 3, defaults to FGA brand mix)
        //   opacity: 0-1 (default 0.92)
        //   layout: 'left-hero' | 'right-hero' (default 'left-hero')
        const palette = Array.isArray(deco.palette) && deco.palette.length
          ? deco.palette
          : [FGA_BRAND.colors.midnight, FGA_BRAND.colors.signalGreen, FGA_BRAND.colors.lightGray];
        const opC = deco.opacity !== undefined ? deco.opacity : 0.92;
        const isRightHero = deco.layout === 'right-hero';

        // Hero block — ~55% width, full bleed top-to-bottom on one side
        const heroW = Math.floor(width * 0.55);
        const heroH = Math.floor(height * 0.78);
        const heroX = isRightHero ? width - heroW - Math.floor(width * 0.05) : Math.floor(width * 0.05);
        const heroY = Math.floor(height * 0.11);
        svgElements.push(`<rect x="${heroX}" y="${heroY}" width="${heroW}" height="${heroH}" rx="${Math.floor(width * 0.015)}" fill="${palette[0]}" opacity="${opC}"/>`);

        // Satellite block A — small square, opposite side, upper region
        const satAW = Math.floor(width * 0.32);
        const satAH = Math.floor(width * 0.32);
        const satAX = isRightHero ? Math.floor(width * 0.06) : width - satAW - Math.floor(width * 0.06);
        const satAY = Math.floor(height * 0.16);
        svgElements.push(`<rect x="${satAX}" y="${satAY}" width="${satAW}" height="${satAH}" rx="${Math.floor(width * 0.015)}" fill="${palette[1]}" opacity="${opC}"/>`);

        // Satellite block B — short wide bar below satellite A
        const satBW = Math.floor(width * 0.32);
        const satBH = Math.floor(width * 0.20);
        const satBX = satAX;
        const satBY = satAY + satAH + Math.floor(height * 0.025);
        svgElements.push(`<rect x="${satBX}" y="${satBY}" width="${satBW}" height="${satBH}" rx="${Math.floor(width * 0.015)}" fill="${palette[2]}" opacity="${opC}"/>`);
      } else if (deco.type === 'grid-tile') {
        // Phase 2 renderer: Grid Tile Layout.
        // A clean N x N grid of square tiles, alternating colors from the
        // palette in a checkerboard pattern. Text renders on top.
        //
        // Config:
        //   gridSize: 2, 3, or 4 (default 3)
        //   palette: array of fill colors (rotates through them)
        //   opacity: 0-1 (default 0.85)
        //   gap: fraction of width between tiles (default 0.015)
        //   inset: fraction of canvas to leave as outer margin (default 0.08)
        const gridSize = Math.max(2, Math.min(4, deco.gridSize || 3));
        const palette = Array.isArray(deco.palette) && deco.palette.length
          ? deco.palette
          : [FGA_BRAND.colors.midnight, FGA_BRAND.colors.signalGreen, FGA_BRAND.colors.lightGray, FGA_BRAND.colors.warmAmber || '#F59E0B'];
        const opG = deco.opacity !== undefined ? deco.opacity : 0.85;
        const inset = deco.inset !== undefined ? deco.inset : 0.08;
        const gap = deco.gap !== undefined ? deco.gap : 0.015;

        const gridStart = Math.floor(width * inset);
        const gridEnd = Math.floor(width * (1 - inset));
        const totalSpan = gridEnd - gridStart;
        const gapPx = Math.floor(width * gap);
        const tileSize = Math.floor((totalSpan - gapPx * (gridSize - 1)) / gridSize);
        const gridTopY = Math.floor((height - (tileSize * gridSize + gapPx * (gridSize - 1))) / 2);

        let tileIdx = 0;
        for (let r = 0; r < gridSize; r++) {
          for (let c = 0; c < gridSize; c++) {
            const tx = gridStart + c * (tileSize + gapPx);
            const ty = gridTopY + r * (tileSize + gapPx);
            const fillC = palette[tileIdx % palette.length];
            svgElements.push(`<rect x="${tx}" y="${ty}" width="${tileSize}" height="${tileSize}" rx="${Math.floor(tileSize * 0.06)}" fill="${fillC}" opacity="${opC || opG}"/>`);
            tileIdx++;
          }
        }
      } else if (deco.type === 'pinwheel') {
        // Phase 2 renderer: Pinwheel Graphic.
        // Radial arrangement of N triangular wedges rotating around the
        // canvas center — alternating colors create the pinwheel effect.
        // The wedges are rendered BEHIND text, so text in the upper or
        // lower thirds reads clean while the pinwheel anchors the slide
        // visually.
        //
        // Config:
        //   blades: 6 | 8 | 12 (default 8)
        //   palette: 2+ colors that alternate around the rotation
        //   opacity: 0-1 (default 0.55) — kept low so text stays readable
        //   radius: fraction of width (default 0.42)
        //   cx, cy: center anchor as fractions (defaults 0.5, 0.5)
        //   rotate: degrees offset (default 0)
        const blades = Math.max(3, Math.min(24, deco.blades || 8));
        const palette = Array.isArray(deco.palette) && deco.palette.length >= 2
          ? deco.palette
          : [FGA_BRAND.colors.signalGreen, FGA_BRAND.colors.midnight];
        const opP = deco.opacity !== undefined ? deco.opacity : 0.55;
        const r = Math.floor(width * (deco.radius ?? 0.42));
        const pcx = Math.floor(width * (deco.cx ?? 0.5));
        const pcy = Math.floor(height * (deco.cy ?? 0.5));
        const rotateOffset = deco.rotate || 0;

        const anglePerBlade = (2 * Math.PI) / blades;
        for (let i = 0; i < blades; i++) {
          const startAngle = i * anglePerBlade + (rotateOffset * Math.PI / 180);
          const endAngle = startAngle + anglePerBlade;
          // Triangular wedge: center → arc start → arc end → back to center
          const x1 = pcx + r * Math.cos(startAngle);
          const y1 = pcy + r * Math.sin(startAngle);
          const x2 = pcx + r * Math.cos(endAngle);
          const y2 = pcy + r * Math.sin(endAngle);
          const fillC = palette[i % palette.length];
          // Path: M center L x1,y1 A r,r 0 0 1 x2,y2 Z (arc for curved wedge tips)
          const largeArc = anglePerBlade > Math.PI ? 1 : 0;
          const path = `M ${pcx} ${pcy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`;
          svgElements.push(`<path d="${path}" fill="${fillC}" opacity="${opP}"/>`);
        }
      }
    }
  }

  // Brand header (tenant-configurable)
  const brandName = getConfig(tenant, 'business_name', '').toUpperCase();
  if (branding.wellmorBenefits && brandName) {
    const pos = branding.wellmorBenefits.position || 'top-center';
    const brandColor = resolveColor(branding.wellmorBenefits.color || 'black', useDarkText, '#1A1A1A', '#1A1A1A');
    const brandFontSize = Math.floor(width * 0.028);
    const brandX = Math.floor(width * 0.50);
    const brandY = pos.includes('bottom') ? Math.floor(height * 0.94) : Math.floor(height * 0.055);
    svgElements.push(`<text x="${brandX}" y="${brandY}" text-anchor="middle" font-family="${FGA_BRAND.fonts.uiStack.replace(/"/g,'&quot;')}" font-weight="500" font-size="${brandFontSize}" fill="${brandColor}" letter-spacing="3">${escapeXML(brandName)}</text>`);
    if (pos.includes('top')) currentY = Math.floor(height * 0.10);
  } else {
    currentY = Math.floor(height * 0.08);
  }

  // Headline
  if (layout.headline && headline) {
    const hl = layout.headline;
    const isLarge = hl.font && (hl.font.includes('large') || hl.font.includes('bold'));
    const baseFSize = isLarge ? Math.floor(width * 0.062) : Math.floor(width * 0.050);
    // fontSizeMultiplier lets a format render the headline GIANT — used by
    // Format 3 (Stat Card) where the headline is the stat itself ($38.2B)
    // and needs ~1.8x normal size to read as the focal point of the slide.
    const fSize = Math.floor(baseFSize * (hl.fontSizeMultiplier || 1));
    // customY lets a format anchor a specific text block at an absolute
    // y-fraction (e.g. 0.50 for vertical center) instead of relying on
    // getStartY's position-key buckets. Used by Format 3 to nail the stat
    // exactly in the middle of the ring.
    if (hl.customY != null) {
      currentY = Math.floor(height * hl.customY);
    }
    renderTextBlock({ text: headline, positionKey: hl.position || 'center', colorDef: hl.color, fontDef: hl.font || 'bold serif', shadowDef: hl.shadow, fontSize: fSize, maxChars: hl.maxChars, maxLines: hl.maxLines, isFirstInGroup: hl.customY == null });
  }

  // Divider — only render when EXPLICITLY configured by the slide template.
  // Previous logic also triggered the divider whenever a body field existed,
  // which painted a stray orange/amber underline on Format 3 (the citation
  // body) and Format 2 (the italic attribution). Both showed up as an
  // unwanted ~8% wide rule under the attribution text.
  if (layout.divider) {
    renderDivider(layout.headline?.position || 'center', layout.divider.color);
  }

  // Subtitle
  if (layout.subtitle && subtext) {
    const st = layout.subtitle;
    if (st.customY != null) {
      currentY = Math.floor(height * st.customY);
    }
    // When customY is set, we've already moved currentY to the exact
    // anchor — pass isFirstInGroup=false so renderTextBlock uses currentY
    // and doesn't re-derive from getStartY based on a position key.
    renderTextBlock({ text: subtext, positionKey: st.position || 'center', colorDef: st.color, fontDef: st.font || 'italic serif', shadowDef: st.shadow, maxChars: st.maxChars, isFirstInGroup: false });
  }

  // Body
  if (layout.body && body) {
    const bodyPosKey = layout.body.position || layout.headline?.position || 'center';
    const bodyFontSize = Math.floor(width * 0.033);
    const bodyLineH = bodyFontSize * 1.50;
    const bottomMargin = Math.floor(height * 0.14);
    if (layout.body.customY != null) {
      currentY = Math.floor(height * layout.body.customY);
    }
    const availableSpace = height - currentY - bottomMargin;
    // Generous floor so bodies up to ~8 lines always render. If the text is
    // longer than available space, we accept slight encroachment into the
    // bottom margin rather than truncating mid-sentence.
    const safeMaxLines = Math.max(8, Math.floor(availableSpace / bodyLineH));
    renderTextBlock({ text: body, positionKey: bodyPosKey, colorDef: layout.body.color, fontDef: layout.body.font || 'regular sans', shadowDef: layout.body.shadow, maxChars: layout.body.maxChars, maxLines: layout.body.maxLines || safeMaxLines, isFirstInGroup: false });
  }

  // Phase 2 Feature 2: Bullet List Rendering.
  // When a slide template declares layout.bulletList AND the caller
  // passes a non-empty bullets array, render each bullet as its own
  // line with a configurable marker (circle | dash | number). Used by
  // Format 6 (Three-Beat insight slide variant) and any listicle
  // format that wants scannable bullets instead of a single body
  // paragraph.
  //
  // Config (slideTemplate.textLayout.bulletList):
  //   position: 'left' | 'center' | 'right' (default 'left')
  //   marker:   'circle' | 'dash' | 'number' (default 'circle')
  //   color:    text color (defaults to white/midnight per useDarkText)
  //   markerColor: marker accent (default = brand signal green)
  //   shadow:   shadow def
  //   maxItems: render up to N (default 6)
  //   startY:   y-fraction (default 0.40)
  //   gap:      line gap as fraction of width (default 0.06)
  //   font:     'regular sans' | 'bold sans' | etc (default regular sans)
  if (layout.bulletList && Array.isArray(bullets) && bullets.length) {
    const bl = layout.bulletList;
    const items = bullets.slice(0, bl.maxItems || 6).filter((s) => String(s || '').trim());
    if (items.length) {
      const pos = bl.position || 'left';
      const startY = Math.floor(height * (bl.startY ?? 0.40));
      const gap = Math.floor(width * (bl.gap ?? 0.06));
      const fontSize = Math.floor(width * (bl.fontSizeFraction ?? 0.030));
      const textColor = resolveColor(bl.color || 'white', useDarkText, '#1A1A1A', '#FFFFFF');
      const markerColor = bl.markerColor || FGA_BRAND.colors.signalGreen || '#22C55E';
      const blShadow = resolveShadow(bl.shadow);
      const blFilterId = addShadowFilter('bullet', blShadow);
      const blFilterAttr = blShadow ? `filter="url(#${blFilterId})"` : '';

      // Indent + alignment
      let textX, markerX, anchor;
      if (pos === 'center') {
        textX = Math.floor(width * 0.50);
        markerX = textX - Math.floor(width * 0.30);
        anchor = 'middle';
      } else if (pos === 'right') {
        textX = Math.floor(width * 0.92);
        markerX = textX - Math.floor(width * 0.50);
        anchor = 'end';
      } else {
        textX = Math.floor(width * 0.12);
        markerX = Math.floor(width * 0.08);
        anchor = 'start';
      }

      const markerSize = Math.floor(fontSize * 0.55);
      items.forEach((raw, i) => {
        const y = startY + (i * gap);
        const text = String(raw).trim();

        if (bl.marker === 'number') {
          svgElements.push(`<text x="${markerX}" y="${y}" font-family="${FGA_BRAND.fonts.uiStack.replace(/"/g,'&quot;')}" font-weight="800" font-size="${fontSize}" fill="${markerColor}" ${blFilterAttr}>${i + 1}.</text>`);
        } else if (bl.marker === 'dash') {
          const dashY = y - Math.floor(fontSize * 0.30);
          svgElements.push(`<line x1="${markerX}" y1="${dashY}" x2="${markerX + markerSize * 1.5}" y2="${dashY}" stroke="${markerColor}" stroke-width="${Math.max(2, Math.floor(markerSize * 0.18))}" ${blFilterAttr}/>`);
        } else {
          // circle (default)
          const cy = y - Math.floor(fontSize * 0.32);
          svgElements.push(`<circle cx="${markerX + markerSize / 2}" cy="${cy}" r="${Math.floor(markerSize / 2)}" fill="${markerColor}" ${blFilterAttr}/>`);
        }

        const fontFamily = (bl.font || '').includes('bold')
          ? `${FGA_BRAND.fonts.uiStack.replace(/"/g,'&quot;')}`
          : `${FGA_BRAND.fonts.uiStack.replace(/"/g,'&quot;')}`;
        const fontWeight = (bl.font || '').includes('bold') ? '700' : '500';

        svgElements.push(`<text x="${textX}" y="${y}" text-anchor="${anchor}" font-family="${fontFamily}" font-weight="${fontWeight}" font-size="${fontSize}" fill="${textColor}" ${blFilterAttr}>${escapeXML(text)}</text>`);
      });
    }
  }

  // Website
  if (layout.website) {
    const ws = layout.website;
    const website = getConfig(tenant, 'website', '');
    if (website) {
      const wsColor = resolveColor(ws.color || 'black', useDarkText, '#1A1A1A', 'rgba(255,220,160,0.6)');
      const wsShadow = resolveShadow(ws.shadow);
      const wsFilterId = addShadowFilter('website', wsShadow);
      const wsFilterAttr = wsShadow ? `filter="url(#${wsFilterId})"` : '';
      const wsXA = getXAnchor(ws.position || 'center', width);
      const wsY = getStartY(ws.position || 'bottom', height);
      const wsFontSize = Math.floor(width * 0.024);
      svgElements.push(`<text x="${Math.floor(wsXA.x)}" y="${Math.floor(wsY)}" text-anchor="${wsXA.anchor}" font-family="${FGA_BRAND.fonts.uiStack.replace(/"/g,'&quot;')}" font-weight="500" font-size="${wsFontSize}" fill="${wsColor}" letter-spacing="2" ${wsFilterAttr}>${escapeXML(website.toUpperCase())}</text>`);
    }
  }

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs>${gradientDefs.join('')}${filterDefs.join('')}</defs>${svgElements.join('\n')}</svg>`;
}

// === COMPOSITING ===

async function addTextAndLogoOverlay(imagePath, { headline, subtext, body, bullets, slideTemplate, tenant }) {
  const branding = slideTemplate?.branding || {};
  const lightBg = await isImageLight(imagePath);
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  const { width, height } = metadata;
  const layers = [];

  // Text overlay
  const textSVG = buildTextOverlaySVG({ headline, subtext, body, bullets, width, height, slideTemplate, useDarkText: lightBg, tenant });
  layers.push({ input: Buffer.from(textSVG), top: 0, left: 0 });

  // Logo. Fallback path used to be `static/assets/logo.png` which doesn't
  // exist on disk — the actual checked-in logos live at worker/agents/assets.
  // Lookup order:
  //   1. tenant_config.logo_path (explicit override)
  //   2. assets/logo-<tenant.slug>.png (per-tenant logo committed to repo)
  //   3. assets/logo.png (legacy default — currently the WellMor logo)
  // Without the fix the `if fs.existsSync` guard silently skipped the logo on
  // every FGA post (because the legacy fallback path didn't exist at all).
  if (branding.logo) {
    const logoUrl = getConfig(tenant, 'logo_path', null);
    const tenantSpecificPath = tenant?.slug
      ? path.join(__dirname, 'assets', `logo-${tenant.slug}.png`)
      : null;
    const defaultPath = path.join(__dirname, 'assets', 'logo.png');
    const logoPath = logoUrl
      || (tenantSpecificPath && fs.existsSync(tenantSpecificPath) ? tenantSpecificPath : defaultPath);
    if (fs.existsSync(logoPath)) {
      const logoPos = branding.logo.position || 'bottom-right';
      const logoSizeKey = branding.logo.size || 'normal';
      const logoWidth = logoSizeKey === 'large' ? Math.floor(width * 0.25) : Math.floor(width * 0.16);
      // Tint support — `tint: 'white'` on dark backgrounds recolors the
      // logo so it stays visible. Sharp .tint() multiplies the source RGB
      // by the given color; combined with the existing alpha channel we
      // get a clean white-silhouette logo on Midnight without needing a
      // separate white-on-transparent asset.
      let logoPipeline = sharp(logoPath).resize({ width: logoWidth });
      if (branding.logo.tint === 'white') {
        logoPipeline = logoPipeline.tint('#FFFFFF');
      } else if (branding.logo.tint && branding.logo.tint !== 'default') {
        logoPipeline = logoPipeline.tint(branding.logo.tint);
      }
      const resizedLogoBuffer = await logoPipeline.png().toBuffer();
      const resizedLogoMeta = await sharp(resizedLogoBuffer).metadata();

      let logoLeft, logoTop;
      if (logoPos === 'top-center') {
        logoLeft = Math.floor((width - resizedLogoMeta.width) / 2);
        logoTop = Math.floor(height * 0.03);
      } else if (logoPos === 'bottom-left') {
        logoLeft = Math.floor(width * 0.05);
        logoTop = height - resizedLogoMeta.height - Math.floor(height * 0.04);
      } else {
        logoLeft = width - resizedLogoMeta.width - Math.floor(width * 0.05);
        logoTop = height - resizedLogoMeta.height - Math.floor(height * 0.04);
      }

      layers.push({ input: resizedLogoBuffer, left: logoLeft, top: logoTop });
    }
  }

  const outputPath = imagePath.replace('.png', '-branded.png');
  await image.composite(layers).png().toFile(outputPath);
  return outputPath;
}

// === MAIN FUNCTIONS ===

async function generateSlideImage(tenant, { headline, subtext, body, bullets, slide_role, slide_number, post_theme, formatTemplate, slideTemplate, focusIndustry }) {
  const log = createLogger('image-gen', tenant.slug);
  const safePrefix = slugify(`${tenant.slug}-f${formatTemplate?.id || 0}-s${slide_number}-${slide_role}`);
  const fileName = `${Date.now()}-${safePrefix}.png`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  const backgroundType = slideTemplate?.backgroundType || 'image';

  // Industry-subject substitution: resolve THIS week's focus industry to a
  // concrete subject directive that gets injected into Gemini prompts via
  // the {INDUSTRY_SUBJECT} placeholder. Falls back to a generic
  // small-business subject if the industry is unknown.
  const industrySubject = focusIndustry && INDUSTRY_IMAGE_SUBJECTS[focusIndustry]
    ? INDUSTRY_IMAGE_SUBJECTS[focusIndustry]
    : INDUSTRY_SUBJECT_FALLBACK;

  if (backgroundType === 'solid') {
    const bgPalette = slideTemplate?.bgPalette || {};
    const bgBuffer = await generateSolidBackground({
      bgColor: bgPalette.base || '#F5F0EB',
      gradientColor: bgPalette.gradient || bgPalette.base || '#FAF7F4',
    });
    fs.writeFileSync(filePath, bgBuffer);
    log.info(`Solid background for slide ${slide_number} (${slide_role})`);
  } else if (backgroundType === 'hybrid_photo_block') {
    // Premium magazine-cover layout: photo (top 60%) + solid color block
    // (bottom 40%) with a thin accent hairline between. Text lives only in
    // the bottom block (customY ≈ 0.65-0.90 in the format definition).
    const bgPalette = slideTemplate?.bgPalette || {};
    const styleGuidance = getConfig(
      tenant,
      'image_style_guidance',
      FGA_BRAND.imageStyle.styleGuidance,
    );
    const businessName = getConfig(tenant, 'business_name', FGA_BRAND.name);
    const rawPrompt = slideTemplate?.imagePrompt || '';
    const resolvedPrompt = rawPrompt.replace(/\{INDUSTRY_SUBJECT\}/g, industrySubject);
    const bgBuffer = await generateHybridPhotoBlock({
      imagePrompt: resolvedPrompt,
      blockColor: bgPalette.base || '#0B1120',
      accentColor: bgPalette.accent || '#16A34A',
      tenantSlug: tenant.slug,
      businessName,
      styleGuidance,
      postTheme: post_theme,
    });
    fs.writeFileSync(filePath, bgBuffer);
    log.info(`Hybrid photo+block background for slide ${slide_number} (${slide_role})`);
  } else {
    const businessName = getConfig(tenant, 'business_name', FGA_BRAND.name);
    // Tenant override wins; falls back to the codified FGA brand style
    // in core/brand.js. That's the same style documented on the marketing
    // site and brand guide, so every generated image is consistent with
    // firstgenautomate.com.
    const styleGuidance = getConfig(
      tenant,
      'image_style_guidance',
      FGA_BRAND.imageStyle.styleGuidance,
    );

    // Substitute {INDUSTRY_SUBJECT} placeholder in the slide's imagePrompt
    // before sending to Gemini. Formats using this placeholder will get a
    // photo that reflects THIS week's rotated industry (HVAC, Plumbing,
    // etc.) — see core/fga-content-formats.js INDUSTRY_IMAGE_SUBJECTS.
    const rawSlideHint = slideTemplate?.imagePrompt || '';
    const resolvedSlideHint = rawSlideHint.replace(/\{INDUSTRY_SUBJECT\}/g, industrySubject);

    const prompt = `Create a premium Instagram slide background image for ${businessName}.
This is slide ${slide_number}. Post theme: ${post_theme || 'business strategy'}
${focusIndustry ? `Industry focus this week: ${focusIndustry}` : ''}

CRITICAL: This image is a BACKGROUND. Text will be overlaid on top afterward.
Do NOT render any text, words, letters, or typography in the image.

BRAND STYLE:
${styleGuidance}

${resolvedSlideHint ? `SLIDE HINT: ${resolvedSlideHint}` : ''}

OUTPUT: Photorealistic or fine-art documentary photography. Instagram-optimized 4:5 portrait (1080x1350) — full bleed, primary subject centered safely within the middle 80% of the frame so it survives any IG crop variation.`;

    const rawBuffer = await geminiGenerate(prompt, { tenantSlug: tenant.slug, aspectRatio: '4:5' });
    // 2026-05-26: enforce exact 1080×1350 (4:5 IG portrait) at the
    // pipeline level even if Gemini drifts by a few pixels. cover-fit
    // crops minimally to fit the target without letterbox bars.
    const imageBuffer = await sharp(rawBuffer)
      .resize(1080, 1350, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
    fs.writeFileSync(filePath, imageBuffer);
    log.info(`Gemini image for slide ${slide_number} (${slide_role}) → normalized 1080×1350`);
  }

  const brandedPath = await addTextAndLogoOverlay(filePath, {
    headline: headline || '',
    subtext: subtext || '',
    body: body || '',
    bullets: bullets || [],
    slideTemplate,
    tenant
  });

  const brandedFileName = path.basename(brandedPath);

  // Upload to Supabase Storage
  const publicUrl = await uploadToStorage(brandedPath, brandedFileName, tenant.slug);

  return {
    file_name: brandedFileName,
    file_path: brandedPath,
    public_url: publicUrl,
    slide_role: slide_role || 'hook',
    slide_number: slide_number || 1
  };
}

async function generateCarouselImages(tenant, { slides, post_theme, formatTemplate, focusIndustry }) {
  const log = createLogger('image-gen', tenant.slug);

  if (!slides || slides.length === 0) throw new Error('No slides provided');

  if (focusIndustry) {
    log.info(`Industry-aware imagery for week's focus: ${focusIndustry}`);
  }

  const images = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const slideTemplate = formatTemplate?.slides?.[i] || formatTemplate?.slides?.[formatTemplate.slides.length - 1];

    log.info(`Slide ${slide.slide_number} (${slide.role}): "${slide.headline}"`);

    const image = await generateSlideImage(tenant, {
      headline: slide.headline,
      subtext: slide.subtext || '',
      body: slide.body || '',
      bullets: slide.bullets || [],
      slide_role: slide.role,
      slide_number: slide.slide_number,
      post_theme,
      formatTemplate,
      slideTemplate,
      focusIndustry,
    });

    images.push(image);
  }

  return images;
}

/**
 * Agent entry point (called by job processor)
 */
async function run(tenant, payload = {}) {
  const log = createLogger('image-gen', tenant.slug);

  if (payload.draftId) {
    // Generate images for an existing draft
    const { db } = require('../../db/client');
    const { data: draft } = await db.from('content_drafts').select('*').eq('id', payload.draftId).single();
    if (!draft) throw new Error(`Draft not found: ${payload.draftId}`);

    const campaign = draft.campaign_payload || {};
    const content = campaign.content || {};

    // 2026-05-26: prefer the LIVE format definition over the snapshot
    // stored on the draft. Without this, regenerating an older draft
    // re-uses the stale formatTemplate that was saved when the draft
    // was first created, and any subsequent format improvements
    // (new backgroundTypes, new color palettes, layout fixes) never
    // get applied to historical drafts. Falls back to the snapshot
    // only when the format id isn't resolvable (e.g. format was
    // deleted from the codebase).
    const liveFormat = getFormatById(draft.format_template) || getFormatById(campaign.formatTemplate?.id);
    const formatTemplate = liveFormat || campaign.formatTemplate;
    if (liveFormat) {
      log.info(`Using LIVE format definition for ${draft.format_template} (snapshot ignored)`);
    } else {
      log.warn(`Could not resolve live format for ${draft.format_template}; using stored snapshot`);
    }

    const images = await generateCarouselImages(tenant, {
      slides: content.slides,
      post_theme: content.post_theme,
      formatTemplate
    });

    await db.from('content_drafts').update({
      image_urls: images.map(img => img.public_url || img.file_name),
      campaign_payload: {
        ...campaign,
        carousel_images: images,
      },
      updated_at: new Date().toISOString()
    }).eq('id', payload.draftId);

    return { images: images.length };
  }

  return { error: 'No draftId provided' };
}

module.exports = run;
module.exports.generateCarouselImages = generateCarouselImages;
module.exports.generateSlideImage = generateSlideImage;
