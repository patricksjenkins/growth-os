/**
 * Targeted Campaign agent + core — pure-logic unit tests.
 * No DB / no network: only exported pure helpers are exercised.
 */

'use strict';

// Modules require db/client at load; give them dummy env so require doesn't
// throw. None of the pure helpers under test touch the DB.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');

const core = require('../core/targeted-campaigns');
const {
  buildCampaignQueries,
  campaignFitScore,
  contactStatusFor,
  pickVariant,
  clampDailyCap,
  hasLiveWebsite,
  escapeHtml,
  etToday,
  DEFAULT_MAX_SERPER_CALLS_PER_RUN,
  DEFAULT_MAX_CANDIDATES_PER_RUN,
  ZERO_YIELD_LIMIT,
  DEFAULT_FIT_THRESHOLD,
} = require('../worker/agents/targeted-campaign')._internals;

// ───────────────────────────── core: status model ────────────────────────

test('status model has all 16 statuses and 4 executable', () => {
  assert.strictEqual(core.STATUSES.length, 16);
  assert.deepStrictEqual(core.EXECUTABLE_STATUSES, [
    'ready_for_pilot', 'pilot_running', 'approved_to_continue', 'active',
  ]);
  for (const s of core.STATUSES) assert.ok(core.STATUS_LABELS[s], `label for ${s}`);
  for (const s of core.STATUSES) assert.ok(Array.isArray(core.ALLOWED_TRANSITIONS[s]), `transitions for ${s}`);
});

test('isExecutable only true for executable statuses', () => {
  for (const s of core.STATUSES) {
    assert.strictEqual(core.isExecutable(s), core.EXECUTABLE_STATUSES.includes(s), s);
  }
});

test('canTransition enforces the lifecycle graph', () => {
  assert.ok(core.canTransition('draft', 'strategy_review'));
  assert.ok(core.canTransition('strategy_review', 'messaging_review'));
  assert.ok(core.canTransition('messaging_review', 'ready_for_pilot'));
  assert.ok(core.canTransition('ready_for_pilot', 'pilot_running'));
  assert.ok(core.canTransition('pilot_running', 'pilot_awaiting_approval'));
  assert.ok(core.canTransition('pilot_awaiting_approval', 'approved_to_continue'));
  assert.ok(core.canTransition('approved_to_continue', 'active'));
  assert.ok(core.canTransition('active', 'completed'));
  // Illegal jumps
  assert.ok(!core.canTransition('draft', 'active'));
  assert.ok(!core.canTransition('draft', 'pilot_running'));
  assert.ok(!core.canTransition('archived', 'active'));
  assert.ok(!core.canTransition('completed', 'active'));
  assert.ok(!core.canTransition('nope', 'active'));
});

test('terminal statuses only allow archive (archived is final)', () => {
  assert.deepStrictEqual(core.ALLOWED_TRANSITIONS.completed, ['archived']);
  assert.deepStrictEqual(core.ALLOWED_TRANSITIONS.cancelled, ['archived']);
  assert.deepStrictEqual(core.ALLOWED_TRANSITIONS.archived, []);
});

// ─────────────────────────── core: validation ────────────────────────────

const GOOD_CAMPAIGN = {
  name: 'Florida Pool Opening Season Test',
  audience: { states: ['FL'], industries: ['Pool Cleaning'], employee_min: 1, employee_max: 5, website_rule: 'no_website' },
  opportunity: { description: 'Pool opening season ramps in FL' },
  solution: { modules: ['Speed-to-Lead', 'Missed Call Text-Back'] },
  goal_qualified: 100,
  pilot_size: 10,
  daily_batch_cap: 25,
  budget: { max_serper_calls: 200, max_ai_calls: 100, max_apify_calls: 50, max_cost_usd: 10 },
};

test('validateCampaignConfig passes a complete launch config', () => {
  const res = core.validateCampaignConfig(GOOD_CAMPAIGN, { forLaunch: true });
  assert.deepStrictEqual(res, { valid: true, errors: [] });
});

test('validateCampaignConfig draft mode is lenient about audience', () => {
  const res = core.validateCampaignConfig({ name: 'Draft', goal_qualified: 100, pilot_size: 10, daily_batch_cap: 25 });
  assert.ok(res.valid, res.errors.join('; '));
});

test('validateCampaignConfig catches every class of error', () => {
  const res = core.validateCampaignConfig({
    name: '',
    audience: { website_rule: 'bogus', employee_min: 9, employee_max: 2 },
    goal_qualified: 0,
    pilot_size: 99,
    daily_batch_cap: 0,
    budget: { max_serper_calls: -1 },
  }, { forLaunch: true });
  assert.ok(!res.valid);
  const joined = res.errors.join('|');
  for (const frag of ['name is required', 'states', 'industries', 'website_rule', 'employee_min',
    'goal_qualified', 'pilot_size', 'daily_batch_cap', 'max_serper_calls', 'opportunity.description', 'solution.modules']) {
    assert.ok(joined.includes(frag), `expected error about ${frag}: ${joined}`);
  }
});

test('pilot_size cannot exceed goal_qualified', () => {
  const res = core.validateCampaignConfig({ ...GOOD_CAMPAIGN, goal_qualified: 5, pilot_size: 10 });
  assert.ok(res.errors.some((e) => e.includes('pilot_size cannot exceed')));
});

test('validateVariants requires email subject+body and FB DM body', () => {
  assert.ok(!core.validateVariants([]).valid);
  const bad = core.validateVariants([{ label: 'A', email_subject: 'Hi', email_body: '', fb_dm_body: '' }]);
  assert.ok(!bad.valid);
  assert.strictEqual(bad.errors.length, 2);
  const good = core.validateVariants([
    { label: 'A', email_subject: 's', email_body: 'b', fb_dm_body: 'f' },
    { label: 'B', email_subject: 's', email_body: 'b', fb_dm_body: 'f' },
  ]);
  assert.ok(good.valid);
});

// ─────────────────────────── core: templates ─────────────────────────────

test('renderTemplate substitutes placeholders, blanks unknowns', () => {
  const out = core.renderTemplate('Hi {{first_name}} at {{company}} in {{city}} {{ unknown }}!', {
    first_name: 'Sam', company: 'Splash Pools', city: 'Tampa',
  });
  assert.strictEqual(out, 'Hi Sam at Splash Pools in Tampa !');
  assert.strictEqual(core.renderTemplate('', { a: 1 }), '');
  assert.strictEqual(core.renderTemplate(null), '');
});

test('leadTemplateContext derives first name + fallbacks', () => {
  const ctx = core.leadTemplateContext({ company: 'Splash Pools', contact_name: 'Sam Jones', city: 'Tampa', state: 'FL', industry: 'Pool Cleaning' });
  assert.deepStrictEqual(ctx, { first_name: 'Sam', company: 'Splash Pools', city: 'Tampa', state: 'FL', industry: 'Pool Cleaning' });
  const bare = core.leadTemplateContext({});
  assert.strictEqual(bare.first_name, 'there');
  assert.strictEqual(bare.company, 'your business');
});

// ─────────────────────────── core: idempotency ───────────────────────────

test('candidateKey is deterministic and identity-based', () => {
  const a = core.candidateKey('camp-1', { website: 'https://www.splashpools.com/about', phone: '(813) 555-1234' });
  const b = core.candidateKey('camp-1', { website: 'http://splashpools.com', phone: '8135551234' });
  assert.strictEqual(a, b, 'domain normalization should match');
  const c = core.candidateKey('camp-2', { website: 'splashpools.com' });
  assert.notStrictEqual(a, c, 'different campaign → different key');
  const p1 = core.candidateKey('camp-1', { phone: '(813) 555-1234' });
  const p2 = core.candidateKey('camp-1', { phone: '813-555-1234' });
  assert.strictEqual(p1, p2, 'phone normalization should match');
  const n1 = core.candidateKey('camp-1', { company: "Sam's Pools", state: 'FL' });
  const n2 = core.candidateKey('camp-1', { company: 'sams pools', state: 'fl' });
  assert.strictEqual(n1, n2, 'name+state normalization should match');
});

// ─────────────────────────── core: limits + cost ─────────────────────────

test('checkCampaignLimits: goal reached → completed', () => {
  const hit = core.checkCampaignLimits({ qualified_count: 100, goal_qualified: 100, budget: {} });
  assert.deepStrictEqual(hit, { limit: 'goal', status: 'completed' });
});

test('checkCampaignLimits: provider caps → api_limit_reached', () => {
  const base = { qualified_count: 1, goal_qualified: 100 };
  assert.deepStrictEqual(
    core.checkCampaignLimits({ ...base, serper_calls_used: 200, budget: { max_serper_calls: 200 } }),
    { limit: 'serper', status: 'api_limit_reached' });
  assert.deepStrictEqual(
    core.checkCampaignLimits({ ...base, ai_calls_used: 100, budget: { max_ai_calls: 100 } }),
    { limit: 'ai', status: 'api_limit_reached' });
  assert.deepStrictEqual(
    core.checkCampaignLimits({ ...base, apify_calls_used: 50, budget: { max_apify_calls: 50 } }),
    { limit: 'apify', status: 'api_limit_reached' });
});

test('checkCampaignLimits: cost cap → budget_limit_reached, clear otherwise', () => {
  const hit = core.checkCampaignLimits({
    qualified_count: 1, goal_qualified: 100, ai_calls_used: 50, budget: { max_cost_usd: 1 },
  });
  assert.deepStrictEqual(hit, { limit: 'cost', status: 'budget_limit_reached' });
  assert.strictEqual(core.checkCampaignLimits({
    qualified_count: 1, goal_qualified: 100, serper_calls_used: 5,
    budget: { max_serper_calls: 200, max_cost_usd: 10 },
  }), null);
});

test('estimateCost uses per-provider rates', () => {
  const cost = core.estimateCost({ serper_calls_used: 100, ai_calls_used: 10, apify_calls_used: 10 });
  assert.ok(Math.abs(cost - (0.1 + 0.2 + 0.1)) < 1e-9);
  assert.strictEqual(core.estimateCost({}), 0);
});

// ─────────────────────────── agent: pure helpers ─────────────────────────

test('agent defaults match the spec', () => {
  assert.strictEqual(DEFAULT_MAX_SERPER_CALLS_PER_RUN, 15);
  assert.strictEqual(DEFAULT_MAX_CANDIDATES_PER_RUN, 50);
  assert.strictEqual(ZERO_YIELD_LIMIT, 3);
  assert.strictEqual(DEFAULT_FIT_THRESHOLD, 50);
});

test('clampDailyCap enforces 1..25 with default 25', () => {
  assert.strictEqual(clampDailyCap(25), 25);
  assert.strictEqual(clampDailyCap(10), 10);
  assert.strictEqual(clampDailyCap(1), 1);
  assert.strictEqual(clampDailyCap(0), 25);
  assert.strictEqual(clampDailyCap(99), 25);
  assert.strictEqual(clampDailyCap('not a number'), 25);
  assert.strictEqual(clampDailyCap(undefined), 25);
});

test('hasLiveWebsite excludes directories and socials', () => {
  assert.ok(hasLiveWebsite({ website: 'https://splashpools.com' }));
  assert.ok(!hasLiveWebsite({ website: 'https://www.facebook.com/splashpools' }));
  assert.ok(!hasLiveWebsite({ website: 'https://yelp.com/biz/splash' }));
  assert.ok(!hasLiveWebsite({ website: 'https://g.page/splash' }));
  assert.ok(!hasLiveWebsite({ website: '' }));
  assert.ok(!hasLiveWebsite({}));
});

test('buildCampaignQueries is bounded and honors website_rule', () => {
  const aud = { states: ['FL'], industries: ['Pool Cleaning'], website_rule: 'no_website' };
  const q = buildCampaignQueries(aud, 15);
  assert.ok(q.length >= 1 && q.length <= 15);
  assert.ok(q.some((s) => s.includes('no website') || s.includes('facebook.com')));

  const qAny = buildCampaignQueries({ ...aud, website_rule: 'allow_any' }, 15);
  assert.ok(qAny.every((s) => !s.includes('"no website"')));

  // Hard cap respected even with a big grid
  const big = buildCampaignQueries({ states: ['FL', 'GA', 'AL', 'SC'], industries: ['a', 'b', 'c', 'd'], website_rule: 'allow_any' }, 5);
  assert.strictEqual(big.length, 5);

  // Degenerate inputs
  assert.deepStrictEqual(buildCampaignQueries({ states: [], industries: [] }, 15), []);
  assert.deepStrictEqual(buildCampaignQueries(aud, 0), []);
});

test('buildCampaignQueries rotates with dayOffset', () => {
  const aud = { states: ['FL', 'GA'], industries: ['Pool Cleaning', 'Lawn Care'], website_rule: 'allow_any' };
  const day0 = buildCampaignQueries(aud, 2, 0);
  const day1 = buildCampaignQueries(aud, 2, 1);
  assert.notDeepStrictEqual(day0, day1);
});

test('campaignFitScore rewards matches, near-disqualifies rule breaks', () => {
  const aud = { states: ['FL'], industries: ['pool cleaning'], employee_min: 1, employee_max: 5, website_rule: 'no_website' };
  const perfect = campaignFitScore({
    state: 'FL', industry: 'Pool Cleaning', employee_count: 3,
    phone: '813-555-1234', facebook_url: 'https://facebook.com/x', contact_name: 'Sam',
  }, aud);
  assert.ok(perfect >= DEFAULT_FIT_THRESHOLD, `perfect candidate should clear threshold (got ${perfect})`);

  const wrongState = campaignFitScore({ state: 'TX', industry: 'Pool Cleaning', employee_count: 3 }, aud);
  assert.ok(wrongState < DEFAULT_FIT_THRESHOLD, 'wrong state must not qualify');

  const hasWebsite = campaignFitScore({
    state: 'FL', industry: 'Pool Cleaning', employee_count: 3, website: 'https://realpoolsite.com',
  }, aud);
  assert.ok(hasWebsite < 0, 'live website under no_website rule is disqualifying');

  const excluded = campaignFitScore({
    state: 'FL', industry: 'Pool Cleaning', employee_count: 3, company: 'Mega Franchise Pools',
  }, { ...aud, excluded_keywords: ['franchise'] });
  assert.ok(excluded < 0, 'excluded keyword is disqualifying');
});

test('campaignFitScore require_website rewards a real site', () => {
  const aud = { states: ['FL'], industries: ['pool cleaning'], website_rule: 'require_website' };
  const withSite = campaignFitScore({ state: 'FL', industry: 'Pool Cleaning', website: 'https://splash.com' }, aud);
  const noSite = campaignFitScore({ state: 'FL', industry: 'Pool Cleaning' }, aud);
  assert.ok(withSite > noSite);
  assert.ok(noSite < 0);
});

test('contactStatusFor: email > FB > not ready', () => {
  assert.strictEqual(contactStatusFor({ contact_email: 'a@b.com', facebook_url: 'fb' }), 'outreach_ready_email');
  assert.strictEqual(contactStatusFor({ facebook_url: 'https://facebook.com/x' }), 'fb_dm_ready');
  assert.strictEqual(contactStatusFor({}), 'not_ready');
});

test('pickVariant round-robins approved variants only', () => {
  assert.strictEqual(pickVariant([]), null);
  assert.strictEqual(pickVariant([{ label: 'A', status: 'draft' }]), null);
  const v = pickVariant([
    { label: 'A', status: 'approved', assigned_count: 5 },
    { label: 'B', status: 'approved', assigned_count: 2 },
    { label: 'C', status: 'draft', assigned_count: 0 },
  ]);
  assert.strictEqual(v.label, 'B');
});

test('escapeHtml neutralizes markup', () => {
  assert.strictEqual(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
});

test('etToday returns YYYY-MM-DD', () => {
  assert.match(etToday(), /^\d{4}-\d{2}-\d{2}$/);
});
