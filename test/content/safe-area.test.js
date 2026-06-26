'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sa = require('../../core/content/safe-area');

test('canvases + platform selection', () => {
  assert.strictEqual(sa.getCanvas('ig_portrait').height, 1350);
  assert.strictEqual(sa.canvasForPlatform('facebook').name, 'fb_feed');
  assert.strictEqual(sa.canvasForPlatform('instagram').name, 'ig_portrait');
  assert.strictEqual(sa.canvasForPlatform('instagram_square').name, 'ig_square');
});

test('safeBox respects per-canvas margins', () => {
  const p = sa.getCanvas('ig_portrait');
  const sb = sa.safeBox(p, true);
  assert.strictEqual(sb.left, 120);   // x preferred
  assert.strictEqual(sb.top, 140);    // y preferred
  assert.strictEqual(sb.right, 1080 - 120);
  assert.strictEqual(sb.bottom, 1350 - 140);
});

test('logoInset scales with canvas width and respects min', () => {
  assert.strictEqual(sa.logoInset(sa.getCanvas('ig_portrait'), false), 80);
  assert.ok(sa.logoInset(sa.getCanvas('fb_feed'), false) >= 80);
});

test('checkBoxes — clipping is a hard fail', () => {
  const cv = sa.getCanvas('ig_portrait');
  const off = sa.checkBoxes([{ kind: 'logo', x: 1000, y: 1340, w: 120, h: 60 }], cv);
  assert.strictEqual(off.ok, false);
  assert.ok(off.violations.some((v) => v.code === 'logo_clipped' && v.severity === 'hard'));
});

test('checkBoxes — off-canvas text is a hard text_clipped', () => {
  const cv = sa.getCanvas('ig_portrait');
  const r = sa.checkBoxes([{ kind: 'text', x: -20, y: 300, w: 600, h: 100 }], cv);
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'text_clipped' && v.severity === 'hard'));
});

test('checkBoxes — inside minimum margin (on page) is SOFT, not blocking', () => {
  const cv = sa.getCanvas('ig_portrait');
  const r = sa.checkBoxes([{ kind: 'text', x: 20, y: 300, w: 600, h: 100 }], cv);
  assert.strictEqual(r.ok, true); // soft only — does not hard-fail
  assert.ok(r.violations.some((v) => v.code === 'unsafe_margin' && v.severity === 'soft'));
});

test('checkBoxes — well-placed content passes', () => {
  const cv = sa.getCanvas('ig_portrait');
  const r = sa.checkBoxes([{ kind: 'text', x: 160, y: 220, w: 760, h: 280 }], cv);
  assert.strictEqual(r.ok, true);
});

test('checkBoxes — overcrowded text is soft (does not hard-fail)', () => {
  const cv = sa.getCanvas('ig_portrait');
  const r = sa.checkBoxes([{ kind: 'text', x: 160, y: 160, w: 760, h: 1000 }], cv);
  assert.strictEqual(r.ok, true); // soft only
  assert.ok(r.violations.some((v) => v.code === 'overcrowded_text' && v.severity === 'soft'));
});
