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

module.exports = router;
