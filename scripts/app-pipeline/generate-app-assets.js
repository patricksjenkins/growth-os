/**
 * Growth OS — App Asset Generator (Phase 1)
 *
 * Generates the per-client app icon and App Store listing copy for a
 * branded customer mobile app. Reads tenant intake data + brand config
 * from `tenant_config`, runs Gemini for the icon, Claude for the
 * listing text, and stores results back under
 * `tenant_config.app_assets.*` keys plus PNG files on disk under
 * `/tenants/<slug>/app-assets/`.
 *
 * What Phase 1 generates:
 *   - app_icon_1024.png (Apple requires 1024×1024, no alpha, no rounded corners)
 *   - listing_description.txt (4000 char limit)
 *   - listing_keywords.txt (100 char limit, comma-separated)
 *   - listing_promo_text.txt (170 char limit)
 *   - listing_subtitle.txt (30 char limit)
 *
 * Phase 2 will add: splash screen, App Store screenshots.
 *
 * Usage:
 *   node scripts/app-pipeline/generate-app-assets.js --tenant <slug>
 *   node scripts/app-pipeline/generate-app-assets.js --tenant <slug> --only icon
 *   node scripts/app-pipeline/generate-app-assets.js --tenant <slug> --only copy
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../../db/client');
const { generateImage } = require('../../integrations/gemini');
const { askClaude } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');

const log = createLogger('app-pipeline:assets');

// ---------- CLI args ----------

function parseArgs() {
  const args = { tenant: null, only: 'all' };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--tenant' && process.argv[i + 1]) {
      args.tenant = process.argv[++i];
    } else if (a === '--only' && process.argv[i + 1]) {
      args.only = process.argv[++i];
    }
  }
  if (!args.tenant) {
    console.error('Usage: node generate-app-assets.js --tenant <slug> [--only icon|copy|all]');
    process.exit(1);
  }
  return args;
}

// ---------- Helpers ----------

async function loadTenant(slug) {
  const { data: tenant, error } = await db
    .from('tenants')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error || !tenant) {
    throw new Error(`Tenant not found: ${slug}`);
  }
  const { data: configRows } = await db
    .from('tenant_config')
    .select('key, value')
    .eq('tenant_id', tenant.id);
  const config = {};
  for (const row of configRows || []) config[row.key] = row.value;
  return { tenant, config };
}

async function saveConfig(tenantId, key, value) {
  await db.from('tenant_config').upsert(
    { tenant_id: tenantId, key, value: String(value).slice(0, 8000) },
    { onConflict: 'tenant_id,key' }
  );
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getOutputDir(slug) {
  const dir = path.join(__dirname, '..', '..', 'tenants', slug, 'app-assets');
  ensureDir(dir);
  return dir;
}

// ---------- Icon generator ----------

function buildIconPrompt({ businessName, vertical, primaryColor, accentColor }) {
  // Apple icon requirements: 1024x1024, no alpha, no rounded corners
  // (iOS applies them automatically), no overlaid text in tiny font.
  // We aim for a recognizable, simple mark that reads at 60px and
  // 1024px equally well.
  const verticalCue = {
    hvac: 'a stylized HVAC element (heat pump fan, vent grille, or temperature gauge)',
    plumbing: 'a stylized plumbing element (pipe joint, wrench silhouette, or water drop)',
    electrical: 'a stylized electrical element (lightning bolt, plug, or panel breaker)',
    roofing: 'a stylized roofing element (rooftop silhouette or shingle pattern)',
    tree_service: 'a stylized tree element (silhouette of a mature tree or pine)',
    cleaning: 'a stylized cleaning element (sparkle or microfiber pattern)',
    home_services: 'a stylized tool element (wrench, hammer, or service icon)',
  }[(vertical || '').toLowerCase()] || 'a stylized service-trade element';

  return `Generate a 1024×1024 mobile app icon for "${businessName}".

CRITICAL APPLE REQUIREMENTS:
- Exact dimensions: 1024 × 1024 pixels, square.
- Solid background. NO transparency. NO alpha channel.
- NO rounded corners (iOS applies them automatically — your output must be a full square).
- NO small text or words that wouldn't read at 60×60 pixels.
- High contrast. Looks crisp at small sizes.

DESIGN BRIEF:
- Subject: ${verticalCue}. Simple, iconic, modern.
- Primary color: ${primaryColor || '#132A4A'} (solid background or main mark).
- Accent color: ${accentColor || '#22C55E'} (one accent element only).
- Style: flat / minimal / vector-like (NOT photorealistic, NOT 3D, NOT cluttered).
- The icon should feel like a real trade-services brand mark — not generic clipart.

DO NOT include the business name as text in the icon — Apple shows the app name beneath the icon automatically.`;
}

async function generateIcon({ tenant, config, outDir }) {
  const businessName = tenant.name;
  const vertical = tenant.vertical;
  const primaryColor = config.color_primary || '#132A4A';
  const accentColor = config.color_secondary || '#22C55E';

  log.info(`Generating app icon for "${businessName}" (${vertical})`);

  const prompt = buildIconPrompt({ businessName, vertical, primaryColor, accentColor });
  const buffer = await generateImage(prompt, { tenantSlug: tenant.slug });

  const outPath = path.join(outDir, 'app_icon_1024.png');
  fs.writeFileSync(outPath, buffer);

  log.success(`Icon saved: ${outPath} (${buffer.length} bytes)`);
  return outPath;
}

// ---------- Listing copy generator ----------

function buildListingSystemPrompt() {
  return `You write App Store listing copy for branded mobile apps that small service-trade businesses use to run their operations.

Each app is a real B2B custom build — NOT a clone, NOT a template. The copy you write must feel like it was written specifically for THIS business, mentioning THEIR services, THEIR service area, and THEIR vertical.

VOICE: Plain-spoken, owner-operator tone. Not corporate. Not techy. Talks to a tradesperson, not a marketer.

OUTPUT FORMAT: Strict JSON with these keys exactly:
{
  "subtitle": "max 30 chars",
  "promo_text": "max 170 chars",
  "description": "300-3500 chars, plain prose with line breaks",
  "keywords": "max 100 chars, comma-separated, lowercase"
}

CRITICAL RULES:
- Mention the business's actual name in the description at least twice
- Mention the actual vertical (HVAC / plumbing / electrical / etc.) at least once
- Mention the service area in the description
- Do NOT use the phrase "Growth OS" or "FGA" or "First Gen Automate" anywhere
- Description must read like a real B2B app description Apple would approve under Section 4.2.6 — not a SaaS shell
- Keywords: lowercase, comma-separated, no spaces after commas to maximize the 100-char budget`;
}

function buildListingUserPrompt({ businessName, vertical, serviceArea, services, ownerName }) {
  return `Write App Store listing copy for the branded mobile app belonging to:

Business: ${businessName}
Owner: ${ownerName || 'the owner'}
Vertical: ${vertical}
Service area: ${serviceArea || 'the local market'}
Services offered: ${services || 'standard ' + vertical + ' services'}

The app is what ${businessName} uses to:
- Manage incoming leads from their website, calls, and ads
- Send fast text-back replies when they can't pick up
- Approve social media posts the system writes from job site photos
- Ask happy customers for Google reviews
- Track their pipeline and accounts

Write the JSON object now.`;
}

function safeJsonParse(text) {
  // Claude sometimes wraps JSON in fences or adds prose. Strip both.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  // Find the first { and last } to be tolerant
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new Error('No JSON object found in Claude response');
  }
  return JSON.parse(candidate.slice(first, last + 1));
}

function clampField(value, max, name) {
  const v = String(value || '').trim();
  if (v.length > max) {
    log.warn(`${name} too long (${v.length}/${max}) — truncating`);
    return v.slice(0, max);
  }
  return v;
}

async function generateListingCopy({ tenant, config, outDir }) {
  const businessName = tenant.name;
  const vertical = tenant.vertical;
  const serviceArea = config.service_area || '';
  const services = config.key_services || '';
  const ownerName = config.owner_name || '';

  log.info(`Generating listing copy for "${businessName}"`);

  const system = buildListingSystemPrompt();
  const user = buildListingUserPrompt({
    businessName, vertical, serviceArea, services, ownerName,
  });

  const raw = await askClaude(system, user, {
    maxTokens: 2048, temperature: 0.7, tenantSlug: tenant.slug,
  });

  let parsed;
  try {
    parsed = safeJsonParse(raw);
  } catch (err) {
    log.error(`Claude JSON parse failed: ${err.message}`);
    throw err;
  }

  const result = {
    subtitle: clampField(parsed.subtitle, 30, 'subtitle'),
    promo_text: clampField(parsed.promo_text, 170, 'promo_text'),
    description: clampField(parsed.description, 4000, 'description'),
    keywords: clampField(parsed.keywords, 100, 'keywords'),
  };

  // Persist as individual files for easy human review + as one JSON manifest
  fs.writeFileSync(path.join(outDir, 'listing_subtitle.txt'), result.subtitle);
  fs.writeFileSync(path.join(outDir, 'listing_promo_text.txt'), result.promo_text);
  fs.writeFileSync(path.join(outDir, 'listing_description.txt'), result.description);
  fs.writeFileSync(path.join(outDir, 'listing_keywords.txt'), result.keywords);
  fs.writeFileSync(
    path.join(outDir, 'listing.json'),
    JSON.stringify(result, null, 2)
  );

  log.success('Listing copy saved');
  return result;
}

// ---------- Main ----------

async function main() {
  const args = parseArgs();
  const { tenant, config } = await loadTenant(args.tenant);
  const outDir = getOutputDir(tenant.slug);

  log.info(`App asset generation for ${tenant.name} (${tenant.slug})`);
  log.info(`Output directory: ${outDir}`);

  const manifest = { tenant_id: tenant.id, slug: tenant.slug, generated_at: new Date().toISOString() };

  if (args.only === 'all' || args.only === 'icon') {
    manifest.icon_path = await generateIcon({ tenant, config, outDir });
  }

  if (args.only === 'all' || args.only === 'copy') {
    manifest.listing = await generateListingCopy({ tenant, config, outDir });
  }

  // Write top-level manifest + record in tenant_config
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await saveConfig(tenant.id, 'app_assets_manifest', JSON.stringify(manifest));

  log.success(`Done. Manifest at ${path.join(outDir, 'manifest.json')}`);
}

main().catch((err) => {
  log.error(`Asset generation failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
