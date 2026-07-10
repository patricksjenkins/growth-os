/**
 * We QUOTE a monthly social-post limit to customers (fga-knowledge
 * volume_limits: 15 Growth / 30 Scale) — the 2026-07-10 audit found nothing
 * enforced it. The publisher now caps monthly publishes, reading the SAME
 * knowledge block the sales copy quotes, so promise and enforcement can't
 * drift apart. This pins that linkage.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const { socialPostCap } = require('../worker/agents/publisher');
const { FGA_KNOWLEDGE } = require('../core/fga-knowledge');

test('cap comes from the customer-quoted volume limits', () => {
  assert.strictEqual(
    socialPostCap({ tier: 'growth', config: {} }),
    FGA_KNOWLEDGE.volume_limits.growth.social_posts_per_month,
  );
  assert.strictEqual(
    socialPostCap({ tier: 'scale', config: {} }),
    FGA_KNOWLEDGE.volume_limits.scale.social_posts_per_month,
  );
});

test('unknown or missing tier falls back to the growth cap', () => {
  assert.strictEqual(socialPostCap({}), FGA_KNOWLEDGE.volume_limits.growth.social_posts_per_month);
  assert.strictEqual(socialPostCap({ tier: 'weird' }), FGA_KNOWLEDGE.volume_limits.growth.social_posts_per_month);
});

test('per-tenant usage_cap override wins', () => {
  assert.strictEqual(
    socialPostCap({ tier: 'growth', config: { usage_cap: { social_posts_per_month: 50 } } }),
    50,
  );
  // Garbage overrides are ignored
  assert.strictEqual(
    socialPostCap({ tier: 'scale', config: { usage_cap: { social_posts_per_month: 'lots' } } }),
    FGA_KNOWLEDGE.volume_limits.scale.social_posts_per_month,
  );
});

test('the quoted numbers themselves are sane', () => {
  const g = FGA_KNOWLEDGE.volume_limits.growth.social_posts_per_month;
  const s = FGA_KNOWLEDGE.volume_limits.scale.social_posts_per_month;
  assert.ok(Number.isInteger(g) && g > 0);
  assert.ok(Number.isInteger(s) && s >= g, 'Scale must include at least as many posts as Growth');
});
