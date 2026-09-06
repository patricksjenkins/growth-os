'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CATEGORIES, OWNERSHIP, OVERLAP_RULES, categoryLabel } = require('../../core/growth/ownership');

test('every agent maps to a known category', () => {
  const keys = new Set(CATEGORIES.map((c) => c.key));
  for (const [agent, o] of Object.entries(OWNERSHIP)) {
    assert.ok(keys.has(o.category), `${agent} has unknown category ${o.category}`);
    assert.ok(o.owns, `${agent} missing owns`);
  }
});

test('overlap rules are well-formed and name an owner', () => {
  for (const r of OVERLAP_RULES) {
    assert.ok(Array.isArray(r.agents) && r.agents.length >= 2, 'overlap names every participating agent');
    assert.ok(r.owner && r.rule, 'overlap has owner + rule');
    assert.ok(['info', 'warn'].includes(r.severity), 'severity is info|warn');
    // both named agents exist in the ownership map (or are an explicit virtual owner)
    for (const a of r.agents) assert.ok(OWNERSHIP[a], `overlap references unknown agent ${a}`);
  }
});

test('categoryLabel resolves', () => {
  assert.strictEqual(categoryLabel('prospecting_growth'), 'Prospecting & Growth');
  assert.strictEqual(categoryLabel('nope'), 'nope');
});
