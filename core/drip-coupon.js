/**
 * First Gen Automate — Drip campaign prospect coupons
 *
 * Real, redeemable Stripe promotion codes minted per prospect at Campaign
 * Day 30 ("first month free" offer) and reused verbatim in the Day 60 email.
 *
 * Guarantees (enforced server-side BY STRIPE at checkout):
 *   - 100% off, duration 'once'  -> first subscription payment only
 *   - restricted to the Growth product -> cannot be applied to Scale
 *   - expires_at = Campaign Day 90, max_redemptions = 1
 *   - the $199 setup fee is a separate one-time line item the coupon does
 *     not apply to (coupon is product-restricted to the Growth plan)
 *
 * Idempotent per lead via the drip_coupons UNIQUE(lead_id) row.
 */

const { createLogger } = require('./logger');
const { FGA_TENANT_ID } = require('./config');

const log = createLogger('drip-coupon');

let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}

/** Human-friendly unique code: FGA + company fragment + random. */
function buildCode(lead) {
  const frag = (lead.company_name || lead.name || 'PROSPECT')
    .replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8) || 'PROSPECT';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FGA-${frag}-${rand}`;
}

/**
 * Idempotently ensure the prospect's first-month-free promotion code exists.
 * Returns the drip_coupons row (existing or newly created).
 */
async function ensureProspectCoupon(db, { lead, enrollment }) {
  const { data: existing } = await db
    .from('drip_coupons')
    .select('*')
    .eq('lead_id', lead.id)
    .maybeSingle();
  if (existing) return existing;

  const stripe = getStripe();
  const expiresAt = new Date(new Date(enrollment.day1_at).getTime() + 90 * 86400000);

  // Restrict the coupon to the Growth product so Stripe rejects it on Scale
  // and never discounts the setup-fee line item.
  const growthPriceId = process.env.STRIPE_PRICE_GROWTH;
  if (!growthPriceId) throw new Error('STRIPE_PRICE_GROWTH not configured');
  const growthPrice = await stripe.prices.retrieve(growthPriceId);
  const growthProductId = typeof growthPrice.product === 'string' ? growthPrice.product : growthPrice.product.id;

  // Stripe caps coupon.name at 40 characters. The old template
  // "Drip Day-30 — first month free (<company>)" is 32 chars BEFORE the
  // company, so every real company blew past 40 and Stripe rejected the mint
  // with "Invalid string ...; must be at most 40 characters" — which threw
  // before the Day-30 email could send. (Masked for a month by the drip wedge;
  // surfaced the moment the backlog-skip advanced enrollments to Day 30.)
  // The company is already in metadata.lead_id, so the name doesn't need it.
  const COUPON_NAME_MAX = 40;
  const couponName = `Drip Day-30 free — ${lead.company_name || lead.id}`.slice(0, COUPON_NAME_MAX);

  const coupon = await stripe.coupons.create({
    percent_off: 100,
    duration: 'once',
    name: couponName,
    applies_to: { products: [growthProductId] },
    metadata: { lead_id: lead.id, enrollment_id: enrollment.id, source: 'drip-campaign' },
  });

  const code = buildCode(lead);
  const promo = await stripe.promotionCodes.create({
    coupon: coupon.id,
    code,
    max_redemptions: 1,
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    metadata: { lead_id: lead.id, enrollment_id: enrollment.id, source: 'drip-campaign' },
  });

  const { data: row, error } = await db
    .from('drip_coupons')
    .insert({
      tenant_id: FGA_TENANT_ID,
      lead_id: lead.id,
      enrollment_id: enrollment.id,
      stripe_coupon_id: coupon.id,
      stripe_promotion_code_id: promo.id,
      code,
      expires_at: expiresAt.toISOString(),
      max_redemptions: 1,
      status: 'active',
      metadata: { growth_product_id: growthProductId },
    })
    .select()
    .single();
  if (error) {
    // unique(lead_id) race — another worker created it; deactivate ours
    if (String(error.message).includes('drip_coupons_lead_id_key')) {
      await stripe.promotionCodes.update(promo.id, { active: false }).catch(() => {});
      const { data: winner } = await db.from('drip_coupons').select('*').eq('lead_id', lead.id).maybeSingle();
      return winner;
    }
    throw error;
  }

  await db.from('activity_log').insert({
    tenant_id: FGA_TENANT_ID,
    agent: 'drip-campaign',
    action: 'drip_coupon_created',
    entity_type: 'lead',
    entity_id: lead.id,
    level: 'info',
    metadata: { code, expires_at: expiresAt.toISOString(), stripe_promotion_code_id: promo.id },
  });

  log.success(`Coupon ${code} created for lead ${lead.id} (expires ${expiresAt.toISOString().slice(0, 10)})`);
  return row;
}

/** Active (non-expired, unredeemed) coupon for a lead, or null. */
async function getActiveCoupon(db, leadId) {
  const { data } = await db
    .from('drip_coupons')
    .select('*')
    .eq('lead_id', leadId)
    .maybeSingle();
  if (!data) return null;
  if (data.status !== 'active') return data; // caller checks status
  if (new Date(data.expires_at) < new Date()) {
    await db.from('drip_coupons')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', data.id);
    return { ...data, status: 'expired' };
  }
  return data;
}

/**
 * Called from the Stripe checkout.session.completed webhook. If the session
 * used one of our drip promotion codes, mark it redeemed + audit it.
 */
async function trackCouponRedemption(db, session) {
  try {
    const discounts = session.discounts || [];
    const promoIds = discounts
      .map((d) => (typeof d.promotion_code === 'string' ? d.promotion_code : d.promotion_code?.id))
      .filter(Boolean);
    if (promoIds.length === 0) return { matched: false };

    const { data: coupons } = await db
      .from('drip_coupons')
      .select('*')
      .in('stripe_promotion_code_id', promoIds);
    if (!coupons || coupons.length === 0) return { matched: false };

    for (const c of coupons) {
      await db.from('drip_coupons')
        .update({
          status: 'redeemed',
          redeemed_at: new Date().toISOString(),
          redeemed_session_id: session.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', c.id);
      await db.from('activity_log').insert({
        tenant_id: FGA_TENANT_ID,
        agent: 'stripe-webhook',
        action: 'drip_coupon_redeemed',
        entity_type: 'lead',
        entity_id: c.lead_id,
        level: 'info',
        metadata: { code: c.code, session_id: session.id },
      });
      await db.from('attention_queue').insert({
        tenant_id: FGA_TENANT_ID,
        type: 'drip_coupon_redeemed',
        severity: 'blue',
        title: 'Drip coupon redeemed at checkout',
        summary: `Promo code ${c.code} was redeemed (first month free, Growth plan).`,
        entity_type: 'lead',
        entity_id: c.lead_id,
        payload: { session_id: session.id, code: c.code },
        produced_by: 'drip-campaign',
      }).then(() => {}, () => {});  // builder has no .catch()
      log.success(`Drip coupon ${c.code} redeemed in session ${session.id}`);
    }
    return { matched: true, count: coupons.length };
  } catch (err) {
    log.error(`trackCouponRedemption failed: ${err.message}`);
    return { matched: false, error: err.message };
  }
}

module.exports = { ensureProspectCoupon, getActiveCoupon, trackCouponRedemption, buildCode };
