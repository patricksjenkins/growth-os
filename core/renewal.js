/**
 * Growth OS — Renewal & Expansion Automation
 * Phase 8: Operational Automation & Steady State
 *
 * Handles tier upgrades, churn prevention, annual reviews, and payment failures.
 */

const { getServiceClient } = require('../db/client');
const { createLogger } = require('./logger');
const { sendEmail } = require('../integrations/email');
const { sendCriticalAlert } = require('./monitoring');
const { scoreClient } = require('./health-scoring');

const log = createLogger('renewal');

// Tier limits (monthly)
const TIER_LIMITS = {
  starter: { leads: 50, sms: 100, social_posts: 30, photos: 50 },
  growth: { leads: 200, sms: 500, social_posts: 100, photos: 200 },
  scale: { leads: null, sms: null, social_posts: null, photos: null }, // unlimited
};

// ---------------------------------------------------------------------------
// Volume Usage & Upgrade Nudge
// ---------------------------------------------------------------------------

/**
 * Check if a client is approaching any tier limits (>80%)
 */
async function checkVolumeUsage(tenantId) {
  const db = getServiceClient();

  const { data: tenant } = await db
    .from('tenants')
    .select('tier, business_name, slug, owner_email')
    .eq('id', tenantId)
    .single();

  if (!tenant) return null;

  const tier = tenant.tier || 'starter';
  const limits = TIER_LIMITS[tier];
  if (!limits) return { tenant, approaching: [], usage: {} };

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [leadRes, smsRes, postRes, photoRes] = await Promise.all([
    db.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', thirtyDaysAgo),
    db.from('sms_messages').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('sent_at', thirtyDaysAgo),
    db.from('content').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'published').gte('published_at', thirtyDaysAgo),
    db.from('content').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('type', 'photo').gte('created_at', thirtyDaysAgo),
  ]);

  const usage = {
    leads: leadRes.count || 0,
    sms: smsRes.count || 0,
    social_posts: postRes.count || 0,
    photos: photoRes.count || 0,
  };

  const approaching = [];
  for (const [metric, limit] of Object.entries(limits)) {
    if (limit === null) continue; // unlimited
    const used = usage[metric] || 0;
    const pct = (used / limit) * 100;
    if (pct >= 80) {
      approaching.push({ metric, used, limit, percent: Math.round(pct) });
    }
  }

  if (approaching.length > 0) {
    log.info(`${tenant.slug} approaching limits`, { approaching });
  }

  return { tenant, tier, approaching, usage };
}

/**
 * Send upgrade nudge email when client approaches tier limits
 */
async function sendUpgradeNudge(tenantId) {
  const db = getServiceClient();
  const volumeCheck = await checkVolumeUsage(tenantId);
  if (!volumeCheck || !volumeCheck.tenant) return;

  const { tenant, approaching } = volumeCheck;
  if (approaching.length === 0) {
    log.info(`${tenant.slug} not approaching limits, skipping nudge`);
    return;
  }

  const fs = require('fs');
  const path = require('path');
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'emails', 'upgrade-nudge.html'), 'utf8');
    html = html
      .replace(/\{\{business_name\}\}/g, tenant.business_name)
      .replace(/\{\{current_tier\}\}/g, tenant.tier || 'Starter')
      .replace(/\{\{approaching_limits\}\}/g, approaching.map(a => `${a.metric}: ${a.used}/${a.limit} (${a.percent}%)`).join(', '));
  } catch {
    html = `<p>You're growing, ${tenant.business_name}! You're approaching your ${tenant.tier} tier limits. Consider upgrading to unlock more.</p>`;
  }

  await sendEmail(
    {},
    tenant.owner_email,
    `You're growing, ${tenant.business_name}! Time to unlock more.`,
    html,
    { tenantSlug: tenant.slug }
  );

  await db.from('activity_log').insert({
    tenant_id: tenantId,
    type: 'upgrade_nudge',
    details: { approaching, tier: tenant.tier },
  });

  log.info(`Sent upgrade nudge to ${tenant.slug}`);
}

// ---------------------------------------------------------------------------
// Churn Risk Handling
// ---------------------------------------------------------------------------

/**
 * Handle low-usage client: send re-engagement before they cancel
 */
async function handleChurnRisk(tenantId) {
  const db = getServiceClient();

  const { data: tenant } = await db
    .from('tenants')
    .select('business_name, slug, owner_email, tier')
    .eq('id', tenantId)
    .single();

  if (!tenant) return;

  // Get current health score
  let health;
  try {
    health = await scoreClient(tenantId);
  } catch {
    health = { score: 'red', recommendations: ['Unable to score — manual review needed'] };
  }

  log.info(`Handling churn risk for ${tenant.slug}`, { score: health.score });

  const fs = require('fs');
  const path = require('path');
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'emails', 'reengagement.html'), 'utf8');
    html = html.replace(/\{\{business_name\}\}/g, tenant.business_name);
  } catch {
    html = `<p>Hey ${tenant.business_name}, we noticed you haven't been as active. Here are tips to get more value from Growth OS.</p>`;
  }

  await sendEmail(
    {},
    tenant.owner_email,
    `${tenant.business_name}, let's get you back on track`,
    html,
    { tenantSlug: tenant.slug }
  );

  await db.from('activity_log').insert({
    tenant_id: tenantId,
    type: 'churn_risk_outreach',
    details: { health_score: health.score, recommendations: health.recommendations },
  });
}

// ---------------------------------------------------------------------------
// Annual Review
// ---------------------------------------------------------------------------

/**
 * Generate and send year-in-review stats + renewal confirmation
 */
async function processAnnualReview(tenantId) {
  const db = getServiceClient();

  const { data: tenant } = await db
    .from('tenants')
    .select('business_name, slug, owner_email, tier, created_at')
    .eq('id', tenantId)
    .single();

  if (!tenant) return;

  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

  const [leadRes, contentRes, reviewRes, smsRes] = await Promise.all([
    db.from('leads').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', yearAgo),
    db.from('content').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'published').gte('published_at', yearAgo),
    db.from('reviews').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', yearAgo),
    db.from('sms_messages').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('sent_at', yearAgo),
  ]);

  const stats = {
    leads_captured: leadRes.count || 0,
    posts_published: contentRes.count || 0,
    reviews_received: reviewRes.count || 0,
    sms_sent: smsRes.count || 0,
  };

  const fs = require('fs');
  const path = require('path');
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, '..', 'templates', 'emails', 'annual-review.html'), 'utf8');
    html = html
      .replace(/\{\{business_name\}\}/g, tenant.business_name)
      .replace(/\{\{leads_captured\}\}/g, String(stats.leads_captured))
      .replace(/\{\{posts_published\}\}/g, String(stats.posts_published))
      .replace(/\{\{reviews_received\}\}/g, String(stats.reviews_received))
      .replace(/\{\{sms_sent\}\}/g, String(stats.sms_sent))
      .replace(/\{\{tier\}\}/g, tenant.tier || 'Starter');
  } catch {
    html = `<p>Year in review for ${tenant.business_name}: ${stats.leads_captured} leads, ${stats.posts_published} posts, ${stats.reviews_received} reviews.</p>`;
  }

  await sendEmail(
    {},
    tenant.owner_email,
    `Your Year with Growth OS — ${tenant.business_name}`,
    html,
    { tenantSlug: tenant.slug }
  );

  await db.from('activity_log').insert({
    tenant_id: tenantId,
    type: 'annual_review',
    details: stats,
  });

  log.info(`Sent annual review to ${tenant.slug}`, stats);
}

// ---------------------------------------------------------------------------
// Payment Failure Escalation
// ---------------------------------------------------------------------------

/**
 * Handle payment failure with escalating response
 * 1st failure: let Stripe dunning handle it
 * 2nd failure: send direct email to client
 * 3rd failure: alert founder (critical)
 */
async function handlePaymentFailure(tenantId, failureCount) {
  const db = getServiceClient();

  const { data: tenant } = await db
    .from('tenants')
    .select('business_name, slug, owner_email, tier')
    .eq('id', tenantId)
    .single();

  if (!tenant) return;

  log.warn(`Payment failure #${failureCount} for ${tenant.slug}`);

  if (failureCount === 1) {
    // Let Stripe dunning handle it — just log
    log.info(`${tenant.slug}: 1st failure — Stripe dunning active`);
    await db.from('activity_log').insert({
      tenant_id: tenantId,
      type: 'payment_failure',
      details: { failure_count: 1, action: 'stripe_dunning' },
    });
    return;
  }

  if (failureCount === 2) {
    // Direct email to client
    await sendEmail(
      {},
      tenant.owner_email,
      `Action needed: Payment issue on your Growth OS account`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <div style="background:#132A4A;padding:24px;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;">Payment Update Needed</h2>
        </div>
        <div style="border:1px solid #E5E7EB;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
          <p style="color:#132A4A;font-size:16px;">Hey ${tenant.business_name},</p>
          <p style="color:#374151;font-size:15px;">We were unable to process your most recent payment. Please update your payment method to keep your Growth OS services running smoothly.</p>
          <a href="${process.env.APP_URL || 'https://app.firstgenautomate.com'}/billing" style="display:inline-block;background:#22C55E;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:12px;">Update Payment Method</a>
          <p style="color:#6B7280;font-size:13px;margin-top:16px;">If you have questions, reply to this email and we will sort it out.</p>
        </div>
      </div>`,
      { tenantSlug: tenant.slug }
    );

    await db.from('activity_log').insert({
      tenant_id: tenantId,
      type: 'payment_failure',
      details: { failure_count: 2, action: 'client_email' },
    });
    return;
  }

  if (failureCount >= 3) {
    // Critical — alert founder
    await sendCriticalAlert(
      `Payment failed ${failureCount}x for ${tenant.business_name} (${tenant.tier} tier). Immediate action needed.`
    );

    await db.from('activity_log').insert({
      tenant_id: tenantId,
      type: 'payment_failure',
      details: { failure_count: failureCount, action: 'founder_alert' },
    });
    return;
  }
}

module.exports = {
  checkVolumeUsage,
  sendUpgradeNudge,
  handleChurnRisk,
  processAnnualReview,
  handlePaymentFailure,
};
