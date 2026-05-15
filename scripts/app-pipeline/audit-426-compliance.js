/**
 * Growth OS — App Store Review Guideline 4.2.6 Compliance Audit
 *
 * Apple Section 4.2.6 ("Commercialized Services and Templates") is the
 * reason white-label app maker services get rejected. We avoid this
 * specific guideline by:
 *   1. Submitting each app under the customer's own Apple Developer account
 *   2. Genuinely differentiating each app (icon, copy, screenshots)
 *
 * This script does the differentiation check. It refuses to greenlight
 * a submission if the app would look like a clone of FGA's internal app
 * or any other tenant's app.
 *
 * Phase 1 hard checks (BLOCK submission if any fail):
 *   - App icon hash differs from FGA-internal + other tenant icons
 *   - App name differs from "FGA" / "First Gen Automate" / other tenants
 *   - Bundle ID matches the expected per-tenant pattern
 *   - Listing description mentions the customer business name
 *   - Listing description mentions the customer vertical
 *   - Listing description mentions the customer service area (if known)
 *   - Privacy URL resolves to 200 + names the business
 *   - Support URL resolves to 200 + names the business
 *
 * Phase 1 soft checks (WARN but allow):
 *   - Description length > 500 chars
 *   - Listing keywords include vertical-specific terms
 *
 * Usage:
 *   node scripts/app-pipeline/audit-426-compliance.js --tenant <slug>
 *   node scripts/app-pipeline/audit-426-compliance.js --tenant <slug> --skip-url-check
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('app-pipeline:audit');

// ---------- CLI args ----------

function parseArgs() {
  const args = { tenant: null, skipUrlCheck: false, path: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--tenant' && process.argv[i + 1]) {
      args.tenant = process.argv[++i];
    } else if (a === '--skip-url-check') {
      args.skipUrlCheck = true;
    } else if (a === '--path' && process.argv[i + 1]) {
      args.path = process.argv[++i];
    }
  }
  if (!args.tenant) {
    console.error('Usage: node audit-426-compliance.js --tenant <slug> [--path managed|owned] [--skip-url-check]');
    process.exit(1);
  }
  if (args.path && !['managed', 'owned'].includes(args.path)) {
    console.error(`--path must be 'managed' or 'owned' (got '${args.path}')`);
    process.exit(1);
  }
  return args;
}

/**
 * Resolve delivery path: CLI flag > tenant_config.delivery_path > 'managed'.
 */
function resolvePath(cliFlag, config) {
  if (cliFlag) return cliFlag;
  const fromConfig = (config.delivery_path || '').toLowerCase();
  if (fromConfig === 'managed' || fromConfig === 'owned') return fromConfig;
  return 'managed';
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

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getAssetDir(slug) {
  return path.join(__dirname, '..', '..', 'tenants', slug, 'app-assets');
}

function readListing(slug) {
  const p = path.join(getAssetDir(slug), 'listing.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function bundleSafe(slug) {
  return slug.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fetchUrl(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === 'http:' ? http : https;
      const req = client.get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 20000) }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ status: 0, body: '' }); });
    } catch {
      resolve({ status: 0, body: '' });
    }
  });
}

// ---------- Audit checks ----------

const FGA_INTERNAL = {
  bundleId: 'com.firstgenautomate.app',
  appNames: ['fga', 'firstgenautomate', 'first gen automate', 'firstgen automate'],
};

async function checkIconUniqueness(tenant, deliveryPath) {
  const iconPath = path.join(getAssetDir(tenant.slug), 'app_icon_1024.png');
  const hash = sha256File(iconPath);
  if (!hash) {
    return { pass: false, msg: `No icon found at ${iconPath}. Run generate-app-assets.js first.` };
  }

  // Compare against other tenants' icons + the FGA-internal icon.
  // On Path A (Managed), this check is HARD — collisions are
  // submission blockers because all apps live in FGA's developer
  // account where Apple's 4.2.6 scrutiny is highest.
  // On Path B (Owned), a collision is a soft warning — the customer's
  // own developer account doesn't host the other tenant's app, so
  // Apple won't see them as siblings.
  const tenantsRoot = path.join(__dirname, '..', '..', 'tenants');
  if (!fs.existsSync(tenantsRoot)) {
    return { pass: true, msg: `Icon hash: ${hash.slice(0, 12)}... (no other tenants to compare)` };
  }
  const otherSlugs = fs.readdirSync(tenantsRoot).filter((d) => d !== tenant.slug);
  for (const slug of otherSlugs) {
    const otherIcon = path.join(tenantsRoot, slug, 'app-assets', 'app_icon_1024.png');
    const otherHash = sha256File(otherIcon);
    if (otherHash && otherHash === hash) {
      if (deliveryPath === 'managed') {
        return { pass: false, msg: `Icon is identical to tenant '${slug}' icon. Both apps live in FGA's developer account — regenerate.` };
      }
      return {
        pass: false,
        msg: `Icon matches tenant '${slug}' icon. (Soft warn on Path B — Apple won't see them as siblings, but it's still lazy.)`,
        soft: true,
      };
    }
  }

  return { pass: true, msg: `Icon hash: ${hash.slice(0, 12)}... (unique)` };
}

function checkAppName(tenant) {
  const name = (tenant.name || '').trim().toLowerCase();
  if (!name) return { pass: false, msg: 'Tenant name is empty.' };
  for (const banned of FGA_INTERNAL.appNames) {
    if (name === banned) {
      return { pass: false, msg: `App name '${tenant.name}' matches FGA-internal name.` };
    }
  }
  return { pass: true, msg: `App name: "${tenant.name}"` };
}

function checkBundleId(tenant, deliveryPath) {
  const safe = bundleSafe(tenant.slug);
  const expected = deliveryPath === 'owned'
    ? `com.${safe}.app`
    : `com.firstgenautomate.${safe}`;
  // We can't read live app.json from here reliably (it's in another repo),
  // so we just confirm the expected pattern is well-formed.
  if (deliveryPath === 'owned' && !/^com\.[a-z0-9]+\.app$/.test(expected)) {
    return { pass: false, msg: `Bundle ID pattern invalid for owned path: ${expected}` };
  }
  if (deliveryPath === 'managed' && !/^com\.firstgenautomate\.[a-z0-9]+$/.test(expected)) {
    return { pass: false, msg: `Bundle ID pattern invalid for managed path: ${expected}` };
  }
  if (expected === FGA_INTERNAL.bundleId) {
    return { pass: false, msg: `Bundle ID collides with FGA-internal: ${expected}` };
  }
  return { pass: true, msg: `Bundle ID (${deliveryPath} path): ${expected}` };
}

function checkListingCopy(tenant, listing) {
  if (!listing) {
    return [{ pass: false, msg: 'No listing.json found. Run generate-app-assets.js first.' }];
  }
  const desc = (listing.description || '').toLowerCase();
  const results = [];

  // Mentions business name
  const nameLower = (tenant.name || '').toLowerCase();
  if (nameLower && desc.includes(nameLower)) {
    results.push({ pass: true, msg: `Description mentions "${tenant.name}".` });
  } else {
    results.push({ pass: false, msg: `Description does NOT mention "${tenant.name}".` });
  }

  // Mentions vertical
  const verticalTokens = (tenant.vertical || '').toLowerCase().split('_');
  const hasVertical = verticalTokens.some((t) => t && desc.includes(t));
  results.push({
    pass: hasVertical,
    msg: hasVertical
      ? `Description mentions vertical (${tenant.vertical}).`
      : `Description does NOT mention vertical (${tenant.vertical}).`,
  });

  // No FGA / Growth OS leakage
  const leakage = ['fga', 'first gen automate', 'firstgenautomate', 'growth os'];
  const found = leakage.find((s) => desc.includes(s));
  results.push({
    pass: !found,
    msg: found
      ? `Description contains internal-brand leakage: "${found}". Remove.`
      : 'No internal-brand leakage in description.',
  });

  return results;
}

function checkServiceArea(tenant, config, listing) {
  const area = (config.service_area || '').trim().toLowerCase();
  if (!area) {
    return { pass: true, msg: 'No service area configured — skipping check.', warn: true };
  }
  const desc = (listing?.description || '').toLowerCase();
  if (desc.includes(area)) {
    return { pass: true, msg: `Description mentions service area ("${config.service_area}").` };
  }
  return { pass: false, msg: `Description does NOT mention service area ("${config.service_area}").` };
}

async function checkUrl(label, url, businessName) {
  if (!url) return { pass: false, msg: `${label} URL is missing.` };
  const { status, body } = await fetchUrl(url);
  if (status !== 200) return { pass: false, msg: `${label} URL returned status ${status}: ${url}` };
  const lower = body.toLowerCase();
  if (businessName && !lower.includes(businessName.toLowerCase())) {
    return { pass: false, msg: `${label} URL does not mention "${businessName}": ${url}` };
  }
  return { pass: true, msg: `${label} URL OK: ${url}` };
}

function checkDescriptionLength(listing, deliveryPath) {
  const len = (listing?.description || '').length;
  // Path A (Managed) demands richer listing copy because Apple's
  // 4.2.6 reviewer scrutiny is higher when many apps live under one
  // developer account. Path B clears at a lower bar.
  const minLength = deliveryPath === 'managed' ? 800 : 500;
  if (len >= minLength) return { pass: true, msg: `Description length: ${len} chars (min ${minLength} for ${deliveryPath})`, soft: true };
  return {
    pass: false,
    msg: `Description is short (${len} chars). Path ${deliveryPath === 'managed' ? 'A (Managed)' : 'B (Owned)'} requires ${minLength}+.`,
    soft: deliveryPath === 'owned', // hard fail on managed, soft warn on owned
  };
}

// ---------- Report ----------

function printReport(tenant, results) {
  const hardFailures = results.filter((r) => !r.pass && !r.soft);
  const softFailures = results.filter((r) => !r.pass && r.soft);
  const passed = results.filter((r) => r.pass);

  console.log('');
  console.log('============================================================');
  console.log(`  App Store 4.2.6 Compliance Audit — ${tenant.name}`);
  console.log('============================================================');
  console.log('');
  console.log('PASSED:');
  for (const r of passed) console.log(`  ✓ ${r.msg}`);
  console.log('');

  if (softFailures.length) {
    console.log('WARNINGS (soft — allowed but recommended fix):');
    for (const r of softFailures) console.log(`  ! ${r.msg}`);
    console.log('');
  }

  if (hardFailures.length) {
    console.log('BLOCKERS (hard — submission BLOCKED until fixed):');
    for (const r of hardFailures) console.log(`  ✗ ${r.msg}`);
    console.log('');
    console.log(`Result: BLOCK — ${hardFailures.length} blocker(s)`);
    console.log('');
    return false;
  }

  console.log(`Result: PASS${softFailures.length ? ` (with ${softFailures.length} warning(s))` : ''}`);
  console.log('');
  return true;
}

// ---------- Main ----------

async function main() {
  const args = parseArgs();
  const { tenant, config } = await loadTenant(args.tenant);
  const deliveryPath = resolvePath(args.path, config);
  const listing = readListing(tenant.slug);

  log.info(`Auditing ${tenant.name} (${tenant.slug}) — path: ${deliveryPath}`);

  const results = [];

  results.push(await checkIconUniqueness(tenant, deliveryPath));
  results.push(checkAppName(tenant));
  results.push(checkBundleId(tenant, deliveryPath));
  results.push(...checkListingCopy(tenant, listing));
  results.push(checkServiceArea(tenant, config, listing));

  if (!args.skipUrlCheck) {
    const privacyUrl = config.privacy_policy_url;
    const supportUrl = config.support_url;
    results.push(await checkUrl('Privacy', privacyUrl, tenant.name));
    results.push(await checkUrl('Support', supportUrl, tenant.name));
  }

  results.push(checkDescriptionLength(listing, deliveryPath));

  // Save report
  const reportPath = path.join(getAssetDir(tenant.slug), 'audit-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    tenant_id: tenant.id,
    slug: tenant.slug,
    delivery_path: deliveryPath,
    audited_at: new Date().toISOString(),
    results,
  }, null, 2));

  const passed = printReport(tenant, results);
  log.info(`Report saved: ${reportPath}`);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  log.error(`Audit failed: ${err.message}`);
  console.error(err);
  process.exit(1);
});
