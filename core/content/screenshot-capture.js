/**
 * Safe headless screenshot capture (Playwright/Chromium) for content visuals.
 *
 * SECURITY CONTRACT (never relax without review):
 *  - Host allowlist: only FGA's own marketing/admin host(s) and approved demo
 *    surfaces. Any other host is rejected BEFORE navigation.
 *  - Request interception aborts every off-allowlist request (blocks accidental
 *    cross-tenant API calls, third-party embeds, analytics).
 *  - Tenant guard: a tenant-scoped URL may only reference FGA or the Apex demo
 *    tenant. Any other tenant id in the URL is rejected.
 *  - PII redaction: known name/email/phone selectors are masked at capture.
 *  - Every shot is validated (non-black, dimensions, thumbnailable) before use.
 *  - Graceful degradation: any failure returns [] so finalize falls back to a
 *    generated visual. Capture NEVER blocks copy generation.
 *
 * Playwright is required lazily so the module loads even before the browser is
 * installed; capture simply degrades until the Railway image includes Chromium.
 */

const { createLogger } = require('../logger');
const { db } = require('../../db/client');
const { FGA_TENANT_ID } = require('../config');
const imageValidation = require('./image-validation');

const log = createLogger('content-screenshot');

const ALLOWED_HOSTS = (process.env.CONTENT_SCREENSHOT_HOSTS
  || 'firstgenautomate.com,www.firstgenautomate.com')
  .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

const APEX_DEMO_TENANT_ID = process.env.APEX_DEMO_TENANT_ID || null;
const ALLOWED_TENANT_IDS = [FGA_TENANT_ID, APEX_DEMO_TENANT_ID].filter(Boolean);

// Selectors masked before capture so customer/lead PII never lands in a post.
const PII_SELECTORS = [
  '[data-pii]', '[data-email]', '[data-phone]', '.lead-email', '.lead-phone',
  '.customer-email', '.customer-phone', '.recipient-email', 'td.email', 'td.phone',
];

function hostAllowed(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch (_) { return false; }
}

function tenantAllowed(u) {
  try {
    const url = new URL(u);
    const t = url.searchParams.get('tenant') || url.searchParams.get('tenant_id');
    if (!t) return true; // not tenant-scoped via query
    return ALLOWED_TENANT_IDS.includes(t);
  } catch (_) { return false; }
}

async function uploadPng(buffer, fileName) {
  const path = `fga/screenshots/${fileName}`;
  const { error } = await db.storage.from('content-images').upload(path, buffer, {
    contentType: 'image/png', upsert: true,
  });
  if (error) throw error;
  const { data } = db.storage.from('content-images').getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Capture one or more screenshots.
 * @param {Object} tenant
 * @param {Array<{url:string, clip?:{x,y,width,height}, fullPage?:boolean, waitFor?:string, label?:string}>} targets
 * @param {Object} opts { authHeader?:string }  short-lived read-only auth header
 * @returns {Promise<Array<{public_url:string, role:string, source:'screenshot', validation:Object}>>}
 */
async function captureTargets(tenant, targets = [], opts = {}) {
  if (!Array.isArray(targets) || !targets.length) return [];

  // Pre-validate every target against the allowlist before launching anything.
  const safe = targets.filter((t) => t && t.url && hostAllowed(t.url) && tenantAllowed(t.url));
  if (safe.length !== targets.length) {
    log.warn(`Rejected ${targets.length - safe.length} screenshot target(s) failing host/tenant allowlist`);
  }
  if (!safe.length) return [];

  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    log.warn('Playwright not available; degrading to generated visuals');
    return [];
  }

  let browser;
  const out = [];
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1600 },
      deviceScaleFactor: 2,
      ...(opts.authHeader ? { extraHTTPHeaders: { Authorization: opts.authHeader } } : {}),
    });

    // Abort any request whose host isn't allowlisted (defense in depth).
    await context.route('**', (route) => {
      const reqUrl = route.request().url();
      if (reqUrl.startsWith('data:') || hostAllowed(reqUrl)) return route.continue();
      return route.abort();
    });

    for (const t of safe) {
      const page = await context.newPage();
      try {
        await page.goto(t.url, { waitUntil: 'networkidle', timeout: 20000 });
        if (t.waitFor) await page.waitForSelector(t.waitFor, { timeout: 8000 }).catch(() => {});
        // Redact PII before capture.
        await page.addStyleTag({ content: `${PII_SELECTORS.join(',')} { filter: blur(7px) !important; }` }).catch(() => {});
        const maskLocators = PII_SELECTORS.map((sel) => page.locator(sel));
        const shotOpts = { type: 'png', mask: maskLocators, animations: 'disabled' };
        if (t.clip) shotOpts.clip = t.clip; else if (t.fullPage) shotOpts.fullPage = true;
        const buf = await page.screenshot(shotOpts);

        const v = await imageValidation.validateAsset(buf, {});
        if (!v.ok) { log.warn(`Screenshot ${t.label || t.url} failed validation: ${v.reason}`); await page.close(); continue; }

        const fileName = `${tenant.slug || 'fga'}-${(t.label || 'shot').replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.png`;
        const publicUrl = await uploadPng(buf, fileName);
        out.push({ public_url: publicUrl, role: t.label || 'screenshot', source: 'screenshot', validation: { checks: v.checks, ...v.meta } });
      } catch (e) {
        log.warn(`Capture failed for ${t.url}: ${e.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } catch (e) {
    log.error('Screenshot session failed', e);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return out;
}

module.exports = { captureTargets, hostAllowed, tenantAllowed, ALLOWED_HOSTS, ALLOWED_TENANT_IDS };
