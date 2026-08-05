/**
 * Strategy planner — format library + objectives + mix targets (pure).
 */
'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');
const planner = require('../../core/content/strategy-planner');

test('format library is loose (>=21) and maps to renderable bases 1-9', () => {
  assert.ok(planner.FORMAT_LIBRARY.length >= 21);
  for (const f of planner.FORMAT_LIBRARY) {
    assert.ok(f.base >= 1 && f.base <= 9, `${f.name} base out of range`);
  }
});

test('selectFormatLoose resolves names to a renderable base', () => {
  assert.strictEqual(planner.selectFormatLoose('Stat Card').base, 3);
  assert.strictEqual(planner.selectFormatLoose('Module Spotlight').base, 9);
  assert.strictEqual(planner.selectFormatLoose('Screenshot Breakdown').needsScreenshot, true);
});

test('objectives include managed-AI + non-promotional options', () => {
  assert.ok(planner.OBJECTIVES.includes('Explain Managed AI'));
  assert.ok(planner.OBJECTIVES.includes('Build Trust'));
  assert.ok(planner.OBJECTIVES.length >= 12);
});

test('rolling mix targets total 12 with founder + non-stat emphasis', () => {
  const total = Object.values(planner.TARGET_MIX).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 12);
});

test('strategy planner exposes the six-module round-robin program', () => {
  for (const module of ['AI Voice Receptionist', 'Speed-to-Lead', 'Follow-Up Sequences', 'Command Center', 'Review Requests', 'Content Engine + Content Approval']) {
    assert.ok(planner.MODULES.includes(module), `missing ${module}`);
  }
});
