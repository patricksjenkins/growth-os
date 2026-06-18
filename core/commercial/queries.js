/**
 * core/commercial/queries.js — profile-specific, date-aware search query generation.
 *
 * Generates controlled query families per search profile using the current date,
 * the search horizon, geography, and organizer/registration/sponsorship indicators.
 * Avoids re-issuing recently-run queries (history passed in).
 */

const { profileByKey } = require('./scoring');

// Approved 923A geography focus (override per targeted search). Veteran-owned shop
// in CO; bias toward its region + high-volume event states, but national is fine.
const DEFAULT_STATES = ['Colorado', 'Texas', 'Florida', 'Georgia', 'North Carolina', 'Virginia', 'Arizona', 'Tennessee'];

const PROFILE_QUERIES = {
  endurance: (yr, st) => [
    `"${yr} marathon" finisher medal ${st}`,
    `"${yr} half marathon" registration ${st}`,
    `"${yr} 5k" OR "${yr} 10k" race ${st} medal`,
    `"annual memorial run" ${st} ${yr}`,
    `site:runsignup.com ${yr} race ${st}`,
    `site:active.com ${yr} race ${st}`,
    `"race sponsorship" packet medal ${st} ${yr}`,
  ],
  sports: (yr, st) => [
    `"${yr}" youth tournament ${st} medals awards`,
    `"${yr}" championship ${st} trophy OR medal`,
    `"${yr}" martial arts tournament ${st} medals`,
    `"${yr}" charity golf tournament ${st} awards`,
    `site:tourneymachine.com ${yr} ${st}`,
  ],
  military_first_responder: (yr, st) => [
    `"${yr}" unit reunion ${st} challenge coin`,
    `"${yr}" police OR fire department awards banquet ${st}`,
    `"${yr}" veterans event ${st} recognition`,
    `"${yr}" military ball OR change of command ${st}`,
    `"${yr}" first responder appreciation ${st}`,
  ],
  schools_rotc: (yr, st) => [
    `"${yr}" ROTC awards ceremony ${st}`,
    `"${yr}" college awards banquet ${st} medals`,
    `"${yr}" high school athletic awards ${st}`,
    `"${yr}" alumni reunion ${st} recognition`,
  ],
  corporate: (yr, st) => [
    `"${yr}" employee recognition awards ${st}`,
    `"${yr}" years of service awards program ${st}`,
    `"${yr}" sales awards banquet ${st}`,
    `"${yr}" president's club ${st}`,
  ],
  conferences: (yr, st) => [
    `"${yr}" annual conference ${st} attendee gift`,
    `"${yr}" association convention ${st} challenge coin`,
    `"${yr}" public safety conference ${st}`,
    `"${yr}" summit OR symposium ${st} sponsor`,
  ],
  community_fundraising: (yr, st) => [
    `"${yr}" charity event ${st} awards`,
    `"${yr}" community festival ${st} ${yr}`,
    `"${yr}" nonprofit fundraiser ${st} recognition dinner`,
    `"${yr}" chamber of commerce awards ${st}`,
  ],
  clubs: (yr, st) => [
    `"${yr}" motorcycle club anniversary ${st} challenge coin`,
    `"${yr}" car club event ${st}`,
    `"${yr}" fraternal organization ${st} membership coin`,
    `"${yr}" veteran motorcycle ride ${st}`,
  ],
};

// Generate up to `cap` queries for a profile, date-aware, geography-spread, and
// filtered against recently-run queries.
function generateQueries(profileKey, { cap = 12, states = DEFAULT_STATES, recent = [], extra = {} } = {}) {
  const p = profileByKey(profileKey);
  if (!p) return [];
  const now = new Date();
  const thisYear = now.getFullYear();
  const nextYear = thisYear + 1;
  // After September, weight next year (registration opens far in advance).
  const years = now.getMonth() >= 8 ? [nextYear, thisYear] : [thisYear, nextYear];
  const tmpl = PROFILE_QUERIES[profileKey] || (() => []);
  const recentSet = new Set(recent.map((q) => q.toLowerCase().trim()));
  const out = [];
  outer:
  for (const yr of years) {
    for (const st of states) {
      const stTerm = extra.state ? extra.state : st;
      for (const q of tmpl(yr, stTerm)) {
        const full = extra.product ? `${q} ${extra.product}` : q;
        const norm = full.toLowerCase().trim();
        if (recentSet.has(norm)) continue;
        if (out.includes(full)) continue;
        out.push(full);
        if (out.length >= cap) break outer;
      }
      if (extra.state) break; // targeted search pins one state
    }
  }
  return out.slice(0, cap);
}

module.exports = { generateQueries, DEFAULT_STATES };
