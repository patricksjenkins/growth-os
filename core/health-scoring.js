/**
 * Growth OS — Client Health Scoring System
 * Phase 8: Operational Automation & Steady State
 *
 * Scores each tenant green/yellow/red based on:
 *   - App usage (photo uploads, content approvals in last 7d)
 *   - Lead volume (last 30d trend)
 *   - Payment status
 *   - Support tickets
 */

const { getServiceClient } = require('../db/client');
const { createLogger } = require('./logger');
const { sendEmail } = require('../integrations/email');

const log = createLogger('health-scoring');

// ---------------------------------------------------------------------------
// Score a Single Client
// ---------------------------------------------------------------------------

/**
 * Score a single tenant and persist the result
 * @returns {{ score: 'green'|'yellow'|'red', factors: Object, recommendations: string[] }}
 */
async function scoreClient(tenantId) {
  const db = getServiceClient();

  const [usage, leads, payment, support] = await Promise.all([
    measureAppUsage(db, tenantId),
    measureLeadVolume(db, tenantId),
    measurePaymentStatus(db, tenantId),
    measureSupportTickets(db, tenantId),
  ]);

  const factors = {
    app_usage: usage,
    lead_volume: leads,
    payment_status: payment,
    support_tickets: support,
  };

  // Determine overall score
  const scores = [usage.score, leads.score, payment.score, support.score];
  let overall;
  if (scores.includes('red')) {
    overall = 'red';
  } else if (scores.includes('yellow')) {
    overall = 'yellow';
  } else {
    overall = 'green';
  }

  const recommendations = buildRecommendations(factors);

  const result = { score: overall, factors, recommendations };

  // Persist
  await db.from('client_health_scores').insert({
    tenant_id: tenantId,
    score: overall,
    factors,
    recommendations,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Measurement Functions
// ---------------------------------------------------------------------------

async function measureAppUsage(db, tenantId) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Photo uploads
  const { count: photoCount } = await db
    .from('content')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('type', 'photo')
    .gte('created_at', weekAgo);

  // Content approvals
  const { count: approvalCount } = await db
    .from('content')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'approved')
    .gte('updated_at', weekAgo);

  const actions = (photoCount || 0) + (approvalCount || 0);
  let score;
  if (actions >= 3) score = 'green';
  else if (actions >= 1) score = 'yellow';
  else score = 'red';

  return { score, photo_uploads: photoCount || 0, content_approvals: approvalCount || 0, total_actions: actions };
}

async function measureLeadVolume(db, tenantId) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Current period
  const { count: currentLeads } = await db
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', thirtyDaysAgo);

  // Previous period (for trend)
  const { count: previousLeads } = await db
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', sixtyDaysAgo)
    .lt('created_at', thirtyDaysAgo);

  const current = currentLeads || 0;
  const previous = previousLeads || 0;

  let score;
  if (current === 0) score = 'red';
  else if (current < previous) score = 'yellow';
  else score = 'green';

  return { score, current_period: current, previous_period: previous, trend: current - previous };
}

async function measurePaymentStatus(db, tenantId) {
  // Check subscription/payment status from tenant_subscriptions or similar
  const { data: sub } = await db
    .from('tenant_subscriptions')
    .select('status, failed_payment_count')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!sub) {
    return { score: 'green', status: 'no_subscription', failed_payments: 0 };
  }

  const failedCount = sub.failed_payment_count || 0;
  let score;
  if (sub.status === 'active' && failedCount === 0) score = 'green';
  else if (sub.status === 'past_due' || failedCount === 1) score = 'yellow';
  else score = 'red';

  return { score, status: sub.status, failed_payments: failedCount };
}

async function measureSupportTickets(db, tenantId) {
  const { count: openTickets } = await db
    .from('support_tickets')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .in('status', ['open', 'in_progress']);

  const count = openTickets || 0;
  let score;
  if (count <= 1) score = 'green';
  else if (count <= 3) score = 'yellow';
  else score = 'red';

  return { score, open_tickets: count };
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

function buildRecommendations(factors) {
  const recs = [];

  if (factors.app_usage.score === 'red') {
    recs.push('Client has not used the app in 7 days — send re-engagement email');
  } else if (factors.app_usage.score === 'yellow') {
    recs.push('Low app activity — consider a check-in call');
  }

  if (factors.lead_volume.score === 'red') {
    recs.push('Zero leads in 30 days — review ad campaigns and lead sources');
  } else if (factors.lead_volume.score === 'yellow') {
    recs.push('Lead volume declining — review marketing strategy');
  }

  if (factors.payment_status.score === 'red') {
    recs.push('Payment failures detected — immediate outreach needed');
  } else if (factors.payment_status.score === 'yellow') {
    recs.push('Payment past due — dunning in progress');
  }

  if (factors.support_tickets.score !== 'green') {
    recs.push(`${factors.support_tickets.open_tickets} open support tickets — prioritize resolution`);
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Batch Scoring
// ---------------------------------------------------------------------------

/**
 * Score all active tenants, return sorted by risk (red first, then yellow)
 */
async function scoreAllClients() {
  const db = getServiceClient();
  const { data: tenants, error } = await db
    .from('tenants')
    .select('id, business_name, slug, tier')
    .eq('status', 'active');

  if (error) {
    log.error('Failed to fetch tenants for scoring', error);
    return [];
  }

  const results = [];
  for (const tenant of tenants || []) {
    try {
      const score = await scoreClient(tenant.id);
      results.push({ tenant_id: tenant.id, business_name: tenant.business_name, slug: tenant.slug, tier: tenant.tier, ...score });
    } catch (err) {
      log.error(`Failed to score tenant ${tenant.slug || tenant.id}`, err);
      results.push({ tenant_id: tenant.id, business_name: tenant.business_name, slug: tenant.slug, score: 'red', error: err.message });
    }
  }

  // Sort: red first, then yellow, then green
  const priority = { red: 0, yellow: 1, green: 2 };
  results.sort((a, b) => (priority[a.score] ?? 3) - (priority[b.score] ?? 3));

  log.info('Client scoring complete', {
    total: results.length,
    red: results.filter(r => r.score === 'red').length,
    yellow: results.filter(r => r.score === 'yellow').length,
    green: results.filter(r => r.score === 'green').length,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Health Trend
// ---------------------------------------------------------------------------

/**
 * Get score history over time for trend analysis
 */
async function getHealthTrend(tenantId, days = 30) {
  const db = getServiceClient();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from('client_health_scores')
    .select('score, factors, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (error) {
    log.error(`Failed to fetch health trend for ${tenantId}`, error);
    return [];
  }

  return data || [];
}

// ---------------------------------------------------------------------------
// Re-engagement & Alerts
// ---------------------------------------------------------------------------

/**
 * For yellow clients: send automated re-engagement email
 */
async function triggerReengagement(tenantId) {
  const db = getServiceClient();
  const { data: tenant } = await db
    .from('tenants')
    .select('business_name, slug, owner_email')
    .eq('id', tenantId)
    .single();

  if (!tenant) {
    log.warn(`Cannot re-engage: tenant ${tenantId} not found`);
    return;
  }

  log.info(`Triggering re-engagement for ${tenant.slug}`);

  await sendEmail(
    {},
    tenant.owner_email,
    `We miss you, ${tenant.business_name}! Here's how to get more from Growth OS`,
    buildReengagementHtml(tenant),
    { tenantSlug: tenant.slug }
  );

  // Log the action
  await db.from('activity_log').insert({
    tenant_id: tenantId,
    type: 'reengagement_email',
    details: { triggered_by: 'health_scoring', recipient: tenant.owner_email },
  });
}

function buildReengagementHtml(tenant) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
    <div style="background:#132A4A;padding:24px;border-radius:8px 8px 0 0;">
      <h2 style="color:#fff;margin:0;">Hey ${tenant.business_name}!</h2>
    </div>
    <div style="border:1px solid #E5E7EB;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
      <p style="color:#132A4A;font-size:16px;">We noticed you have not been as active lately. Here are a few things you can do right now to drive more leads:</p>
      <ul style="color:#374151;font-size:15px;line-height:1.8;">
        <li>Upload new project photos to auto-generate social posts</li>
        <li>Check your lead inbox — you may have new prospects waiting</li>
        <li>Approve pending content to keep your social presence active</li>
      </ul>
      <a href="${process.env.APP_URL || 'https://app.firstgenautomate.com'}" style="display:inline-block;background:#22C55E;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:8px;">Open Growth OS</a>
    </div>
  </div>`;
}

/**
 * For red clients: immediate founder notification
 */
async function alertFounder(tenantId, reason) {
  const db = getServiceClient();
  const { data: tenant } = await db
    .from('tenants')
    .select('business_name, slug, tier')
    .eq('id', tenantId)
    .single();

  const founderEmail = process.env.FOUNDER_EMAIL || 'patrick@firstgenautomate.com';
  const name = tenant?.business_name || tenantId;

  log.warn(`Alerting founder about at-risk client: ${name} — ${reason}`);

  await sendEmail(
    {},
    founderEmail,
    `[At Risk] ${name} needs attention`,
    `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
      <div style="background:#F59E0B;padding:16px 24px;border-radius:8px 8px 0 0;">
        <h2 style="color:#fff;margin:0;">Client At Risk</h2>
      </div>
      <div style="border:1px solid #E5E7EB;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
        <p style="font-size:16px;color:#132A4A;"><strong>${name}</strong> (${tenant?.tier || 'unknown'} tier)</p>
        <p style="font-size:15px;color:#374151;">Reason: ${reason}</p>
        <p style="font-size:14px;color:#6B7280;">Action needed — review this client and reach out.</p>
      </div>
    </div>`,
    { tenantSlug: 'platform' }
  );
}

module.exports = {
  scoreClient,
  scoreAllClients,
  getHealthTrend,
  triggerReengagement,
  alertFounder,
};
