'use strict';

const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const iv = require('../../core/content/image-validation');

async function solid(w, h, rgb = { r: 90, g: 100, b: 120 }) {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();
}
// A non-blank, edge-strip-free image (diagonal gradient) for "valid" cases.
async function gradient(w, h) {
  const svg = `<svg width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#13294B"/><stop offset="1" stop-color="#2E5A86"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
// A horizontal-gradient image with a pure white strip down the left edge,
// built pixel-by-pixel from a raw buffer so the band is exactly controlled.
async function leftStrip(w, h, stripPx = 40) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (x < stripPx) { buf[i] = buf[i + 1] = buf[i + 2] = 255; }
      else { const v = 30 + Math.floor((x / w) * 120); buf[i] = v; buf[i + 1] = v + 8; buf[i + 2] = v + 20; }
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

test('valid image passes the base + canvas checks', async () => {
  const buf = await gradient(1080, 1350);
  const r = await iv.validateAsset(buf, { canvas: 'ig_portrait' });
  assert.strictEqual(r.ok, true, r.reason || '');
});

test('wrong canvas ratio fails with wrong_canvas_ratio', async () => {
  const buf = await gradient(1080, 1080); // square against a portrait canvas
  const r = await iv.validateAsset(buf, { canvas: 'ig_portrait', checkEdgeStrips: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong_canvas_ratio');
});

test('accidental edge strip is detected', async () => {
  const buf = await leftStrip(1080, 1350);
  const r = await iv.validateAsset(buf, {}); // no canvas → isolate the edge-strip check
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'accidental_edge_strip');
  assert.ok((r.meta.edge_strips || []).includes('left'));
});

test('uniform background does NOT false-flag an edge strip', async () => {
  const buf = await solid(1080, 1350, { r: 245, g: 245, b: 245 });
  const r = await iv.validateAsset(buf, { canvas: 'ig_portrait' });
  assert.strictEqual((r.meta.edge_strips || []).length, 0);
});

test('safe-area boxes — a clipped box fails validation', async () => {
  const buf = await gradient(1080, 1350);
  const r = await iv.validateAsset(buf, {
    canvas: 'ig_portrait', checkEdgeStrips: false,
    boxes: [{ kind: 'text', x: 10, y: 200, w: 1100, h: 80 }], // runs off the right edge
  });
  assert.strictEqual(r.ok, false);
  assert.ok(['text_clipped', 'unsafe_margin'].includes(r.reason));
});

test('safe-area boxes — well-placed boxes pass', async () => {
  const buf = await gradient(1080, 1350);
  const r = await iv.validateAsset(buf, {
    canvas: 'ig_portrait', checkEdgeStrips: false,
    boxes: [{ kind: 'text', x: 160, y: 220, w: 760, h: 260 }, { kind: 'logo', x: 850, y: 1150, w: 120, h: 50 }],
  });
  assert.strictEqual(r.ok, true, r.reason || '');
});
