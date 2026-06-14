/**
 * Image validation gate.
 *
 * No content draft may be marked ready-for-approval until every visual passes
 * these checks. Catches the failure that put a black/blank tile in the
 * approval queue: missing file, zero bytes, wrong dimensions, fully-black or
 * fully-transparent frames, broken references, and un-thumbnailable assets.
 *
 * Sharp-only (already a dependency via image-generation.js). No API calls.
 */

const fs = require('fs');
const sharp = require('sharp');
const { db } = require('../../db/client');
const { createLogger } = require('../logger');

const log = createLogger('image-validation');

async function loadBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (typeof input === 'string') return fs.promises.readFile(input);
  throw new Error('unsupported image input');
}

/**
 * Validate a single image asset.
 * @param {Buffer|string} input  Buffer, local path, or http(s) URL
 * @param {Object} opts { expectedWidth, expectedHeight, aspectTolerance }
 * @returns {Promise<{ok:boolean, reason:string|null, checks:Object, meta:Object}>}
 */
async function validateAsset(input, opts = {}) {
  const checks = {
    loads: false, non_zero_bytes: false, has_dimensions: false,
    aspect_ok: true, not_black: false, not_blank: false, thumbnailable: false,
  };
  const meta = {};
  let buf;
  try {
    buf = await loadBuffer(input);
  } catch (e) {
    return { ok: false, reason: `load_failed: ${e.message}`, checks, meta };
  }
  meta.bytes = buf.length;
  checks.non_zero_bytes = buf.length > 0;
  if (!checks.non_zero_bytes) return { ok: false, reason: 'zero_bytes', checks, meta };

  let image;
  try {
    image = sharp(buf, { failOn: 'none' });
    const md = await image.metadata();
    checks.loads = true;
    meta.width = md.width || 0;
    meta.height = md.height || 0;
    meta.format = md.format;
    checks.has_dimensions = meta.width > 0 && meta.height > 0;
  } catch (e) {
    return { ok: false, reason: `decode_failed: ${e.message}`, checks, meta };
  }
  if (!checks.has_dimensions) return { ok: false, reason: 'no_dimensions', checks, meta };

  meta.aspect = meta.width / meta.height;
  if (opts.expectedWidth && opts.expectedHeight) {
    const expected = opts.expectedWidth / opts.expectedHeight;
    const tol = opts.aspectTolerance != null ? opts.aspectTolerance : 0.12;
    checks.aspect_ok = Math.abs(meta.aspect - expected) <= tol;
  }

  // Brightness / uniformity stats over the raw pixels.
  try {
    const stats = await sharp(buf, { failOn: 'none' }).stats();
    const colorCh = stats.channels.slice(0, 3); // ignore alpha for brightness
    const means = colorCh.map((c) => c.mean);
    meta.mean_brightness = means.reduce((a, b) => a + b, 0) / means.length;
    meta.is_black = means.every((m) => m < 10);
    checks.not_black = !meta.is_black;

    // Blank: nearly-uniform (every channel min≈max) OR fully transparent.
    const uniform = stats.channels.every((c) => Math.abs(c.max - c.min) < 4);
    const alpha = stats.channels[3];
    const fullyTransparent = alpha ? alpha.max <= 2 : false;
    meta.entropy = typeof stats.entropy === 'number' ? stats.entropy : null;
    meta.is_blank = uniform || fullyTransparent || (meta.entropy != null && meta.entropy < 0.05);
    checks.not_blank = !meta.is_blank;
  } catch (e) {
    // If stats fail we can't prove it's good — treat as invalid.
    return { ok: false, reason: `stats_failed: ${e.message}`, checks, meta };
  }

  try {
    await sharp(buf, { failOn: 'none' }).resize(200, 200, { fit: 'inside' }).toBuffer();
    checks.thumbnailable = true;
  } catch (e) {
    checks.thumbnailable = false;
  }

  const failed = Object.entries(checks).find(([, v]) => v === false);
  const ok = !failed;
  return { ok, reason: ok ? null : failed[0], checks, meta };
}

/**
 * Validate every slide image of a draft-shaped object.
 * Accepts { campaign_payload:{carousel_images:[{public_url,role}]}, image_urls:[] }.
 */
async function validateCarousel(draft, opts = {}) {
  const carousel = draft?.campaign_payload?.carousel_images;
  const slides = Array.isArray(carousel) && carousel.length
    ? carousel.map((img, i) => ({ index: i, url: img.public_url || img.file_name, role: img.role || img.slide_role || null, kind: img.source || img.asset_kind || 'generated' }))
    : (draft?.image_urls || []).map((url, i) => ({ index: i, url, role: null, kind: 'generated' }));

  const perSlide = [];
  const missing = [];
  for (const s of slides) {
    if (!s.url) { missing.push(s.index); perSlide.push({ ...s, ok: false, reason: 'missing_url' }); continue; }
    const r = await validateAsset(s.url, opts);
    perSlide.push({ ...s, ok: r.ok, reason: r.reason, meta: r.meta, checks: r.checks });
  }
  const ok = slides.length > 0 && perSlide.every((s) => s.ok) && missing.length === 0;
  return { ok, perSlide, missing, slideCount: slides.length };
}

/**
 * Persist per-slide validation results into content_visual_assets. Replaces
 * any existing rows for the draft so re-validation is idempotent.
 */
async function recordValidation(tenantId, draftId, perSlide = []) {
  try {
    await db.from('content_visual_assets').delete().eq('draft_id', draftId);
    if (!perSlide.length) return;
    const rows = perSlide.map((s) => ({
      tenant_id: tenantId,
      draft_id: draftId,
      slide_number: s.index != null ? s.index + 1 : null,
      role: s.role || null,
      asset_kind: s.kind || 'generated',
      public_url: s.url || null,
      status: s.ok ? 'valid' : 'invalid',
      validation: { checks: s.checks || {}, ...(s.meta || {}) },
      failure_reason: s.ok ? null : (s.reason || 'invalid'),
      validated_at: new Date().toISOString(),
    }));
    await db.from('content_visual_assets').insert(rows);
  } catch (e) {
    log.warn(`recordValidation skipped: ${e.message}`);
  }
}

module.exports = { validateAsset, validateCarousel, recordValidation };
