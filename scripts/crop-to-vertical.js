#!/usr/bin/env node

/**
 * One-off: convert approved square Google Ads images into a
 * native 9:16 portrait crop so they satisfy Performance Max's
 * Reels/Stories ratio requirement. Saves new files alongside
 * the originals (originals are untouched).
 *
 * Why: Performance Max requires images that can serve a 9:16 slot.
 * Our 1024x1024 squares technically COULD be cropped client-side,
 * but Google's UI was not auto-marking the asset group complete
 * without a native vertical asset. Pre-cropping here removes the
 * ambiguity — Google sees a true 9:16 image and accepts it.
 *
 * Target dimensions: 768x1376 — same proportions as Google's own
 * recent 9:16 spec, well above min 320x568, well under max 4096.
 * Square is 1024x1024. We extract a 576x1024 vertical strip from
 * the center (where the phone sits), then resize up to 768x1376
 * to give Google plenty of pixels.
 *
 * Run:  node scripts/crop-to-vertical.js
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SRC_DIR = path.join(process.env.HOME, 'Desktop', 'fga-google-ad-images');
const TARGETS = [
  // Patrick-approved favorites for Google PMax
  '02-square-tree-icon.png',
  '08-horizontal-grooming-wide.png',
];

// Target output dimensions. 768x1376 ≈ 9:16 (actually 0.558, very close
// to 0.5625). Google PMax accepts within tolerance.
const OUT_WIDTH = 768;
const OUT_HEIGHT = 1376;

async function cropOne(file) {
  const inPath = path.join(SRC_DIR, file);
  if (!fs.existsSync(inPath)) {
    console.warn(`[${file}] missing source — skipping`);
    return;
  }
  const meta = await sharp(inPath).metadata();
  if (!meta.width || !meta.height) {
    console.warn(`[${file}] no dimensions — skipping`);
    return;
  }

  // Take a 9:16 vertical strip from the horizontal center of the
  // source image. width = height * 9 / 16. Works for both square
  // sources (1024x1024 → 576x1024 crop) and horizontal sources
  // (1424x752 → 423x752 crop). Both then upscale to 768x1376 for
  // a clean final output that comfortably exceeds Google's
  // recommended size for vertical assets.
  const cropWidth = Math.round((meta.height * 9) / 16);
  const cropLeft = Math.max(0, Math.round((meta.width - cropWidth) / 2));

  const outName = file
    .replace(/^\d+-square-/, '12-vertical-from-')
    .replace(/^\d+-horizontal-/, '13-vertical-from-')
    .replace(/\.png$/, '.png');
  const outPath = path.join(SRC_DIR, outName);

  await sharp(inPath)
    .extract({
      left: cropLeft,
      top: 0,
      width: cropWidth,
      height: meta.height,
    })
    .resize(OUT_WIDTH, OUT_HEIGHT, { fit: 'cover' })
    .png({ quality: 95 })
    .toFile(outPath);

  console.log(`[${file}] → ${outName} (${OUT_WIDTH}x${OUT_HEIGHT})`);
}

(async () => {
  console.log(`Source dir: ${SRC_DIR}\n`);
  for (const f of TARGETS) {
    await cropOne(f);
  }
  console.log('\nDone.');
})();
