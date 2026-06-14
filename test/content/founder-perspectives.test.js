/**
 * Founder perspective library — approved, grounded, no fabricated stories.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const founder = require('../../core/content/founder-perspectives');

test('library is non-trivial and every entry is grounded (perspective + context)', () => {
  const all = founder.all();
  assert.ok(all.length >= 8);
  for (const p of all) {
    assert.ok(p.id && p.perspective && p.context, `entry missing fields: ${JSON.stringify(p)}`);
  }
});

test('pickPerspective avoids recently-used ids', () => {
  const all = founder.all();
  const recent = all.slice(0, all.length - 1).map((p) => p.id);
  const pick = founder.pickPerspective(recent);
  assert.strictEqual(pick.id, all[all.length - 1].id);
});

test('getById returns the matching perspective', () => {
  const first = founder.all()[0];
  assert.strictEqual(founder.getById(first.id).perspective, first.perspective);
  assert.strictEqual(founder.getById('nope'), null);
});

test('attribution is the approved founder string', () => {
  assert.strictEqual(founder.ATTRIBUTION, 'Patrick, First Gen Automate');
});
