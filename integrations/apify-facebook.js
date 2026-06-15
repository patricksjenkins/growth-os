/**
 * Apify — Facebook Page deep-extraction
 *
 * Wraps the public Apify actor `apify/facebook-pages-scraper` so the
 * enrichment agent can read the FB About section (email, phone, website,
 * address, founded date, etc.) instead of relying only on Google search
 * snippets that miss most contact info.
 *
 * Why this exists (Patrick caught the gap 2026-06-08):
 *   Many fb_only leads have full contact info on their FB About page,
 *   but Google never indexes "See more" content. Enrichment was
 *   classifying them as unreachable when in fact the email/website
 *   was sitting right there behind a click.
 *
 * Cost shape: ~$0.005-0.01 per page scraped. Free tier gives $5/mo
 * of credit (≈500-1000 pages).
 *
 * Auth: set APIFY_API_TOKEN in env. The token is shared platform-wide.
 *
 * Usage:
 *   const { fetchFbPageDetails } = require('./integrations/apify-facebook');
 *   const data = await fetchFbPageDetails('https://www.facebook.com/SomePage');
 *   // → { ok, email, phone, website, address, category, founded, ... }
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');

const log = createLogger('apify-fb');

// Actor slug for the Facebook Pages scraper. Apify slugs are
// "username~actor-name"; the URL-safe form uses ~ in API calls.
const ACTOR_SLUG = 'apify~facebook-pages-scraper';

// Total time we'll wait for a single scrape result before giving up.
// Apify runs queue + start, so even simple page scrapes take ~30-60s.
const POLL_TIMEOUT_MS = 90000;
const POLL_INTERVAL_MS = 3000;

/**
 * Fetch FB page details by running the scraper actor synchronously
 * (Apify's run-sync endpoint returns results in one HTTP call).
 *
 * @param {string} fbUrl - https://www.facebook.com/<handle> or .../people/...
 * @returns {Promise<{ok: boolean, email?: string, phone?: string,
 *                    website?: string, address?: string,
 *                    category?: string, founded?: string,
 *                    likes?: number, rating?: number, reviewCount?: number,
 *                    raw?: object, error?: string }>}
 */
async function fetchFbPageDetails(fbUrl) {
  if (!fbUrl || typeof fbUrl !== 'string') {
    return { ok: false, error: 'invalid_url' };
  }
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    return { ok: false, error: 'apify_token_missing' };
  }

  // run-sync-get-dataset-items waits for the run to finish AND returns
  // the dataset rows in the same response. One HTTP roundtrip, no polling
  // gymnastics. Caps execution at the timeout to protect the enrichment cron.
  const url = `https://api.apify.com/v2/acts/${ACTOR_SLUG}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${Math.floor(POLL_TIMEOUT_MS / 1000)}`;

  try {
    const startPageUrls = [{ url: fbUrl }];
    const res = await axios.post(url, {
      startUrls: startPageUrls,
      // Skip post crawling — we only need the About data
      resultsLimit: 1,
      onlyPageInfo: true,
    }, {
      timeout: POLL_TIMEOUT_MS + 5000,
      headers: { 'Content-Type': 'application/json' },
    });

    const rows = Array.isArray(res.data) ? res.data : [];
    // Usage-based cost on the ledger (provider=apify) — a run executed whether
    // or not it returned rows. Per-run; override APIFY_RUN_COST_USD. Agent/
    // tenant come from the running agent context.
    try {
      require('../core/ai-safety/usage-tracker').recordUsage({
        provider: 'apify', model: ACTOR_SLUG, operationType: 'fb_page_scrape',
        estimatedCostUsd: Number(process.env.APIFY_RUN_COST_USD || 0.01),
        isAutomated: true, requestSource: 'integrations/apify-facebook.js:fetchFbPageDetails',
      }).catch(() => {});
    } catch (_) { /* never break enrichment */ }
    if (rows.length === 0) {
      log.warn(`Apify returned empty dataset for ${fbUrl}`);
      return { ok: false, error: 'empty_dataset' };
    }

    const row = rows[0];
    // Apify's facebook-pages-scraper field names vary across actor versions.
    // Normalize the common shapes here so the caller doesn't have to care.
    const normalized = normalizeFbPageRow(row);
    return { ok: true, ...normalized, raw: row };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.warn(`Apify FB scrape failed for ${fbUrl}: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Pull the fields enrichment cares about out of a raw Apify dataset row.
 * Tolerates field-name drift across actor versions (e.g. `email` vs
 * `pageEmail`, `phone` vs `pagePhone`, `website` vs `pageWebsite`).
 */
function normalizeFbPageRow(row) {
  const out = {};
  out.email = pickFirst(row, ['email', 'pageEmail', 'contactEmail']);
  out.phone = pickFirst(row, ['phone', 'pagePhone', 'phoneNumber', 'contactPhone']);
  out.website = pickFirst(row, ['website', 'pageWebsite', 'websites']);
  if (Array.isArray(out.website)) out.website = out.website[0] || null;
  out.address = pickFirst(row, ['address', 'pageAddress', 'fullAddress']);
  out.category = pickFirst(row, ['categories', 'category', 'pageCategory']);
  if (Array.isArray(out.category)) out.category = out.category.join(', ');
  out.founded = pickFirst(row, ['founded', 'foundedIn', 'establishedDate']);
  out.likes = numOrNull(pickFirst(row, ['likesCount', 'likes', 'pageLikes']));
  out.followers = numOrNull(pickFirst(row, ['followersCount', 'followers']));
  out.rating = numOrNull(pickFirst(row, ['rating', 'pageRating', 'averageRating']));
  out.reviewCount = numOrNull(pickFirst(row, ['reviewsCount', 'reviews', 'pageReviews']));
  out.about = pickFirst(row, ['about', 'pageAbout', 'description']);
  out.title = pickFirst(row, ['title', 'pageName', 'name']);
  return out;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}
function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  fetchFbPageDetails,
};
