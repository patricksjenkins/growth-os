/**
 * Growth OS — Client Health Agent
 * Scores tenant health based on engagement, agent usage, content velocity,
 * and pipeline activity. Identifies churn risk and re-engagement opportunities.
 *
 * Platform-level agent: analyzes all active tenants.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// ============================================================================
// HEALTH SCORING WEIGHTS
// ============================================================================

const WEIGHTS = {
  agent_activity: 25,    // Are agents running?
  content_velocity: 20,  // Is content being generated and posted?
  lead_pipeline: 15,     // Are leads being processed?
  job_success: 15,       // Are jobs succeeding?
  recency: 15,           // How recently was the account active?
  module_adoption: 10    // How many modules are enabled?
};

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function getActiveTenants() {
  const { data, error } = await db
    .from('tenants')
    .select('id, name, slug, status, created_at')
    .eq('status', 'active');

  if (error) return [];
  return data || [];
}

async function getTenantMetrics(tenantId, daysBack = 30) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString();

  const [jobsRes, activityRes, contentRes, leadsRes, modulesRes] = await Promise.all([
    db.from('agent_jobs')
      .select('status, created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', sinceStr),

    db.from('agent_activity_log')
      .select('created_at')
      .eq('tenant_id', tenantId)
      .gte('created_at', sinceStr),

    db.from('content_drafts')
      .select('status, created_at, updated_at')
      .eq('tenant_id', tenantId),

    db.from('leads')
      .select('status, created_at')
      .eq('tenant_id', tenantId),

    db.from('tenant_modules')
      .select('enabled')
      .eq('tenant_id', tenantId)
  ]);

  const jobs = jobsRes.data || [];
  const activity = activityRes.data || [];
  const content = contentRes.data || [];
  const leads = leadsRes.data || [];
  const modules = modulesRes.data || [];

  // Recent content (last 30 days)
  const recentContent = content.filter(c =>
    new Date(c.created_at) >= since
  );

  // Recent leads
  const recentLeads = leads.filter(l =>
    new Date(l.created_at) >= since
  );

  // Last activity timestamp
  const lastActivity = activity.length > 0
    ? new Date(activity[0].created_at)
    : null;

  return {
    jobs_total: jobs.length,
    jobs_failed: jobs.filter(j => j.status === 'failed').length,
    jobs_completed: jobs.filter(j => j.status === 'completed').length,
    activity_count: activity.length,
    content_total: content.length,
    content_posted: content.filter(c => c.status === 'posted').length,
    content_recent: recentContent.length,
    leads_total: leads.length,
    leads_recent: recentLeads.length,
    modules_enabled: modules.filter(m => m.enabled).length,
    modules_total: modules.length,
    last_activity: lastActivity,
    days_since_activity: lastActivity
      ? Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
      : 999
  };
}

// ============================================================================
// HEALTH SCORING
// ============================================================================

function computeHealthScore(metrics) {
  const scores = {};

  // Agent Activity (25 pts) — based on job count in last 30 days
  if (metrics.jobs_total >= 50) scores.agent_activity = 25;
  else if (metrics.jobs_total >= 20) scores.agent_activity = 20;
  else if (metrics.jobs_total >= 5) scores.agent_activity = 12;
  else if (metrics.jobs_total >= 1) scores.agent_activity = 5;
  else scores.agent_activity = 0;

  // Content Velocity (20 pts) — recent content generation
  if (metrics.content_recent >= 10) scores.content_velocity = 20;
  else if (metrics.content_recent >= 5) scores.content_velocity = 15;
  else if (metrics.content_recent >= 1) scores.content_velocity = 8;
  else scores.content_velocity = 0;

  // Lead Pipeline (15 pts) — leads being processed
  if (metrics.leads_recent >= 10) scores.lead_pipeline = 15;
  else if (metrics.leads_recent >= 5) scores.lead_pipeline = 12;
  else if (metrics.leads_total >= 1) scores.lead_pipeline = 5;
  else scores.lead_pipeline = 0;

  // Job Success Rate (15 pts)
  const successRate = metrics.jobs_total > 0
    ? (metrics.jobs_completed / metrics.jobs_total)
    : 1;
  if (successRate >= 0.95) scores.job_success = 15;
  else if (successRate >= 0.8) scores.job_success = 10;
  else if (successRate >= 0.5) scores.job_success = 5;
  else scores.job_success = 0;

  // Recency (15 pts) — how recently was the account active
  if (metrics.days_since_activity <= 1) scores.recency = 15;
  else if (metrics.days_since_activity <= 3) scores.recency = 12;
  else if (metrics.days_since_activity <= 7) scores.recency = 8;
  else if (metrics.days_since_activity <= 14) scores.recency = 4;
  else scores.recency = 0;

  // Module Adoption (10 pts)
  const adoptionRate = metrics.modules_total > 0
    ? metrics.modules_enabled / metrics.modules_total
    : 0;
  if (adoptionRate >= 0.8) scores.module_adoption = 10;
  else if (adoptionRate >= 0.5) scores.module_adoption = 7;
  else if (adoptionRate >= 0.2) scores.module_adoption = 3;
  else scores.module_adoption = 0;

  const total = Object.values(scores).reduce((s, v) => s + v, 0);

  let tier, status;
  if (total >= 80) { tier = 'A'; status = 'healthy'; }
  else if (total >= 60) { tier = 'B'; status = 'active'; }
  else if (total >= 35) { tier = 'C'; status = 'at_risk'; }
  else { tier = 'D'; status = 'churning'; }

  return {
    total_score: total,
    tier,
    status,
    breakdown: scores,
    success_rate: Math.round(successRate * 100)
  };
}

function getRecommendations(health, metrics) {
  const recs = [];

  if (health.breakdown.agent_activity < 12) {
    recs.push({
      priority: 'high',
      area: 'engagement',
      message: 'Low agent activity — check if agents are configured and scheduled'
    });
  }

  if (health.breakdown.content_velocity < 8) {
    recs.push({
      priority: 'medium',
      area: 'content',
      message: 'Low content output — review content generation settings and topics'
    });
  }

  if (health.breakdown.recency === 0) {
    recs.push({
      priority: 'high',
      area: 'churn',
      message: `No activity in ${metrics.days_since_activity}+ days — reach out for re-engagement`
    });
  }

  if (health.breakdown.job_success < 10 && metrics.jobs_total > 5) {
    recs.push({
      priority: 'medium',
      area: 'reliability',
      message: `Job success rate is ${health.success_rate}% — investigate failing agents`
    });
  }

  if (health.breakdown.module_adoption < 5) {
    recs.push({
      priority: 'low',
      area: 'adoption',
      message: 'Low module adoption — opportunity to enable more features'
    });
  }

  return recs;
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { target_tenant_id?: string }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('client-health', tenant.slug);

  log.info('Running client health scoring');

  // If a specific tenant is targeted, score just that one
  if (payload.target_tenant_id) {
    const metrics = await getTenantMetrics(payload.target_tenant_id);
    const health = computeHealthScore(metrics);
    const recommendations = getRecommendations(health, metrics);

    log.success('Health scored', { tenant: payload.target_tenant_id, score: health.total_score });
    return { success: true, health, metrics, recommendations };
  }

  // Score all active tenants
  const tenants = await getActiveTenants();
  const results = [];

  for (const t of tenants) {
    const metrics = await getTenantMetrics(t.id);
    const health = computeHealthScore(metrics);
    const recommendations = getRecommendations(health, metrics);

    results.push({
      tenant_id: t.id,
      name: t.name,
      slug: t.slug,
      health,
      recommendations: recommendations.slice(0, 3) // Top 3 per tenant
    });
  }

  // Sort by score ascending (worst first for attention)
  results.sort((a, b) => a.health.total_score - b.health.total_score);

  const tierCounts = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of results) tierCounts[r.health.tier]++;

  const atRisk = results.filter(r => r.health.status === 'at_risk' || r.health.status === 'churning');

  log.success('Client health scoring complete', {
    total: results.length,
    at_risk: atRisk.length,
    tiers: tierCounts
  });

  return {
    success: true,
    total_tenants: results.length,
    tier_breakdown: tierCounts,
    at_risk_count: atRisk.length,
    at_risk: atRisk.map(r => ({ name: r.name, score: r.health.total_score, status: r.health.status })),
    tenants: results
  };
}

module.exports = run;
