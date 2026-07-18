/**
 * Public AI Design Studio endpoint (923A Coins).
 *
 * POST /api/design/coin — turn a prospect's guided inputs into an
 * AI-generated challenge-coin CONCEPT (never final artwork — a human
 * designer proofs every order). Email-gated for lead capture and protected
 * by a monthly hard cap so the model spend can never exceed plan margin
 * (see docs/business/ai-design-studio-spec.md).
 *
 * Public (no auth) so the customer-facing site can call it. The global
 * /api/ rate limiter + the monthly cap below bound abuse.
 */

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../core/logger');
const { generateImage } = require('../../integrations/gemini');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');

const MONTHLY_CAP = Number(process.env.AI_DESIGN_MONTHLY_CAP || 500);
const USAGE_KEY = 'ai_design_usage';

function monthStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function readUsage(db) {
  const { data } = await db.from('tenant_config').select('value')
    .eq('tenant_id', FGA_TENANT_ID).eq('key', USAGE_KEY).maybeSingle();
  let u = {};
  try { u = data && data.value ? (typeof data.value === 'string' ? JSON.parse(data.value) : data.value) : {}; } catch { u = {}; }
  if (u.month !== monthStamp()) u = { month: monthStamp(), count: 0 };
  return u;
}

async function writeUsage(db, u) {
  await db.from('tenant_config').upsert(
    { tenant_id: FGA_TENANT_ID, key: USAGE_KEY, value: JSON.stringify(u) },
    { onConflict: 'tenant_id,key' },
  );
}

function buildPrompt(b) {
  const clean = (v, n) => String(v || '').replace(/["\n\r]/g, ' ').trim().slice(0, n);
  const shape = String(b.shape || 'Round');
  const finish = String(b.finish || 'Shiny Brass');
  const edge = String(b.edge || '').trim();
  const symbol = b.symbol && b.symbol !== 'None' ? String(b.symbol) : null;
  const org = clean(b.org, 80);
  const occ = clean(b.occasion, 60);
  const top = clean(b.topText, 40);
  const bottom = clean(b.bottomText, 40);
  const front = clean(b.frontText, 60); // legacy / combined fallback
  const details = clean(b.details, 400);

  const edgePhrase = edge && edge.toLowerCase() !== 'flat'
    ? `a decorative ${edge.toLowerCase()} edge`
    : 'a clean flat edge';

  // Top/bottom text placed separately on the coin; fall back to combined text.
  const textParts = [];
  if (top) textParts.push(`the raised text "${top}" curving across the top`);
  if (bottom) textParts.push(`the raised text "${bottom}" curving across the bottom`);
  if (!top && !bottom && front) textParts.push(`the raised text "${front}" on the coin face`);

  return [
    `A photorealistic studio product photograph of a single custom ${shape.toLowerCase()} military-style challenge coin with a ${finish.toLowerCase()} metal finish and ${edgePhrase}.`,
    symbol ? `The central emblem is a ${symbol.toLowerCase()}.` : 'A bold central emblem suited to the theme.',
    org ? `It represents ${org}.` : '',
    occ ? `It commemorates a ${occ.toLowerCase()}.` : '',
    textParts.length ? (textParts.join(', ') + '.') : '',
    details ? `Additional design direction: ${details}.` : '',
    'Intricate raised relief, dramatic studio lighting, dark neutral background, sharp focus, centered, a single coin only. Original design concept, with no real-world official seals or trademarked insignia.',
  ].filter(Boolean).join(' ');
}

router.post('/coin', async (req, res) => {
  const log = createLogger('ai-design');
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim();
    if (!email || !/.+@.+\..+/.test(email)) {
      return res.status(400).json({ ok: false, error: 'A valid email is required.' });
    }

    const db = getServiceClient();
    const usage = await readUsage(db);

    // Circuit breaker: at the monthly cap we stop calling the model and
    // hand off to a human designer — graceful, never an overage.
    if (usage.count >= MONTHLY_CAP) {
      log.warn(`AI design monthly cap reached (${usage.count}/${MONTHLY_CAP})`);
      return res.json({ ok: true, capped: true });
    }

    const prompt = buildPrompt(b);
    const buf = await generateImage(prompt);

    usage.count += 1;
    await writeUsage(db, usage);
    log.info(`AI coin concept generated (${usage.count}/${MONTHLY_CAP}) for ${email}`);

    res.json({
      ok: true,
      image: `data:image/png;base64,${buf.toString('base64')}`,
      remaining: Math.max(0, MONTHLY_CAP - usage.count),
    });
  } catch (err) {
    log.error(`coin design failed: ${err.message}`);
    res.status(200).json({ ok: false, error: 'Generation hiccup. Try again, or talk to a designer.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/design/render — turn an EXISTING project proof/artwork image into a
// realistic product-mockup render (image→image). Used by the 923A Command Center
// Render Studio. This is a VISUALIZATION only — the manufacturer proof remains the
// production source of truth, and the prompt hard-instructs the model to reproduce
// the source art faithfully (no redesign, no re-lettering, no invented insignia).
//
// Public but bounded like /coin: a monthly hard cap + the global /api rate limiter,
// AND source images must live on our own Supabase Storage host (no arbitrary URLs),
// so it can't be used as a generic image editor.
const RENDER_MONTHLY_CAP = Number(process.env.RENDER_MONTHLY_CAP || 800);
const RENDER_USAGE_KEY = 'render_studio_usage';

async function readRenderUsage(db) {
  const { data } = await db.from('tenant_config').select('value')
    .eq('tenant_id', FGA_TENANT_ID).eq('key', RENDER_USAGE_KEY).maybeSingle();
  let u = {};
  try { u = data && data.value ? (typeof data.value === 'string' ? JSON.parse(data.value) : data.value) : {}; } catch { u = {}; }
  if (u.month !== monthStamp()) u = { month: monthStamp(), count: 0 };
  return u;
}
async function writeRenderUsage(db, u) {
  await db.from('tenant_config').upsert(
    { tenant_id: FGA_TENANT_ID, key: RENDER_USAGE_KEY, value: JSON.stringify(u) },
    { onConflict: 'tenant_id,key' },
  );
}

function allowedStorageHost() {
  try { return new URL(process.env.SUPABASE_URL || '').host || null; } catch { return null; }
}
function isAllowedSourceUrl(u) {
  let host;
  try { host = new URL(u).host; } catch { return false; }
  const allowed = allowedStorageHost();
  // Our Supabase storage host, or any *.supabase.co as a safe fallback.
  return (allowed && host === allowed) || /\.supabase\.co$/i.test(host);
}

const RENDER_FINISH = {
  'high polished gold': 'bright high-polished gold metal',
  'high polished silver': 'bright high-polished silver metal',
  'high polished nickel': 'bright high-polished nickel metal',
  'antique gold': 'darkened antique gold metal that brings out the recessed detail',
  'antique silver': 'darkened antique silver (pewter-like) metal',
  'antique nickel': 'darkened antique nickel metal',
  'antique brass': 'darkened antique brass metal',
  'antique copper': 'darkened antique copper metal',
  'black nickel': 'dark gunmetal black-nickel metal',
  'black metal': 'matte near-black metal',
  'full-color enamel': 'polished metal with full-color soft-enamel fill',
};
const RENDER_BG = {
  'white background': 'a clean seamless white studio background',
  'transparent background': 'a transparent background (isolated product cut-out, no backdrop)',
  'dark background': 'a dark neutral studio background',
  'wood desk': 'a subtle dark wood desk surface',
};
const RENDER_ANGLE = {
  'straight-on': 'photographed straight-on, flat to camera',
  'slight angle': 'photographed at a slight three-quarter angle to show depth and thickness',
};
const RENDER_PRODUCT = {
  'challenge coin': 'challenge coin',
  'enamel pin': 'enamel lapel pin',
  'medal': 'hanging medal',
  'plaque': 'wall/desk recognition plaque',
  'buckle': 'metal belt buckle',
  'patch': 'embroidered patch-style item',
  'other': 'custom recognition product',
};

function buildRenderPrompt(o, imgCount) {
  const product = RENDER_PRODUCT[String(o.productType || '').toLowerCase()] || 'custom recognition product';
  const finish = RENDER_FINISH[String(o.finish || '').toLowerCase()] || 'polished metal';
  const bg = RENDER_BG[String(o.background || '').toLowerCase()] || 'a clean seamless white studio background';
  const angle = RENDER_ANGLE[String(o.style || '').toLowerCase()] || RENDER_ANGLE['slight angle'];
  const twoFace = o.faces === 'front_back';
  const nImg = imgCount || 1;

  const faithful =
    'CRITICAL: Reproduce the supplied artwork EXACTLY — identical layout, every word of text spelled the same, all symbols, seals, insignia, unit names, numbers, slogans, colors, shapes and overall composition. Do NOT redesign, re-letter, translate, add, remove, relocate, or invent ANY element. Do not add military insignia or text that is not already in the source art. The source artwork is the single source of truth.';

  // Our sources are usually 923A PROOF SHEETS: one image that contains the
  // product design PLUS surrounding chrome (a front/back label, a color legend
  // with swatches, dimension/size callouts, a header like "PROOF - V1", the
  // "923A COINS" logo/watermark, and contact footer). None of that is part of
  // the physical product — the model must ignore it and render only the product.
  const ignoreSheet =
    'The supplied image is a manufacturing PROOF/spec sheet. Render ONLY the actual physical product from the design. Do NOT reproduce any proof-sheet markings: ignore and exclude the color legend/swatch key, dimension and size callouts, "front"/"back" labels, the header/version text, page borders, the "923A COINS" logo, any watermark, and the contact footer.';

  if (o.mode === 'enhance') {
    return [
      `Produce a clean, crisp product preview of the supplied ${product} artwork.`,
      'Straighten, center, and lightly sharpen it; remove any surrounding clutter, glare, or backdrop.',
      `Place it on ${bg}.`,
      'Do NOT add 3D, metal, bevel, enamel, or lighting effects — keep it a clean flat reproduction of the art.',
      ignoreSheet,
      faithful,
      'Output a single, centered, high-clarity image.',
    ].join(' ');
  }

  // Which faces to show:
  //  - front_back + 2 images  → image 1 is FRONT, image 2 is BACK
  //  - front_back + 1 image   → the single proof sheet already shows both faces
  //  - front only             → just the front / the single design
  let faceLine;
  if (twoFace && nImg >= 2) {
    faceLine = 'Two source images are provided: image 1 is the FRONT and image 2 is the BACK. Show BOTH faces of the finished product side by side (front on the left, back on the right), matched in size and lighting.';
  } else if (twoFace) {
    faceLine = 'The supplied proof sheet shows BOTH the front and the back of the product. Render BOTH faces of the finished product side by side (front on the left, back on the right), matched in size and lighting, each reproducing its design exactly.';
  } else {
    faceLine = 'Show the front face of the product.';
  }

  return [
    `A photorealistic studio product photograph of a single finished ${product}, manufactured from the supplied design.`,
    `Render it as a real physical ${product} in ${finish}: raised metal borders and relief, color areas filled like enamel, engraved/recessed background, clean bevels, realistic depth, soft studio shadows and gentle specular highlights.`,
    faceLine,
    `${angle}, on ${bg}, sharp focus, the product only, centered.`,
    ignoreSheet,
    faithful,
  ].join(' ');
}

async function fetchImageAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`source fetch ${r.status}`);
  const ct = (r.headers.get('content-type') || 'image/png').split(';')[0];
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length || buf.length > 12 * 1024 * 1024) throw new Error('source too large/empty');
  return { mimeType: /^image\//.test(ct) ? ct : 'image/png', base64: buf.toString('base64') };
}

router.post('/render', async (req, res) => {
  const log = createLogger('render-studio');
  try {
    const b = req.body || {};
    const urls = Array.isArray(b.images)
      ? b.images.map((x) => (x && typeof x === 'object' ? x.url : x)).filter(Boolean).slice(0, 2)
      : [];
    if (!urls.length) return res.status(400).json({ ok: false, error: 'At least one source image is required.' });
    for (const u of urls) {
      if (!isAllowedSourceUrl(u)) return res.status(400).json({ ok: false, error: 'Source images must come from project storage.' });
    }

    const db = getServiceClient();
    const usage = await readRenderUsage(db);
    if (usage.count >= RENDER_MONTHLY_CAP) {
      log.warn(`Render Studio monthly cap reached (${usage.count}/${RENDER_MONTHLY_CAP})`);
      return res.json({ ok: true, capped: true });
    }

    const images = [];
    for (const u of urls) { try { images.push(await fetchImageAsBase64(u)); } catch (e) { log.warn(`skip source: ${e.message}`); } }
    if (!images.length) return res.status(200).json({ ok: false, error: 'Could not read the selected source image(s).' });

    const prompt = buildRenderPrompt(b, images.length);
    const buf = await generateImage(prompt, { images, aspectRatio: '1:1' });

    usage.count += 1;
    await writeRenderUsage(db, usage);
    log.info(`Render generated (${usage.count}/${RENDER_MONTHLY_CAP}) mode=${b.mode || 'render'} product=${b.productType || '?'}`);

    res.json({
      ok: true,
      image: `data:image/png;base64,${buf.toString('base64')}`,
      prompt,
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview',
      provider: 'google',
      remaining: Math.max(0, RENDER_MONTHLY_CAP - usage.count),
    });
  } catch (err) {
    log.error(`render failed: ${err.message}`);
    res.status(200).json({ ok: false, error: 'Render hiccup. Try again, or adjust the source/settings.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/design/parse-proof — READ a 923A proof sheet into structured specs.
// Vision is used ONLY to understand the proof (locate the front/back artwork,
// read the finish/edge/thickness/size). It never redraws the art — the actual
// pixels are cropped client-side from the proof and textured onto a 3D coin, so
// insignia/text/rank can never be altered. Metadata extraction only.
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';

router.post('/parse-proof', async (req, res) => {
  const log = createLogger('proof-parse');
  try {
    const url = String((req.body || {}).imageUrl || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'imageUrl required' });
    if (!isAllowedSourceUrl(url)) return res.status(400).json({ ok: false, error: 'Source must be project storage.' });

    const img = await fetchImageAsBase64(url);
    const prompt = `You are analyzing a 923A Coins manufacturing PROOF SHEET for one custom challenge coin/pin/medal. The sheet shows the FRONT design (usually left) and the BACK design (usually right) of ONE product, plus a header banner, spec text (size, edge "…MM EDGE", thickness, plating/finish like "GOLD" or "ANTIQUE SILVER"), a color legend with swatches, and a faint "923A COINS" watermark.

Return ONLY strict minified JSON (no prose, no markdown) with EXACTLY this schema:
{
 "product_type":"challenge coin|lapel pin|medal|belt buckle|patch|other",
 "shape":"round|shield|rectangle|oval|shaped|other",
 "front_box":[x,y,w,h],
 "back_box":[x,y,w,h],
 "finish":"gold|antique_gold|silver|antique_silver|nickel|antique_nickel|brass|antique_brass|copper|black_nickel|black_metal|two_tone|unknown",
 "finish_raw":"verbatim finish/plating words from the sheet",
 "edge":"verbatim edge text e.g. 4mm, rope, flat",
 "thickness_mm":number_or_null,
 "size_raw":"verbatim size text e.g. 66*76.2mm",
 "colors":[{"name":"","pantone":"","type":""}],
 "confidence":0.0,
 "warnings":[""]
}

CRITICAL box rules:
- front_box and back_box are [x,y,width,height] as fractions of the FULL image (0..1).
- Each box must TIGHTLY bound ONLY that side's coin/product artwork — EXCLUDE the words "front"/"back", the spec text, the color legend, the header banner, the footer, and the watermark.
- If there is no separate back, set "back_box":null.
- Do not invent details. "confidence" is how sure you are the boxes + finish are right; if unsure, lower it and add a warning.
- finish reflects the dominant metal plating (e.g. "raised metal GOLD" -> gold, "GOLD 4MM EDGE" -> gold, "ANTIQUE SILVER" -> antique_silver).`;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inlineData: { mimeType: img.mimeType, data: img.base64 } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
    if (!r.ok) { const t = await r.text(); log.warn(`vision ${r.status} ${t.slice(0, 200)}`); return res.status(200).json({ ok: false, error: 'vision unavailable' }); }
    const data = await r.json();
    const txt = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    let parse = null;
    try { parse = JSON.parse(txt); } catch (_) { const m = txt.match(/\{[\s\S]*\}/); if (m) { try { parse = JSON.parse(m[0]); } catch (_2) {} } }
    if (!parse) return res.status(200).json({ ok: false, error: 'Could not read the proof.' });

    // Crop the EXACT front/back pixels from the proof (never regenerated) so the
    // client can texture the 3D coin with the real artwork. Slight pad for safety.
    const sharp = require('sharp');
    const buf = Buffer.from(img.base64, 'base64');
    let W = 0, H = 0;
    try { const meta = await sharp(buf).metadata(); W = meta.width || 0; H = meta.height || 0; } catch (_) {}
    async function cropBox(box) {
      if (!Array.isArray(box) || box.length < 4 || !W || !H) return null;
      let [x, y, w, h] = box.map(Number);
      if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
      const px = w * 0.04, py = h * 0.04;
      x = Math.max(0, x - px); y = Math.max(0, y - py);
      w = Math.min(1 - x, w + 2 * px); h = Math.min(1 - y, h + 2 * py);
      const left = Math.round(x * W), top = Math.round(y * H);
      const cw = Math.max(1, Math.min(Math.round(w * W), W - left)), ch = Math.max(1, Math.min(Math.round(h * H), H - top));
      try { const out = await sharp(buf).extract({ left, top, width: cw, height: ch }).png().toBuffer(); return 'data:image/png;base64,' + out.toString('base64'); }
      catch (e) { log.warn(`crop failed: ${e.message}`); return null; }
    }
    const front_crop = await cropBox(parse.front_box);
    const back_crop = await cropBox(parse.back_box);

    log.info(`parsed proof: shape=${parse.shape} finish=${parse.finish} conf=${parse.confidence} crops=${!!front_crop}/${!!back_crop}`);
    res.json({ ok: true, parse, front_crop, back_crop, model: GEMINI_VISION_MODEL });
  } catch (err) {
    log.error(`parse failed: ${err.message}`);
    res.status(200).json({ ok: false, error: 'Parse hiccup. Try again, or confirm the details manually.' });
  }
});

module.exports = router;
