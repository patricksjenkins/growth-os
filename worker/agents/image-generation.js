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
  if (position && (position.includes('right'))) return { x: Math.floor(width * 0.90), anchor: 'end', headlineMaxChars: 20, bodyMaxChars: 38 };
  if (position && (position.includes('left'))) return { x: Math.floor(width * 0.08), anchor: 'start', headlineMaxChars: 20, bodyMaxChars: 38 };
  if (position && position.includes('center')) return { x: Math.floor(width * 0.50), anchor: 'middle', headlineMaxChars: 20, bodyMaxChars: 36 };
  return { x: Math.floor(width * 0.50), anchor: 'middle', headlineMaxChars: 26, bodyMaxChars: 36 };
}

function getStartY(position, height) {
  if (!position) return Math.floor(height * 0.15);
  if (position.includes('upper')) return Math.floor(height * 0.13);
  if (position.includes('lower')) return Math.floor(height * 0.58);
  if (position.includes('bottom')) return Math.floor(height * 0.88);
  if (position.includes('center')) return Math.floor(height * 0.35);
  return Math.floor(height * 0.15);
}

// === SOLID BACKGROUND ===

async function generateSolidBackground({ bgColor, gradientColor, size = 1024 }) {
  const bg = bgColor || '#F5F0EB';
  const grad = gradientColor || bg;
  const svgBg = `
  <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="40%" r="80%">
        <stop offset="0%" stop-color="${grad}"/>
        <stop offset="100%" stop-color="${bg}"/>
      </radialGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bg)"/>
  </svg>`;
  return sharp(Buffer.from(svgBg)).png().toBuffer();
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
    let fontFamily = "'Helvetica Neue', Helvetica, Arial, sans-serif";
    let fontWeightVal = '400';
    if (fontDef) {
      if (fontDef.includes('serif') && !fontDef.includes('sans')) fontFamily = "Georgia, 'Times New Roman', serif";
      if (fontDef.includes('bold')) fontWeightVal = '700';
      if (fontDef.includes('semibold')) fontWeightVal = '600';
    }
    const defaultChars = isHeadline ? (xa.headlineMaxChars || 26) : (xa.bodyMaxChars || 36);
    const chars = maxChars || defaultChars;
    const lines = wrapText(text, chars);
    const limitedLines = maxLines ? lines.slice(0, maxLines) : lines;
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

  // Brand header (tenant-configurable)
  const brandName = getConfig(tenant, 'business_name', '').toUpperCase();
  if (branding.wellmorBenefits && brandName) {
    const pos = branding.wellmorBenefits.position || 'top-center';
    const brandColor = resolveColor(branding.wellmorBenefits.color || 'black', useDarkText, '#1A1A1A', '#1A1A1A');
    const brandFontSize = Math.floor(width * 0.028);
    const brandX = Math.floor(width * 0.50);
    const brandY = pos.includes('bottom') ? Math.floor(height * 0.94) : Math.floor(height * 0.055);
    svgElements.push(`<text x="${brandX}" y="${brandY}" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="500" font-size="${brandFontSize}" fill="${brandColor}" letter-spacing="3">${escapeXML(brandName)}</text>`);
    if (pos.includes('top')) currentY = Math.floor(height * 0.10);
  } else {
    currentY = Math.floor(height * 0.08);
  }

  // Headline
  if (layout.headline && headline) {
    const hl = layout.headline;
    const isLarge = hl.font && (hl.font.includes('large') || hl.font.includes('bold'));
    const fSize = isLarge ? Math.floor(width * 0.062) : Math.floor(width * 0.050);
    renderTextBlock({ text: headline, positionKey: hl.position || 'center', colorDef: hl.color, fontDef: hl.font || 'bold serif', shadowDef: hl.shadow, fontSize: fSize, maxChars: hl.maxChars, maxLines: hl.maxLines, isFirstInGroup: true });
  }

  // Divider
  if (layout.divider || (layout.body && body)) {
    renderDivider(layout.headline?.position || 'center');
  }

  // Subtitle
  if (layout.subtitle && subtext) {
    renderTextBlock({ text: subtext, positionKey: layout.subtitle.position || 'center', colorDef: layout.subtitle.color, fontDef: layout.subtitle.font || 'italic serif', shadowDef: layout.subtitle.shadow, isFirstInGroup: false });
  }

  // Body
  if (layout.body && body) {
    const bodyPosKey = layout.body.position || layout.headline?.position || 'center';
    const bodyFontSize = Math.floor(width * 0.033);
    const bodyLineH = bodyFontSize * 1.50;
    const bottomMargin = Math.floor(height * 0.18);
    const availableSpace = height - currentY - bottomMargin;
    const safeMaxLines = Math.max(3, Math.floor(availableSpace / bodyLineH));
    renderTextBlock({ text: body, positionKey: bodyPosKey, colorDef: layout.body.color, fontDef: layout.body.font || 'regular sans', shadowDef: layout.body.shadow, maxLines: layout.body.maxLines || safeMaxLines, isFirstInGroup: false });
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
      svgElements.push(`<text x="${Math.floor(wsXA.x)}" y="${Math.floor(wsY)}" text-anchor="${wsXA.anchor}" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-weight="500" font-size="${wsFontSize}" fill="${wsColor}" letter-spacing="2" ${wsFilterAttr}>${escapeXML(website.toUpperCase())}</text>`);
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

  // Logo
  if (branding.logo) {
    const logoUrl = getConfig(tenant, 'logo_path', null);
    const logoPath = logoUrl || path.join(__dirname, '..', '..', 'static', 'assets', 'logo.png');
    if (fs.existsSync(logoPath)) {
      const logoPos = branding.logo.position || 'bottom-right';
      const logoSizeKey = branding.logo.size || 'normal';
      const logoWidth = logoSizeKey === 'large' ? Math.floor(width * 0.25) : Math.floor(width * 0.16);
      const resizedLogoBuffer = await sharp(logoPath).resize({ width: logoWidth }).png().toBuffer();
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

async function generateSlideImage(tenant, { headline, subtext, body, bullets, slide_role, slide_number, post_theme, formatTemplate, slideTemplate }) {
  const log = createLogger('image-gen', tenant.slug);
  const safePrefix = slugify(`${tenant.slug}-f${formatTemplate?.id || 0}-s${slide_number}-${slide_role}`);
  const fileName = `${Date.now()}-${safePrefix}.png`;
  const filePath = path.join(OUTPUT_DIR, fileName);

  const backgroundType = slideTemplate?.backgroundType || 'image';

  if (backgroundType === 'solid') {
    const bgPalette = slideTemplate?.bgPalette || {};
    const bgBuffer = await generateSolidBackground({
      bgColor: bgPalette.base || '#F5F0EB',
      gradientColor: bgPalette.gradient || bgPalette.base || '#FAF7F4',
    });
    fs.writeFileSync(filePath, bgBuffer);
    log.info(`Solid background for slide ${slide_number} (${slide_role})`);
  } else {
    const businessName = getConfig(tenant, 'business_name', 'Our Company');
    const prompt = `Create a premium Instagram slide background image for ${businessName}.
This is slide ${slide_number}. Post theme: ${post_theme || 'business strategy'}

CRITICAL: This image is a BACKGROUND. Text will be overlaid on top afterward.
Do NOT render any text, words, letters, or typography in the image.

${slideTemplate?.imagePrompt || ''}

QUALITY: Photorealistic or high-end artistic. Instagram-optimized. Square format (1080x1080).
STRICTLY AVOID: Any text, words, letters, cartoons, clipart, generic stock photos.`;

    const imageBuffer = await geminiGenerate(prompt, { tenantSlug: tenant.slug });
    fs.writeFileSync(filePath, imageBuffer);
    log.info(`Gemini image for slide ${slide_number} (${slide_role})`);
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

async function generateCarouselImages(tenant, { slides, post_theme, formatTemplate }) {
  const log = createLogger('image-gen', tenant.slug);

  if (!slides || slides.length === 0) throw new Error('No slides provided');

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
      slideTemplate
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
    const formatTemplate = campaign.formatTemplate;

    const images = await generateCarouselImages(tenant, {
      slides: content.slides,
      post_theme: content.post_theme,
      formatTemplate
    });

    await db.from('content_drafts').update({
      image_urls: images.map(img => img.file_name),
      updated_at: new Date().toISOString()
    }).eq('id', payload.draftId);

    return { images: images.length };
  }

  return { error: 'No draftId provided' };
}

module.exports = run;
module.exports.generateCarouselImages = generateCarouselImages;
module.exports.generateSlideImage = generateSlideImage;
