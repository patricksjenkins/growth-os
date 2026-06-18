/**
 * core/commercial/sources.js — URL canonicalization + source-tier classification.
 *
 * Discovery must not depend on random Google results. Every candidate URL is
 * canonicalized (for dedup) and tiered by domain quality so a thin aggregator
 * snippet can't become a high-confidence opportunity on its own.
 */

// Known event/registration platforms (Tier 2 — trusted) and aggregators (Tier 4).
const TIER2_PLATFORMS = ['runsignup.com', 'active.com', 'raceroster.com', 'eventbrite.com', 'racentry.com', 'ultrasignup.com', 'athlinks.com', 'cvent.com', 'tourneymachine.com', 'trackwrestling.com', 'exhibitorsearch', 'whova.com', 'swimcloud.com'];
const TIER3_SUPPORTING = ['prnewswire.com', 'businesswire.com', 'patch.com', 'facebook.com', 'instagram.com', 'eventcrazy.com', 'tripadvisor.com'];
const TIER4_AGGREGATORS = ['yelp.com', 'mapquest.com', 'yellowpages.com', 'allevents.in', 'eventful.com', '10times.com', 'meetup.com', 'pinterest.com', 'reddit.com'];
const OFFICIAL_TLDS = ['.gov', '.mil', '.edu'];

function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.protocol = 'https:';
    u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    u.hash = '';
    // strip tracking params
    const drop = [];
    u.searchParams.forEach((_, k) => { if (/^utm_|^fbclid$|^gclid$|^ref$|^source$/i.test(k)) drop.push(k); });
    drop.forEach((k) => u.searchParams.delete(k));
    let s = u.toString();
    s = s.replace(/\/$/, '');
    return s;
  } catch (_) { return String(url || '').trim().replace(/\/$/, ''); }
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

// Tier 1 official, 2 trusted platform, 3 supporting evidence, 4 discovery-only.
function sourceTier(url) {
  const dom = domainOf(url);
  if (!dom) return 4;
  if (OFFICIAL_TLDS.some((t) => dom.endsWith(t))) return 1;
  if (TIER2_PLATFORMS.some((p) => dom.includes(p))) return 2;
  if (TIER4_AGGREGATORS.some((p) => dom.includes(p))) return 4;
  if (TIER3_SUPPORTING.some((p) => dom.includes(p))) return 3;
  // A plain org/event domain (its own site) is treated as official-ish Tier 1.
  return 1;
}

function sourceType(url) {
  const dom = domainOf(url);
  if (OFFICIAL_TLDS.some((t) => dom.endsWith(t))) return 'official';
  if (TIER2_PLATFORMS.some((p) => dom.includes(p))) return 'registration_platform';
  if (dom.includes('facebook.com') || dom.includes('instagram.com')) return 'social';
  if (dom.includes('prnewswire') || dom.includes('businesswire') || dom.includes('patch.com')) return 'press';
  if (TIER4_AGGREGATORS.some((p) => dom.includes(p))) return 'aggregator';
  return 'website';
}

module.exports = { canonicalUrl, domainOf, sourceTier, sourceType };
