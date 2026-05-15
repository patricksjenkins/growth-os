/**
 * Growth OS — App Build Config Patcher
 *
 * Patches the mobile-app/app.json file with per-tenant values so the
 * next Expo prebuild produces a customer-branded iOS app instead of
 * the FGA-internal app. Also copies the generated app icon into the
 * mobile app's asset directory so Expo picks it up.
 *
 * Before running this for a customer, run generate-app-assets.js so
 * the icon + listing copy already exist in tenants/<slug>/app-assets/.
 *
 * What it patches in app.json:
 *   - expo.name                       = business name
 *   - expo.slug                       = tenant slug
 *   - expo.ios.bundleIdentifier       = depends on --path flag (see below)
 *   - expo.icon                       = path to per-tenant icon
 *   - expo.version                    = '1.0.0' (new app, start fresh)
 *   - expo.ios.buildNumber            = '1' (new app, start fresh)
 *
 * Bundle ID by path:
 *   --path managed  =>  com.firstgenautomate.<safe-slug>   (FGA's developer account)
 *   --path owned    =>  com.<safe-slug>.app                (customer's developer account)
 *
 * Default path is 'managed' (Path A — the "Quick Start" choice). This
 * matches the intake form default. Tenants on Path B must pass
 * --path owned explicitly (or have delivery_path='owned' in tenant_config —
 * the script reads that as fallback if --path is not provided).
 *
 * Safety:
 *   - Creates app.json.fga-default backup the first time you run it
 *     (or any time the current app.json is the FGA-internal one)
 *   - Refuses to overwrite an existing per-tenant config without --force
 *
 * Usage:
 *   node scripts/app-pipeline/patch-build-config.js --tenant <slug>
 *   node scripts/app-pipeline/patch-build-config.js --tenant <slug> --force
 *   node scripts/app-pipeline/patch-build-config.js --restore-default
 *
 * MOBILE_APP_PATH env var overrides the default
 * /Users/patrickjenkins/Desktop/FGA/mobile-app path.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('app-pipeline:patch');

const MOBILE_APP_PATH =
  process.env.MOBILE_APP_PATH ||
  '/Users/patrickjenkins/Desktop/FGA/mobile-app';

const APP_JSON_PATH = path.join(MOBILE_APP_PATH, 'app.json');
const APP_JSON_BACKUP = path.join(MOBILE_APP_PATH, 'app.json.fga-default');
const ASSETS_DIR = path.join(MOBILE_APP_PATH, 'assets');

const FGA_INTERNAL_BUNDLE_ID = 'com.firstgenautomate.app';
const FGA_INTERNAL_SLUG = 'firstgenautomate';

// ---------- CLI args ----------

function parseArgs() {
  const args = { tenant: null, force: false, restoreDefault: false, path: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--tenant' && process.argv[i + 1]) {
      args.tenant = process.argv[++i];
    } else if (a === '--force') {
      args.force = true;
    } else if (a === '--restore-default') {
      args.restoreDefault = true;
    } else if (a === '--path' && process.argv[i + 1]) {
      args.path = process.argv[++i];
    }
  }
  if (!args.tenant && !args.restoreDefault) {
    console.error('Usage: node patch-build-config.js --tenant <slug> [--path managed|owned] [--force]');
    console.error('       node patch-build-config.js --restore-default');
    process.exit(1);
  }
  if (args.path && !['managed', 'owned'].includes(args.path)) {
    console.error(`--path must be 'managed' or 'owned' (got '${args.path}')`);
    process.exit(1);
  }
  return args;
}

/**
 * Build the per-path bundle ID. The slug is collapsed to lowercase
 * alphanumeric (Apple requirement).
 */
function bundleIdForPath(slug, deliveryPath) {
  const safe = bundleSafe(slug);
  return deliveryPath === 'owned'
    ? `com.${safe}.app`
    : `com.firstgenautomate.${safe}`;
}

// ---------- Helpers ----------

async function loadTenant(slug) {
  const { data: tenant, error } = await db
    .from('tenants').select('*').eq('slug', slug).maybeSingle();
  if (error || !tenant) throw new Error(`Tenant not found: ${slug}`);
  const { data: configRows } = await db
    .from('tenant_config').select('key, value').eq('tenant_id', tenant.id);
  const config = {};
  for (const row of configRows || []) config[row.key] = row.value;
  return { tenant, config };
}

/**
 * Resolve the delivery path in priority order:
 *   1. --path CLI flag if provided
 *   2. tenant_config.delivery_path if set
 *   3. 'managed' default (Path A is the new default — matches intake form)
 */
function resolvePath(cliFlag, config) {
  if (cliFlag) return cliFlag;
  const fromConfig = (config.delivery_path || '').toLowerCase();
  if (fromConfig === 'managed' || fromConfig === 'owned') return fromConfig;
  return 'managed';
}

function readAppJson() {
  if (!fs.existsSync(APP_JSON_PATH)) {
    throw new Error(`app.json not found at ${APP_JSON_PATH}. Set MOBILE_APP_PATH if the path is different.`);
  }
  return JSON.parse(fs.readFileSync(APP_JSON_PATH, 'utf8'));
}

function writeAppJson(obj) {
  fs.writeFileSync(APP_JSON_PATH, JSON.stringify(obj, null, 2) + '\n');
}

function backupIfInternal() {
  const current = readAppJson();
  const isInternal = current.expo?.ios?.bundleIdentifier === FGA_INTERNAL_BUNDLE_ID
                     || current.expo?.slug === FGA_INTERNAL_SLUG;
  if (isInternal && !fs.existsSync(APP_JSON_BACKUP)) {
    fs.copyFileSync(APP_JSON_PATH, APP_JSON_BACKUP);
    log.info(`Backed up FGA-internal app.json to ${APP_JSON_BACKUP}`);
  }
  return isInternal;
}

/**
 * Convert a tenant slug like "akut-above-services" to a bundle-safe
 * fragment like "akutaboveservices". Apple bundle IDs may not contain
 * hyphens in the suffix; lowercase alphanumeric is safest.
 */
function bundleSafe(slug) {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function copyIconIntoAppAssets(tenantSlug) {
  const src = path.join(
    __dirname, '..', '..', 'tenants', tenantSlug, 'app-assets', 'app_icon_1024.png'
  );
  if (!fs.existsSync(src)) {
    log.warn(`No generated icon found at ${src}. Run generate-app-assets.js first if you want a custom icon.`);
    return null;
  }
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const dest = path.join(ASSETS_DIR, 'icon.png');
  fs.copyFileSync(src, dest);
  log.info(`Copied icon: ${src} -> ${dest}`);
  return './assets/icon.png';
}

// ---------- Patch / restore ----------

async function patchForTenant(slug, force, cliPath) {
  const { tenant, config } = await loadTenant(slug);
  const deliveryPath = resolvePath(cliPath, config);

  // Backup if we're sitting on the FGA-internal config and haven't backed up yet
  const wasInternal = backupIfInternal();

  const current = readAppJson();
  const currentBundle = current.expo?.ios?.bundleIdentifier;

  // Refuse to overwrite an existing per-tenant config unless --force.
  // "Per-tenant" = bundle ID is neither FGA-internal nor the target.
  const targetBundle = bundleIdForPath(tenant.slug, deliveryPath);
  if (!wasInternal && currentBundle !== targetBundle && currentBundle !== FGA_INTERNAL_BUNDLE_ID && !force) {
    throw new Error(
      `app.json is already patched for a different tenant (${currentBundle}). ` +
      `Use --restore-default first, or pass --force.`
    );
  }

  // Build the patched config
  const patched = JSON.parse(JSON.stringify(current));
  patched.expo = patched.expo || {};
  patched.expo.name = tenant.name;
  patched.expo.slug = tenant.slug;
  patched.expo.version = '1.0.0';
  patched.expo.ios = patched.expo.ios || {};
  patched.expo.ios.bundleIdentifier = targetBundle;
  patched.expo.ios.buildNumber = '1';

  // Copy and reference the per-tenant icon
  const iconRef = copyIconIntoAppAssets(tenant.slug);
  if (iconRef) patched.expo.icon = iconRef;

  writeAppJson(patched);

  log.success(`Patched app.json for ${tenant.name}`);
  log.info(`  Delivery path: ${deliveryPath} (${deliveryPath === 'managed' ? 'FGA developer account' : "customer's developer account"})`);
  log.info(`  Bundle ID:     ${targetBundle}`);
  log.info(`  App name:      ${tenant.name}`);
  log.info(`  Slug:          ${tenant.slug}`);
  log.info(`  Icon:          ${iconRef || '(not changed)'}`);
  log.info('');
  log.info('Next steps:');
  log.info('  1. cd ' + MOBILE_APP_PATH);
  log.info('  2. npx expo prebuild --clean');
  if (deliveryPath === 'managed') {
    log.info('  3. Follow fga-testflight-deploy skill (FGA team ID 6Y8873V85M)');
  } else {
    log.info(`  3. Follow fga-testflight-deploy skill — use customer's Apple team ID`);
    log.info(`     (set in tenant_secrets.apple_team_id for ${tenant.slug})`);
  }
}

function restoreDefault() {
  if (!fs.existsSync(APP_JSON_BACKUP)) {
    throw new Error(`No FGA-internal backup found at ${APP_JSON_BACKUP}.`);
  }
  fs.copyFileSync(APP_JSON_BACKUP, APP_JSON_PATH);
  log.success(`Restored FGA-internal app.json from ${APP_JSON_BACKUP}`);
}

// ---------- Main ----------

async function main() {
  const args = parseArgs();
  if (args.restoreDefault) {
    restoreDefault();
    return;
  }
  await patchForTenant(args.tenant, args.force, args.path);
}

main().catch((err) => {
  log.error(`Patch failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
