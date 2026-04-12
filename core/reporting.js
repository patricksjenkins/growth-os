/**
 * Growth OS — Automated Reporting System
 * Phase 8: Operational Automation & Steady State
 *
 * Generates client reports, daily digests, and weekly summaries.
 */

const fs = require('fs');
const path = require('path');
const { getServiceClient } = require('../db/client');
const { createLogger } = require('./logger');
const { scoreAllClients } = require('./health-scoring');

const log = createLogger('reporting');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'emails');

// ---------------------------------------------------------------------------
// Template Helpers
// ---------------------------------------------------------------------------

function loadTemplate(name) {
  const filePath = path.join(TEMPLATES_DIR, name);
  return fs.readFileSync(filePath, 'utf8');
}

function renderTemplate(html, data) {
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return data[key] !== undefined ? String(data[key]) : match;
  });
}

// ---------------------------------------------------------------------------
// Client Monthly Report
// ---------------------------------------------------------------------------

/**
 * Generate a monthly report for a single client
 * @param {string} tenantId
 * @param {string} period - 'YYYY-MM' format
 */
async function generateClientReport(tenantId, period) {
  const db = getServiceClient();

  const [year, month] = period.split('-').map(Number);
  const startDate = new Date(year, month - 1, 1).toISOString();
  const endDate = new Date(year, month, 1).toISOString();

  const { data: tenant } = await db
    .from('tenants')
    .select('business_name, slug, tier')
    .eq('id', tenantId)
    .single();

  // Gather metrics in parallel
  const [leads, content, reviews, sms] = await Promise.all([
    getLeadMetrics(db, tenantId, startDate, endDate),
    getContentMetrics(db, tenantId, startDate, endDate),
    getReviewMetrics(db, tenantId, startDate, endDate),
    getSmsMetrics(db, tenantId, startDate, endDate),
  ]);

  const report = {
    tenant_id: tenantId,
    business_name: tenant?.business_name || 'Unknown',
    slug: tenant?.slug || '',
    tier: tenant?.tier || '',
    period,
    generated_at: new Date().toISOString(),
    leads,
    content,
    reviews,
    sms,
  };

  log.info(`Generated monthly report for ${report.business_name}`, { period });
  return report;
}

async function getLeadMetrics(db, tenantId, start, end) {
  const { count: newLeads } = await db
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', start)
    .lt('created_at', end);

  const { count: converted } = await db
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'converted')
    .gte('updated_at', start)
    .lt('updated_at', end);

  const { data: pipeline } = await db
    .from('leads')
    .select('estimated_value')
    .eq('tenant_id', tenantId)
    .in('status', ['new', 'contacted', 'quoted']);

  const pipelineValue = (pipeline || []).reduce((sum, l) => sum + (l.estimated_value || 0), 0);

  return { new_leads: newLeads || 0, converted: converted || 0, total_pipeline_value: pipelineValue };
}

async function getContentMetrics(db, tenantId, start, end) {
  const { count: published } = await db
    .from('content')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .gte('published_at', start)
    .lt('published_at', end);

  const { data: engagement } = await db
    .from('content')
    .select('engagement_count')
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .gte('published_at', start)
    .lt('published_at', end);

  const totalEngagement = (engagement || []).reduce((sum, c) => sum + (c.engagement_count || 0), 0);

  return { posts_published: published || 0, total_engagement: totalEngagement };
}

async function getReviewMetrics(db, tenantId, start, end) {
  const { data: reviews } = await db
    .from('reviews')
    .select('rating')
    .eq('tenant_id', tenantId)
    .gte('created_at', start)
    .lt('created_at', end);

  const count = reviews ? reviews.length : 0;
  const avgRating = count > 0
    ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / count).toFixed(1)
    : 'N/A';

  return { new_reviews: count, average_rating: avgRating };
}

async function getSmsMetrics(db, tenantId, start, end) {
  const { count: sent } = await db
    .from('sms_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('sent_at', start)
    .lt('sent_at', end);

  const { count: responded } = await db
    .from('sms_messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('has_response', true)
    .gte('sent_at', start)
    .lt('sent_at', end);

  const totalSent = sent || 0;
  const totalResponded = responded || 0;
  const responseRate = totalSent > 0 ? ((totalResponded / totalSent) * 100).toFixed(1) + '%' : 'N/A';

  return { messages_sent: totalSent, response_rate: responseRate };
}

// ---------------------------------------------------------------------------
// Batch Client Reports
// ---------------------------------------------------------------------------

/**
 * Generate monthly reports for all active clients
 */
async function generateAllClientReports(period) {
  const db = getServiceClient();
  const { data: tenants } = await db
    .from('tenants')
    .select('id, business_name, slug')
    .eq('status', 'active');

  const reports = [];
  for (const tenant of tenants || []) {
    try {
      const report = await generateClientReport(tenant.id, period);
      reports.push(report);
    } catch (err) {
      log.error(`Failed to generate report for ${tenant.slug}`, err);
    }
  }

  log.info(`Generated ${reports.length} client reports for ${period}`);
  return reports;
}

// ---------------------------------------------------------------------------
// Founder Daily Digest
// ---------------------------------------------------------------------------

/**
 * Generate the founder's daily digest (2-minute scan)
 */
async function generateFounderDailyDigest() {
  const db = getServiceClient();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // New leads today across all tenants
  const { data: newLeads } = await db
    .from('leads')
    .select('id, tenant_id, name, source, created_at')
    .gte('created_at', todayStr)
    .order('created_at', { ascending: false });

  // Enrich with tenant names
  const tenantIds = [...new Set((newLeads || []).map(l => l.tenant_id))];
  const tenantMap = {};
  if (tenantIds.length > 0) {
    const { data: tenants } = await db
      .from('tenants')
      .select('id, business_name')
      .in('id', tenantIds);
    for (const t of tenants || []) tenantMap[t.id] = t.business_name;
  }

  const enrichedLeads = (newLeads || []).map(l => ({
    ...l,
    tenant_name: tenantMap[l.tenant_id] || 'Unknown',
  }));

  // Open support tickets
  const { data: tickets } = await db
    .from('support_tickets')
    .select('id, tenant_id, subject, priority, status')
    .in('status', ['open', 'escalated'])
    .order('priority', { ascending: false });

  // Content published today
  const { count: postsToday } = await db
    .from('content')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'published')
    .gte('published_at', todayStr);

  // Total active tenants
  const { count: totalTenants } = await db
    .from('tenants')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');

  // Total leads this week
  const { count: leadsThisWeek } = await db
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', weekAgo);

  // System status
  const { data: latestPlatform } = await db
    .from('platform_health_checks')
    .select('service, status')
    .order('created_at', { ascending: false })
    .limit(5);

  const issues = (latestPlatform || []).filter(p => p.status !== 'healthy');

  return {
    date: today.toISOString().split('T')[0],
    generated_at: new Date().toISOString(),
    system_status: issues.length === 0 ? 'All systems operational' : `${issues.length} issue(s)`,
    system_issues: issues,
    new_leads: enrichedLeads,
    support_tickets: tickets || [],
    posts_published_today: postsToday || 0,
    total_active_tenants: totalTenants || 0,
    leads_this_week: leadsThisWeek || 0,
  };
}

// ---------------------------------------------------------------------------
// Founder Weekly Digest
// ---------------------------------------------------------------------------

/**
 * Generate the founder's weekly summary
 */
async function generateFounderWeeklyDigest() {
  const db = getServiceClient();
  const now = new Date();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // MRR — sum of active subscriptions
  const { data: subs } = await db
    .from('tenant_subscriptions')
    .select('amount, tenant_id')
    .eq('status', 'active');

  const currentMrr = (subs || []).reduce((sum, s) => sum + (s.amount || 0), 0);

  // Previous week MRR (approximate — count subs that existed then)
  const { data: prevSubs } = await db
    .from('tenant_subscriptions')
    .select('amount')
    .eq('status', 'active')
    .lte('created_at', weekAgo);

  const prevMrr = (prevSubs || []).reduce((sum, s) => sum + (s.amount || 0), 0);

  // Pipeline — prospects by stage
  const { data: prospects } = await db
    .from('sales_pipeline')
    .select('stage, deal_value')
    .neq('stage', 'closed_lost');

  const pipeline = {};
  let totalPipelineValue = 0;
  for (const p of prospects || []) {
    if (!pipeline[p.stage]) pipeline[p.stage] = { count: 0, value: 0 };
    pipeline[p.stage].count++;
    pipeline[p.stage].value += p.deal_value || 0;
    totalPipelineValue += p.deal_value || 0;
  }

  // Client health scores
  let healthScores = [];
  try {
    healthScores = await scoreAllClients();
  } catch (err) {
    log.error('Failed to score clients for weekly digest', err);
  }

  const healthSummary = {
    green: healthScores.filter(h => h.score === 'green').length,
    yellow: healthScores.filter(h => h.score === 'yellow').length,
    red: healthScores.filter(h => h.score === 'red').length,
    at_risk: healthScores.filter(h => h.score !== 'green'),
  };

  // Revenue this week (charges)
  const { data: charges } = await db
    .from('payments')
    .select('amount, status')
    .gte('created_at', weekAgo);

  const weekRevenue = (charges || []).filter(c => c.status === 'succeeded').reduce((s, c) => s + (c.amount || 0), 0);
  const failedPayments = (charges || []).filter(c => c.status === 'failed');

  // Content published this week
  const { count: weekContent } = await db
    .from('content')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'published')
    .gte('published_at', weekAgo);

  // Upcoming: demos and onboardings
  const { data: demos } = await db
    .from('sales_pipeline')
    .select('business_name, demo_date')
    .eq('stage', 'demo_scheduled')
    .gte('demo_date', now.toISOString())
    .order('demo_date', { ascending: true });

  const { data: onboardings } = await db
    .from('tenants')
    .select('business_name, onboarding_status')
    .eq('status', 'active')
    .neq('onboarding_status', 'complete');

  // Action items
  const actionItems = [];
  if (healthSummary.red > 0) {
    actionItems.push(`${healthSummary.red} client(s) scored RED — review immediately`);
  }
  if (failedPayments.length > 0) {
    actionItems.push(`${failedPayments.length} failed payment(s) this week`);
  }
  if ((onboardings || []).length > 0) {
    actionItems.push(`${onboardings.length} onboarding(s) in progress`);
  }

  return {
    week_ending: now.toISOString().split('T')[0],
    generated_at: now.toISOString(),
    mrr: { current: currentMrr, previous: prevMrr, change: currentMrr - prevMrr },
    pipeline: { stages: pipeline, total_value: totalPipelineValue },
    client_health: healthSummary,
    revenue: { week_total: weekRevenue, failed_payments: failedPayments.length },
    content: { posts_published: weekContent || 0 },
    upcoming: {
      demos: demos || [],
      onboardings: onboardings || [],
    },
    action_items: actionItems,
  };
}

// ---------------------------------------------------------------------------
// HTML Rendering
// ---------------------------------------------------------------------------

/**
 * Render report data as HTML using the appropriate template
 */
function formatReportAsHtml(reportData) {
  let templateName;
  if (reportData.period) {
    templateName = 'client-monthly-report.html';
  } else if (reportData.mrr) {
    templateName = 'weekly-digest.html';
  } else {
    templateName = 'daily-digest.html';
  }

  try {
    const template = loadTemplate(templateName);
    return renderTemplate(template, flattenForTemplate(reportData));
  } catch (err) {
    log.warn(`Template ${templateName} not found, using fallback rendering`);
    return `<pre style="font-family:monospace;">${JSON.stringify(reportData, null, 2)}</pre>`;
  }
}

/**
 * Flatten nested report data into top-level keys for simple {{key}} replacement
 */
function flattenForTemplate(data, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(result, flattenForTemplate(value, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

module.exports = {
  generateClientReport,
  generateAllClientReports,
  generateFounderDailyDigest,
  generateFounderWeeklyDigest,
  formatReportAsHtml,
};
