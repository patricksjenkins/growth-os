/**
 * Growth OS — Account Management Agent
 * Manages tenant accounts: onboarding status, subscription tracking,
 * module enablement, and account activity summaries.
 *
 * Platform-level agent: operates across tenants (for FGA operator view).
 * Also supports per-tenant self-service queries.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function getAllTenants() {
  const { data, error } = await db
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getTenantConfig(tenantId) {
  const { data, error } = await db
    .from('tenant_config')
    .select('*')
    .eq('tenant_id', tenantId);

  if (error) return {};

  const config = {};
  for (const row of (data || [])) {
    config[row.key] = row.value;
  }
  return config;
}

async function getTenantModules(tenantId) {
  const { data, error } = await db
    .from('tenant_modules')
    .select('*')
    .eq('tenant_id', tenantId);

  if (error) return [];
  return data || [];
}

async function getTenantActivity(tenantId, daysBack = 30) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const { data, error } = await db
    .from('agent_activity_log')
    .select('agent_name, action, status, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getTenantJobs(tenantId, daysBack = 30) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const { data, error } = await db
    .from('agent_jobs')
    .select('agent_name, status, created_at, completed_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getTenantContentCount(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('status')
    .eq('tenant_id', tenantId);

  if (error) return { total: 0, posted: 0 };
  const items = data || [];
  return {
    total: items.length,
    posted: items.filter(i => i.status === 'posted').length,
    drafts: items.filter(i => i.status === 'draft').length
  };
}

async function getTenantLeadCount(tenantId) {
  const { data, error } = await db
    .from('leads')
    .select('status')
    .eq('tenant_id', tenantId);

  if (error) return { total: 0 };
  return { total: (data || []).length };
}

// ============================================================================
// ACCOUNT ANALYSIS
// ============================================================================

function buildAccountSummary(tenant, config, modules, activity, jobs, content, leads) {
  const enabledModules = modules.filter(m => m.enabled);
  const totalJobs = jobs.length;
  const failedJobs = jobs.filter(j => j.status === 'failed').length;
  const successRate = totalJobs > 0 ? Math.round(((totalJobs - failedJobs) / totalJobs) * 100) : 100;

  // Agent usage breakdown
  const agentUsage = {};
  for (const job of jobs) {
    agentUsage[job.agent_name] = (agentUsage[job.agent_name] || 0) + 1;
  }

  // Determine account health indicators
  const issues = [];
  const daysSinceCreation = Math.floor(
    (Date.now() - new Date(tenant.created_at).getTime()) / (1000 * 60 * 60 * 24)
  );

  if (enabledModules.length === 0) {
    issues.push('No modules enabled — account may not be onboarded');
  }

  if (totalJobs === 0 && daysSinceCreation > 7) {
    issues.push('No agent jobs in last 30 days — account may be inactive');
  }

  if (failedJobs > totalJobs * 0.2 && totalJobs > 5) {
    issues.push(`High job failure rate (${100 - successRate}%)`);
  }

  if (content.total === 0 && daysSinceCreation > 14) {
    issues.push('No content generated — content pipeline may not be configured');
  }

  const tier = config.tier || config.subscription_tier || 'unknown';
  const monthlyRate = config.monthly_rate || '0';

  return {
    tenant_id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    tier,
    monthly_rate: parseFloat(monthlyRate),
    created_at: tenant.created_at,
    days_active: daysSinceCreation,
    modules_enabled: enabledModules.length,
    modules_total: modules.length,
    jobs_last_30d: totalJobs,
    job_success_rate: successRate,
    content: content,
    leads: leads,
    agent_usage: agentUsage,
    recent_activity_count: activity.length,
    issues
  };
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant (or platform tenant for overview)
 * @param {Object} payload - { action: 'overview' | 'detail', target_tenant_id?: string }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('account-management', tenant.slug);
  const action = payload.action || 'overview';

  log.info(`Running account management: ${action}`);

  if (action === 'detail') {
    // Single tenant detail
    const targetId = payload.target_tenant_id || tenant.id;

    const { data: targetTenant, error } = await db
      .from('tenants')
      .select('*')
      .eq('id', targetId)
      .single();

    if (error || !targetTenant) {
      return { success: false, error: 'Tenant not found' };
    }

    const [config, modules, activity, jobs, content, leads] = await Promise.all([
      getTenantConfig(targetId),
      getTenantModules(targetId),
      getTenantActivity(targetId),
      getTenantJobs(targetId),
      getTenantContentCount(targetId),
      getTenantLeadCount(targetId)
    ]);

    const summary = buildAccountSummary(targetTenant, config, modules, activity, jobs, content, leads);

    log.success('Account detail generated', { tenant: targetTenant.name });
    return { success: true, account: summary };
  }

  // Overview: all tenants
  const tenants = await getAllTenants();
  const accounts = [];

  for (const t of tenants) {
    const [config, modules, activity, jobs, content, leads] = await Promise.all([
      getTenantConfig(t.id),
      getTenantModules(t.id),
      getTenantActivity(t.id, 30),
      getTenantJobs(t.id, 30),
      getTenantContentCount(t.id),
      getTenantLeadCount(t.id)
    ]);

    accounts.push(buildAccountSummary(t, config, modules, activity, jobs, content, leads));
  }

  // Platform-level metrics
  const totalMRR = accounts.reduce((s, a) => s + a.monthly_rate, 0);
  const activeAccounts = accounts.filter(a => a.status === 'active');
  const accountsWithIssues = accounts.filter(a => a.issues.length > 0);

  log.success('Account overview generated', {
    total: accounts.length,
    active: activeAccounts.length,
    mrr: totalMRR
  });

  return {
    success: true,
    platform: {
      total_accounts: accounts.length,
      active_accounts: activeAccounts.length,
      total_mrr: totalMRR,
      accounts_with_issues: accountsWithIssues.length
    },
    accounts
  };
}

module.exports = run;
