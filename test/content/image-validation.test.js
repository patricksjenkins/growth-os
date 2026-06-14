/**
 * Image validation gate — black / blank / dimensions / carousel checks.
 * Uses Sharp to synthesize test images (no network).
 */
'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const iv = require('../../core/content/image-validation');

async function blackImage() {
  return sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
}
async function validImage() {
  const blue = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 29, g: 78, b: 216 } } }).png().toBuffer();
  const white = await sharp({ create: { width: 420, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
  return sharp(blue).composite([{ input: white, top: 120, left: 120 }]).png().toBuffer();
}

test('a fully black frame is rejected', async () => {
  const r = await iv.validateAsset(await blackImage(), { expectedWidth: 1080, expectedHeight: 1350 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'not_black');
});

test('zero-byte input is rejected', async () => {
  const r = await iv.validateAsset(Buffer.alloc(0));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'zero_bytes');
});

test('a real multi-color image passes', async () => {
  const r = await iv.validateAsset(await validImage(), { expectedWidth: 1080, expectedHeight: 1350 });
  assert.strictEqual(r.ok, true, `unexpected reason: ${r.reason}`);
  assert.strictEqual(r.meta.width, 1080);
  assert.strictEqual(r.meta.height, 1350);
});

test('validateCarousel flags a missing slide url', async () => {
  const draft = { image_urls: ['https://example.com/a.png', ''] };
  const r = await iv.validateCarousel(draft);
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes(1));
});
