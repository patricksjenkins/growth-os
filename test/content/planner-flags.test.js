/**
 * Planner flag gating — FGA default ON, clients OFF, overridable.
 */
'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');
const flags = require('../../core/content/planner-flags');

test('planner enabled by default for the FGA tenant only', () => {
  assert.strictEqual(flags.isPlannerEnabled({ slug: 'fga' }), true);
  assert.strictEqual(flags.isPlannerEnabled({ slug: 'akutabove', config: {} }), false);
  assert.strictEqual(flags.isPlannerEnabled(null), false);
});

test('explicit tenant_config override wins', () => {
  assert.strictEqual(flags.isPlannerEnabled({ slug: 'fga', config: { content_planner_enabled: false } }), false);
  assert.strictEqual(flags.isPlannerEnabled({ slug: 'client', config: { content_planner_enabled: true } }), true);
});

test('thresholds have sane defaults', () => {
  const t = { slug: 'fga' };
  assert.strictEqual(flags.qualityThreshold(t), 70);
  assert.strictEqual(flags.similarityThreshold(t), 0.82);
  assert.strictEqual(flags.statLedMaxPct(t), 0.15);
  assert.strictEqual(flags.visualMaxRetries(t), 2);
});
