/**
 * core/commercial/scoring.js — Commercial & Event opportunity scoring (923A).
 *
 * CommonJS port of the 923A site's lib/commercial.js deterministic engine, so the
 * growth-os discovery worker computes the SAME score / band / buying window / stage
 * / product recommendation / outreach draft the 923A Command Center displays.
 * Keep this in sync with /Users/patrickjenkins/Desktop/FGA/client-sites/923a-coins/lib/commercial.js.
 *
 * Zero paid-API cost — fully deterministic from structured fields.
 */

const DAY = 86400000;

const PROFILES = [
  { key: 'endurance', name: 'Endurance Events', priority: 'highest', enabled: true,
    terms: ['marathon', 'half marathon', '10k', '5k', 'fun run', 'trail race', 'triathlon', 'duathlon', 'cycling race', 'bike ride', 'obstacle race', 'mud run', 'relay race', 'charity run', 'memorial run', 'veteran run'],
    products: ['Finisher Medal', 'Age Group Medal', 'Challenge Coin', 'Volunteer Pin', 'Sponsor Coin', 'VIP Gift'] },
  { key: 'sports', name: 'Sports & Competitions', priority: 'high', enabled: true,
    terms: ['youth tournament', 'championship', 'invitational', 'martial arts tournament', 'wrestling tournament', 'cheer competition', 'dance competition', 'gymnastics meet', 'powerlifting meet', 'golf tournament', 'charity golf outing'],
    products: ['Medal', 'Trophy', 'Award', 'Plaque', 'Belt Buckle', 'Pin'] },
  { key: 'military_first_responder', name: 'Military & First Responders', priority: 'high', enabled: true,
    terms: ['military reunion', 'unit reunion', 'retirement ceremony', 'change of command', 'commissioning', 'memorial event', 'veterans event', 'police awards', 'fire department awards', 'ems recognition', 'academy graduation', 'commemorative ride', 'memorial ride', 'unit anniversary'],
    products: ['Challenge Coin', 'Retirement Coin', 'Memorial Coin', 'Recognition Plaque', 'Lapel Pin', 'DLE-Enabled Product'] },
  { key: 'schools_rotc', name: 'Schools, Colleges & ROTC', priority: 'med-high', enabled: true,
    terms: ['rotc awards', 'rotc commissioning', 'college awards banquet', 'alumni reunion', 'graduation awards', 'student recognition', 'athletic awards', 'leadership awards', 'honor society'],
    products: ['Medal', 'Pin', 'Plaque', 'Coin', 'Recognition Award'] },
  { key: 'corporate', name: 'Corporate Recognition', priority: 'med', enabled: true,
    terms: ['employee recognition', 'years of service', 'annual awards', 'sales awards', 'leadership awards', 'retirement awards', 'corporate anniversary', "president's club", 'recognition banquet', 'dealer awards'],
    products: ['Plaque', 'Coin', 'Lapel Pin', 'Desk Award', 'DLE-Enabled Product'] },
  { key: 'conferences', name: 'Conferences & Associations', priority: 'med-high', enabled: true,
    terms: ['annual conference', 'convention', 'symposium', 'summit', 'expo', 'association meeting', 'membership conference', 'public safety conference', 'leadership summit'],
    products: ['Challenge Coin', 'Conference Coin', 'Lapel Pin', 'Speaker Gift', 'Award', 'Sponsor Gift'] },
  { key: 'community_fundraising', name: 'Community & Fundraising', priority: 'med', enabled: true,
    terms: ['charity event', 'nonprofit fundraiser', 'community festival', 'civic celebration', 'city anniversary', 'memorial event', 'golf fundraiser', 'charity race', 'recognition dinner', 'volunteer awards', 'chamber awards'],
    products: ['Medal', 'Coin', 'Plaque', 'Pin', 'Keepsake', 'Sponsor Gift'] },
  { key: 'clubs', name: 'Clubs & Membership Orgs', priority: 'med', enabled: true,
    terms: ['motorcycle club anniversary', 'veteran motorcycle event', 'commemorative ride', 'car club event', 'membership anniversary', 'lodge event', 'fraternal organization', 'club awards', 'annual gathering'],
    products: ['Challenge Coin', 'Membership Coin', 'Lapel Pin', 'Patch', 'Belt Buckle', 'Plaque'] },
];
function profileByKey(k) { return PROFILES.find((p) => p.key === k) || null; }
function enabledProfiles() { return PROFILES.filter((p) => p.enabled).map((p) => ({ key: p.key, name: p.name, priority: p.priority })); }

const WINDOWS = {
  endurance:                 { large: [270, 90], mid: [210, 75], small: [150, 60], rush: 75 },
  sports:                    { large: [210, 75], mid: [150, 60], small: [120, 45], rush: 60 },
  conferences:               { large: [270, 90], mid: [240, 90], small: [180, 60], rush: 60 },
  corporate:                 { large: [210, 75], mid: [180, 60], small: [120, 45], rush: 60 },
  schools_rotc:              { large: [210, 75], mid: [180, 60], small: [120, 45], rush: 45 },
  military_first_responder:  { large: [240, 90], mid: [210, 75], small: [120, 45], rush: 60 },
  community_fundraising:     { large: [270, 90], mid: [210, 75], small: [120, 45], rush: 60 },
  clubs:                     { large: [240, 90], mid: [180, 60], small: [120, 45], rush: 60 },
};
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function iso(d) { return d ? startOfDay(d).toISOString().slice(0, 10) : null; }

function buyingWindow(opp) {
  const profile = opp.profile || 'endurance';
  const tier = ['large', 'mid', 'small'].includes(opp.size_tier) ? opp.size_tier : 'mid';
  const rule = (WINDOWS[profile] || WINDOWS.endurance)[tier] || [180, 60];
  const eventDate = opp.event_date ? startOfDay(opp.event_date) : null;
  if (!eventDate) {
    return { start: null, end: null, firstOutreach: null, followUp: null, basis: 'No event date', confidence: 'Low' };
  }
  const start = new Date(eventDate.getTime() - rule[0] * DAY);
  const end = new Date(eventDate.getTime() - rule[1] * DAY);
  const followUp = new Date(Math.min(start.getTime() + 14 * DAY, end.getTime()));
  const basisLabel = opp.date_confidence === 'confirmed' ? 'Confirmed event date'
    : opp.prior_year_date ? 'Inferred from prior year'
    : 'Estimated from event type';
  const confidence = opp.date_confidence === 'confirmed' ? 'High' : (opp.prior_year_date ? 'Medium' : 'Low');
  return {
    start: iso(start), end: iso(end), firstOutreach: iso(start), followUp: iso(followUp),
    basis: `${basisLabel} · ${profileByKey(profile) ? profileByKey(profile).name : profile} (${tier})`,
    confidence,
  };
}

const MANUAL_STAGES = new Set(['outreach_drafted', 'outreach_sent', 'replied', 'quote_requested', 'proposal_sent', 'won', 'lost', 'no_fit', 'annual_repeat', 'closed', 'research_needed']);
function deriveStage(opp, win) {
  if (opp.stage && MANUAL_STAGES.has(opp.stage)) return opp.stage;
  if (!opp.event_date) return 'research_needed';
  const now = startOfDay(new Date()).getTime();
  const ev = startOfDay(opp.event_date).getTime();
  if (ev < now) return 'annual_repeat';
  const w = win || buyingWindow(opp);
  if (!w.start) return 'research_needed';
  const start = new Date(w.start).getTime(); const end = new Date(w.end).getTime();
  if (now > end) return 'contact_now';
  if (now >= start) return 'contact_now';
  if (start - now <= 30 * DAY) return 'contact_soon';
  return 'future_outreach';
}
const STAGE_LABELS = {
  new: 'New', research_needed: 'Research Needed', future_outreach: 'Future Outreach', contact_soon: 'Contact Soon',
  contact_now: 'Contact Now', outreach_drafted: 'Outreach Drafted', outreach_sent: 'Outreach Sent', replied: 'Replied',
  quote_requested: 'Quote Requested', proposal_sent: 'Proposal Sent', won: 'Won', lost: 'Lost', no_fit: 'No Fit',
  annual_repeat: 'Annual Repeat', closed: 'Closed',
};

const MISSION = ['military', 'veteran', 'first responder', 'police', 'fire', 'ems', 'memorial', 'commemorative', 'recognition', 'leadership', 'community', 'nonprofit', 'charity'];
function scoreCommercial(opp) {
  const text = `${opp.event_name || ''} ${opp.organization || ''} ${opp.notes || ''}`.toLowerCase();
  const profile = profileByKey(opp.profile);
  const reasons = [];

  let product = profile ? 16 : 8;
  if (opp.product_evidence) { product += 7; reasons.push('prior medals/awards evidence'); }
  if (profile) reasons.push(`${profile.name} category`);
  product = Math.min(25, product);

  let timing = 4;
  const win = buyingWindow(opp);
  if (opp.event_date) { timing += 6; if (opp.date_confidence === 'confirmed') timing += 4; else reasons.push('event date estimated'); }
  if (win.start) timing += 6;
  timing = Math.min(20, timing);

  let value = 2;
  const att = Number(opp.attendance) || 0;
  if (att >= 5000) value = 15; else if (att >= 1500) value = 12; else if (att >= 500) value = 9; else if (att >= 150) value = 6; else if (att > 0) value = 4;
  if (att) reasons.push(`~${att} attendance`);
  if (opp.recurring) value = Math.min(15, value + 2);

  const contacts = Array.isArray(opp.contacts) ? opp.contacts : [];
  let contact = 0;
  if (contacts.some((c) => c && (c.email))) contact = 15;
  else if (contacts.some((c) => c && c.phone)) contact = 11;
  else if (contacts.some((c) => c && (c.name || c.contact_page))) contact = 7;
  else if (opp.website) contact = 4;
  if (contact >= 11) reasons.push('direct contact found');

  let recurring = 0;
  if (opp.recurring) { recurring = 8; reasons.push('annual / recurring'); }
  if (opp.prior_year_date) recurring = 10;

  let brand = 2;
  if (MISSION.some((m) => text.includes(m))) { brand = 9; reasons.push('mission-aligned'); }

  let evidence = 0;
  if (opp.source_url) evidence += 2;
  if (opp.date_confidence === 'confirmed') evidence += 2;
  if (opp.product_evidence) evidence += 1;
  evidence = Math.min(5, evidence);

  let penalties = 0;
  const now = Date.now();
  if (opp.cancelled) penalties -= 100;
  else if (opp.event_date && startOfDay(opp.event_date).getTime() < now) { if (!opp.recurring) penalties -= 20; }
  if (win.end && new Date(win.end).getTime() < now && opp.stage !== 'contact_now') penalties -= 20;
  if (!contacts.length && !opp.website) penalties -= 10;
  if (!profile) penalties -= 25;

  const total = Math.max(0, Math.min(100, product + timing + value + contact + recurring + brand + evidence + penalties));

  let confidence = 'Low';
  if (opp.date_confidence === 'confirmed' && contact >= 11) confidence = 'High';
  else if (opp.event_date && (contact >= 7 || opp.source_url)) confidence = 'Medium';

  let band = 'Ignore';
  if (total >= 85) band = 'Contact Now';
  else if (total >= 70) band = 'Strong Opportunity';
  else if (total >= 55) band = 'Research Further';
  else if (total >= 40) band = 'Future / Monitor';

  const breakdown = { product, timing, value, contact, recurring, brand, evidence, penalties, total };
  return { score: total, band, confidence, reasons: Array.from(new Set(reasons)).slice(0, 5), breakdown, buyingWindow: win };
}

function recommendProducts(opp) {
  const p = profileByKey(opp.profile);
  const list = p ? p.products.slice() : ['Challenge Coin', 'Medal', 'Plaque'];
  const primary = list[0];
  const partner = /buckle|trophy|patch/i.test(primary) ? 'May require sourcing/partner for some finishes.' : '';
  return { primary, options: list, note: opp.recurring ? 'Strong repeat-order / annual-program potential.' : 'Single-event opportunity.', partner };
}
function buildOutreach(opp) {
  const rec = recommendProducts(opp);
  const ev = opp.event_name || 'your event';
  const who = opp.organization || opp.event_name || 'your team';
  let angle;
  if (opp.profile === 'endurance') angle = `Your event already creates a finish-line moment. 923A can help turn it into a ${rec.primary.toLowerCase()} participants will want to keep, display, and share.`;
  else if (opp.recurring) angle = `We noticed ${ev} is an annual event. 923A can help create a repeatable ${rec.primary.toLowerCase()} program that refreshes each year while preserving the event's identity.`;
  else if (/military|veteran|first/.test(opp.profile)) angle = `923A is veteran-owned and specializes in custom ${rec.primary.toLowerCase()}s and recognition pieces for units, departments, and ceremonies like ${ev}.`;
  else angle = `923A designs custom ${rec.primary.toLowerCase()}s and recognition pieces — a natural fit for ${ev}.`;
  return {
    subject: `Custom ${rec.primary} for ${ev}`,
    email: `Hi${opp.contacts && opp.contacts[0] && opp.contacts[0].name ? ' ' + opp.contacts[0].name : ''},\n\n${angle}\n\nWe handle design, proofing, production, and delivery — and we're easy to work with on timelines. If it's helpful, I can put together a quick concept and quote for ${ev}.\n\nWould a short call work?\n\nThank you,\n923A Coins & Designs · Veteran Owned & Operated`,
    facebook: `Hi! 923A Coins & Designs here — we make custom ${rec.primary.toLowerCase()}s and recognition pieces. ${ev} looks like a great fit. Would you be open to a quick concept + quote?`,
    phoneTalkingPoint: `${who} — ${ev}. Lead with the ${rec.primary.toLowerCase()}; ${opp.recurring ? 'pitch a repeatable annual program' : 'focus on this event'}. Veteran-owned. Offer a free concept.`,
  };
}

function dedupeKey(opp) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const ym = opp.event_date ? String(opp.event_date).slice(0, 7) : '';
  return `${norm(opp.organization)}|${norm(opp.event_name)}|${ym}`;
}
// Series key ignores the month/year — matches the recurring event across years.
function seriesKey(opp) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\b(19|20)\d\d\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(opp.organization)}|${norm(opp.event_name)}`;
}

function computeIntelligence(opp) {
  const s = scoreCommercial(opp);
  const stage = deriveStage(opp, s.buyingWindow);
  return {
    score: s.score, band: s.band, confidence: s.confidence, reasons: s.reasons, breakdown: s.breakdown,
    window: s.buyingWindow, stage, products: recommendProducts(opp), outreach: buildOutreach(opp),
  };
}

module.exports = {
  PROFILES, profileByKey, enabledProfiles, buyingWindow, deriveStage, STAGE_LABELS,
  scoreCommercial, recommendProducts, buildOutreach, dedupeKey, seriesKey, computeIntelligence,
};
