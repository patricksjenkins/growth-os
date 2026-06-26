'use strict';

const test = require('node:test');
const assert = require('node:assert');
const vt = require('../../core/content/visual-types');
const hooks = require('../../core/content/hooks');
const pillars = require('../../core/content/pillars');
const pv = require('../../core/content/product-visuals');

test('visual-types — 8 types, renderer + textCard flags', () => {
  assert.strictEqual(vt.ids().length, 8);
  assert.strictEqual(vt.rendererFor('product_workflow'), 'product_visuals');
  assert.strictEqual(vt.isTextCard('stat_visual'), true);
  assert.strictEqual(vt.isTextCard('product_workflow'), false);
  assert.ok(vt.promptBlock().includes('command_center'));
});

test('hooks — types + pickHooks bias', () => {
  assert.ok(hooks.TYPES.includes('product'));
  const picked = hooks.pickHooks({ type: 'product', count: 3 });
  assert.strictEqual(picked.length, 3);
  assert.ok(hooks.HOOKS.product.includes(picked[0])); // biased to requested type first
});

test('pillars — 7 pillars with valid visual types', () => {
  assert.strictEqual(pillars.ids().length, 7);
  assert.ok(pillars.getById('ai_voice_receptionist'));
  for (const p of pillars.all()) {
    for (const v of p.visualTypes) assert.ok(vt.getById(v), `${p.id} → unknown visual_type ${v}`);
  }
});

test('product-visuals — all 4 renderers exist and produce SVG + boxes', () => {
  assert.deepStrictEqual(pv.names().sort(), ['call_screen', 'command_center', 'lead_card', 'workflow_diagram']);
  for (const n of pv.names()) {
    const out = pv.renderProductVisual(n, { width: 1080, height: 1350 });
    assert.ok(out.svg.startsWith('<svg'), `${n} svg`);
    assert.ok(Array.isArray(out.boxes) && out.boxes.length, `${n} boxes`);
  }
  assert.throws(() => pv.renderProductVisual('nope', {}));
});
