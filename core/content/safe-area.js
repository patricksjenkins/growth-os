/**
 * Safe-area system for generated social visuals.
 *
 * Pure geometry — no Sharp, no IO. Defines the supported canvases, their safe
 * margins (per the content brief), logo insets, and a box-violation checker the
 * compositor + validator share. The compositor knows the exact bounding boxes
 * of every text block + the logo at COMPOSE time (it builds the SVG), so safe-
 * area compliance is checked where the truth is known; the pixel-level checks
 * (dimensions, edge strips) live in image-validation.js.
 *
 * Failure reason codes (kept in sync with image-validation.js + the UI):
 *   text_clipped, logo_clipped, border_clipped  — a box runs off the canvas
 *   unsafe_margin                                — a box sits inside the margin
 *   overcrowded_text                             — text fills too much of the safe box
 *   preview_crop_risk                            — content outside the IG square crop
 *   wrong_canvas_ratio, accidental_edge_strip    — emitted by the validator
 */

// Supported canvases. `platform` is the default platform that uses each.
const CANVASES = {
  ig_square:   { name: 'ig_square',   width: 1080, height: 1080, platform: 'instagram', marginPref: 120, marginMin: 90 },
  ig_portrait: { name: 'ig_portrait', width: 1080, height: 1350, platform: 'instagram', marginPref: { x: 120, y: 140 }, marginMin: { x: 90, y: 120 } },
  fb_feed:     { name: 'fb_feed',     width: 1200, height: 1500, platform: 'facebook',  marginPref: 120, marginMin: 90 },
};

const LOGO_INSET_PREF = 100;
const LOGO_INSET_MIN = 80;
const ASPECT_TOLERANCE = 0.03;

function getCanvas(name) {
  return CANVASES[name] || CANVASES.ig_portrait;
}

/**
 * Pick the canvas for a platform. Instagram → portrait by default (best for the
 * feed + grid); square is available when a format asks for it. Facebook → feed.
 */
function canvasForPlatform(platform, prefer) {
  if (prefer && CANVASES[prefer]) return CANVASES[prefer];
  if (platform === 'facebook') return CANVASES.fb_feed;
  if (platform === 'instagram_square') return CANVASES.ig_square;
  return CANVASES.ig_portrait;
}

function marginX(canvas, pref = true) {
  const m = pref ? canvas.marginPref : canvas.marginMin;
  return typeof m === 'object' ? m.x : m;
}
function marginY(canvas, pref = true) {
  const m = pref ? canvas.marginPref : canvas.marginMin;
  return typeof m === 'object' ? m.y : m;
}

/** Inclusive safe rectangle in px {left, top, right, bottom} (preferred margins). */
function safeBox(canvas, pref = true) {
  return {
    left: marginX(canvas, pref),
    top: marginY(canvas, pref),
    right: canvas.width - marginX(canvas, pref),
    bottom: canvas.height - marginY(canvas, pref),
  };
}

function logoInset(canvas, pref = true) {
  // Scale the inset up slightly for the larger FB canvas so it reads consistent.
  const base = pref ? LOGO_INSET_PREF : LOGO_INSET_MIN;
  return Math.round(base * (canvas.width / 1080));
}

/** The center square an IG grid/preview crops a portrait to (top-anchored-ish, centered). */
function igCropBox(canvas) {
  const side = Math.min(canvas.width, canvas.height);
  const left = Math.floor((canvas.width - side) / 2);
  const top = Math.floor((canvas.height - side) / 2);
  return { left, top, right: left + side, bottom: top + side };
}

function boxRight(b) { return b.x + b.w; }
function boxBottom(b) { return b.y + b.h; }

/** Does box `b` (x,y,w,h) sit fully inside rect {left,top,right,bottom}? */
function insideRect(b, rect) {
  return b.x >= rect.left && b.y >= rect.top && boxRight(b) <= rect.right && boxBottom(b) <= rect.bottom;
}

/**
 * Check a set of layout boxes against the canvas safe area.
 * @param {Array<{kind:'text'|'logo'|'website'|'border', x,y,w,h}>} boxes
 * @returns {{ ok:boolean, violations:Array<{code,kind,severity,detail}> }}
 *   `ok` is true when there are no HARD violations (clipping / unsafe margin).
 *   Soft violations (overcrowded_text, preview_crop_risk) are reported but do
 *   not, by themselves, fail the deterministic gate — the vision scorer + UI
 *   surface them.
 */
function checkBoxes(boxes, canvas, opts = {}) {
  const violations = [];
  const safe = safeBox(canvas, true);
  const safeMin = safeBox(canvas, false);
  const canvasRect = { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
  const ignore = opts.ignoreLogoForCrop;

  // Logos are allowed closer to the edge than text (the logo inset, ≥80px),
  // so they get their own safe rect rather than the text margin.
  const li = logoInset(canvas, false);
  const logoSafeMin = { left: li, top: li, right: canvas.width - li, bottom: canvas.height - li };

  // The HARD gate is strictly "nothing bleeds OFF the page" — that is the bug
  // we must never ship. Being inside the safe margin (but on the page) is a
  // quality concern surfaced as a SOFT warning and judged by the vision scorer,
  // so a legitimately-wrapped headline that dips a few px into the margin is
  // never auto-blocked (which would freeze content). The bbox is an estimate.
  for (const b of boxes || []) {
    if (!b || b.w == null || b.h == null) continue;
    const kind = b.kind || 'text';
    const clipCode = kind === 'logo' ? 'logo_clipped' : kind === 'border' ? 'border_clipped' : 'text_clipped';
    const minRect = kind === 'logo' ? logoSafeMin : safeMin;
    // Hard: runs off the canvas edge (true bleed).
    if (!insideRect(b, canvasRect)) {
      violations.push({ code: clipCode, kind, severity: 'hard', detail: `${kind} runs off the canvas` });
      continue;
    }
    // Soft: inside the minimum margin (tight to the edge but on the page).
    if (!insideRect(b, minRect)) {
      violations.push({ code: kind === 'logo' ? 'logo_clipped' : 'unsafe_margin', kind, severity: 'soft', detail: `${kind} is inside the minimum safe margin` });
    } else if (kind !== 'logo' && !insideRect(b, safe)) {
      violations.push({ code: 'unsafe_margin', kind, severity: 'soft', detail: `${kind} is tight to the preferred margin` });
    }
  }

  // Soft: overcrowded text — total text height eats too much of the safe box.
  const textBoxes = (boxes || []).filter((b) => b && (b.kind === 'text' || b.kind === 'website'));
  const safeH = safe.bottom - safe.top;
  const textH = textBoxes.reduce((a, b) => a + (b.h || 0), 0);
  if (safeH > 0 && textH / safeH > 0.82) {
    violations.push({ code: 'overcrowded_text', kind: 'text', severity: 'soft', detail: 'text fills more than 82% of the safe area' });
  }

  // Soft: preview crop risk — for portrait, important boxes outside the IG square.
  if (canvas.height > canvas.width) {
    const crop = igCropBox(canvas);
    for (const b of textBoxes) {
      if (!insideRect(b, crop)) {
        violations.push({ code: 'preview_crop_risk', kind: b.kind, severity: 'soft', detail: 'text falls outside the Instagram square crop' });
        break;
      }
    }
    if (!ignore) {
      const logo = (boxes || []).find((b) => b && b.kind === 'logo');
      if (logo && !insideRect(logo, crop)) {
        violations.push({ code: 'preview_crop_risk', kind: 'logo', severity: 'soft', detail: 'logo falls outside the Instagram square crop' });
      }
    }
  }

  const ok = !violations.some((v) => v.severity === 'hard');
  return { ok, violations };
}

module.exports = {
  CANVASES,
  ASPECT_TOLERANCE,
  getCanvas,
  canvasForPlatform,
  safeBox,
  logoInset,
  igCropBox,
  marginX,
  marginY,
  insideRect,
  checkBoxes,
};
