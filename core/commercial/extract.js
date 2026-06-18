/**
 * core/commercial/extract.js — candidate page fetch + lightweight extraction.
 *
 * Prefers FREE direct HTTP retrieval + safe parsing (JSON-LD Event schema, meta
 * tags, regex for public email/phone). Only falls back to a paid Apify run for
 * Facebook pages (where direct fetch is blocked). Produces a compact, trimmed
 * payload the Stage-2 Claude step reasons over — we never hand Claude a full raw
 * page (token + cost control).
 *
 * Respects a page-size cap and never executes page scripts. Best-effort: any
 * failure returns { ok:false } so the orchestrator records a failed source and
 * moves on.
 */

const axios = require('axios');

const MAX_BYTES = 600 * 1024; // page-size cap (don't pull huge pages)
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonLdEvents(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 5) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const node of arr) {
        const t = node && node['@type'];
        if (t && (t === 'Event' || (Array.isArray(t) && t.includes('Event')) || /Event$/.test(String(t)))) {
          out.push({
            name: node.name, startDate: node.startDate, endDate: node.endDate,
            location: locName(node.location), organizer: orgName(node.organizer),
            url: node.url, attendance: node.maximumAttendeeCapacity || null,
          });
        }
      }
    } catch (_) { /* skip bad JSON-LD */ }
  }
  return out;
}
function locName(loc) {
  if (!loc) return null;
  if (typeof loc === 'string') return loc;
  const a = loc.address || {};
  return [loc.name, a.addressLocality, a.addressRegion].filter(Boolean).join(', ') || a.streetAddress || null;
}
function orgName(o) { if (!o) return null; return typeof o === 'string' ? o : (o.name || null); }

function metaTag(html, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * Fetch + extract one candidate page. Returns:
 * { ok, url, title, description, text (trimmed), events[], emails[], phones[],
 *   usedApify, apifyCostUsd }
 */
async function fetchCandidate(url, { apifyOk = false } = {}) {
  const isFacebook = /facebook\.com/i.test(url);

  if (isFacebook) {
    // Direct FB fetch is blocked; use Apify only if allowed + configured.
    if (!apifyOk || !process.env.APIFY_API_TOKEN) return { ok: false, url, error: 'facebook needs apify (disabled or unconfigured)' };
    try {
      const { fetchFbPageDetails } = require('../../integrations/apify-facebook');
      const fb = await fetchFbPageDetails(url);
      if (!fb || !fb.ok) return { ok: false, url, error: 'apify fb failed' };
      return {
        ok: true, url, title: fb.title || null, description: fb.about || null,
        text: [fb.title, fb.about, fb.category, fb.address].filter(Boolean).join(' · '),
        events: [], emails: fb.email ? [fb.email] : [], phones: fb.phone ? [fb.phone] : [],
        website: fb.website || null, usedApify: true, apifyCostUsd: Number(process.env.APIFY_RUN_COST_USD || 0.01),
      };
    } catch (e) { return { ok: false, url, error: 'apify error: ' + e.message }; }
  }

  // Free direct HTTP retrieval.
  let html;
  try {
    const res = await axios.get(url, {
      timeout: 15000, maxContentLength: MAX_BYTES, maxRedirects: 4, responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 923A-OpportunityBot/1.0; +https://923acoins.com)', Accept: 'text/html' },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    html = typeof res.data === 'string' ? res.data : '';
  } catch (e) { return { ok: false, url, error: e.message, status: e.response && e.response.status }; }

  const text = stripTags(html).slice(0, 6000);
  const title = metaTag(html, 'og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || null;
  const description = metaTag(html, 'og:description') || metaTag(html, 'description') || null;
  const emails = Array.from(new Set((text.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))).filter((e) => !/\.(png|jpg|jpeg|gif|webp)$/i.test(e)).slice(0, 5);
  const phones = Array.from(new Set(text.match(PHONE_RE) || [])).slice(0, 5);
  const events = jsonLdEvents(html);

  return { ok: true, url, title, description, text, events, emails, phones, usedApify: false, apifyCostUsd: 0 };
}

module.exports = { fetchCandidate, stripTags };
