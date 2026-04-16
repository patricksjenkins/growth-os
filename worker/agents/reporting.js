/**
 * Growth OS — Reporting Agent
 * Generates periodic reports: weekly summaries, monthly reviews,
 * and quarterly business reports with AI-powered insights.
 *
 * Multi-tenant: scoped by tenant_id.
 * Uses finance_entries, content_drafts, leads, agent_activity_log, agent_jobs.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { askClaude } = require('../../integrations/claude');

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function getDateRangeEntries(tenantId, startDate, endDate) {
  const { data, error } = await db
    .from('finance_entries')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });

  if (error) return [];
  return data || [];
}

async function getDateRangeContent(tenantId, startDate, endDate) {
  const { data, error } = await db
    .from('content_drafts')
    .select('status, platform, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', startDate)
    .lte('created_at', endDate);

  if (error) return [];
  return data || [];
}

async function getDateRangeLeads(tenantId, startDate, endDate) {
  const { data, error } = await db
    .from('leads')
    .select('status, priority_tier, lifecycle_stage, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', startDate)
    .lte('created_at', endDate);

  if (error) return [];
  return data || [];
}

async function getDateRangeJobs(tenantId, startDate, endDate) {
  const { data, error } = await db
    .from('agent_jobs')
    .select('agent_name, status, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', startDate)
    .lte('created_at', endDate);

  if (error) return [];
  return data || [];
}

// ============================================================================
// REPORT BUILDERS
// ============================================================================

function computeFinanceMetrics(entries) {
  const income = entries.filter(e => e.entry_type === 'income');
  const expenses = entries.filter(e => e.entry_type === 'expense');

  const totalIncome = income.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  const expensesByCategory = {};
  for (const exp of expenses) {
    const cat = exp.category || 'Other';
    expensesByCategory[cat] = (expensesByCategory[cat] || 0) + (parseFloat(exp.amount) || 0);
  }

  return {
    total_income: totalIncome,
    total_expenses: totalExpenses,
    net_profit: totalIncome - totalExpenses,
    margin_pct: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0,
    income_entries: income.length,
    expense_entries: expenses.length,
    expenses_by_category: expensesByCategory
  };
}

function computeContentMetrics(content) {
  const byStatus = {};
  const byPlatform = {};

  for (const c of content) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    byPlatform[c.platform] = (byPlatform[c.platform] || 0) + 1;
  }

  return {
    total: content.length,
    posted: byStatus.posted || 0,
    drafts: byStatus.draft || 0,
    approved: byStatus.approved || 0,
    rejected: byStatus.rejected || 0,
    by_platform: byPlatform
  };
}

function computeLeadMetrics(leads) {
  const byTier = {};
  const byStatus = {};

  for (const l of leads) {
    if (l.priority_tier) byTier[l.priority_tier] = (byTier[l.priority_tier] || 0) + 1;
    if (l.status) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  }

  return {
    total_new: leads.length,
    by_tier: byTier,
    by_status: byStatus
  };
}

function computeAgentMetrics(jobs) {
  const byAgent = {};
  let completed = 0, failed = 0;

  for (const j of jobs) {
    byAgent[j.agent_name] = (byAgent[j.agent_name] || 0) + 1;
    if (j.status === 'completed') completed++;
    if (j.status === 'failed') failed++;
  }

  return {
    total_jobs: jobs.length,
    completed,
    failed,
    success_rate: jobs.length > 0 ? Math.round((completed / jobs.length) * 100) : 100,
    by_agent: byAgent
  };
}

// ============================================================================
// REPORT FORMATTING
// ============================================================================

function formatReport(period, periodLabel, finance, content, leads, agents, businessName) {
  const lines = [
    `${businessName} — ${periodLabel} Report`,
    `Period: ${period.start} to ${period.end}`,
    '═'.repeat(50),
    '',
    'FINANCIAL SUMMARY',
    `  Revenue:     $${finance.total_income.toFixed(2)}`,
    `  Expenses:    $${finance.total_expenses.toFixed(2)}`,
    `  Net Profit:  $${finance.net_profit.toFixed(2)} (${finance.margin_pct}% margin)`,
    ''
  ];

  if (Object.keys(finance.expenses_by_category).length > 0) {
    lines.push('  Top Expense Categories:');
    const sorted = Object.entries(finance.expenses_by_category)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    for (const [cat, amt] of sorted) {
      lines.push(`    ${cat}: $${amt.toFixed(2)}`);
    }
    lines.push('');
  }

  lines.push(
    'CONTENT PIPELINE',
    `  Generated: ${content.total} | Posted: ${content.posted} | Drafts: ${content.drafts}`,
    ''
  );

  if (Object.keys(content.by_platform).length > 0) {
    lines.push('  By Platform:');
    for (const [platform, count] of Object.entries(content.by_platform)) {
      lines.push(`    ${platform}: ${count}`);
    }
    lines.push('');
  }

  lines.push(
    'LEAD PIPELINE',
    `  New Leads: ${leads.total_new}`
  );

  if (Object.keys(leads.by_tier).length > 0) {
    const tiers = Object.entries(leads.by_tier).map(([t, c]) => `Tier ${t}: ${c}`).join(' | ');
    lines.push(`  ${tiers}`);
  }
  lines.push('');

  lines.push(
    'AGENT OPERATIONS',
    `  Jobs Run: ${agents.total_jobs} | Success Rate: ${agents.success_rate}%`,
    `  Completed: ${agents.completed} | Failed: ${agents.failed}`,
    ''
  );

  if (Object.keys(agents.by_agent).length > 0) {
    lines.push('  Most Active Agents:');
    const sorted = Object.entries(agents.by_agent)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    for (const [agent, count] of sorted) {
      lines.push(`    ${agent}: ${count} jobs`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// AI INSIGHTS
// ============================================================================

async function generateInsights(report, finance, content, leads, agents) {
  const systemPrompt = `You are a business analyst. Given a period report, provide 3-5 concise, actionable insights. Focus on trends, risks, and opportunities. Keep each insight to 1-2 sentences. Return plain text, one insight per line prefixed with "•".`;

  const dataContext = JSON.stringify({
    revenue: finance.total_income,
    expenses: finance.total_expenses,
    net: finance.net_profit,
    margin: finance.margin_pct,
    content_posted: content.posted,
    content_generated: content.total,
    new_leads: leads.total_new,
    agent_success_rate: agents.success_rate,
    failed_jobs: agents.failed
  });

  try {
    const insights = await askClaude(
      systemPrompt,
      `Report data:\n${dataContext}`,
      { maxTokens: 512, temperature: 0.3 }
    );
    return insights;
  } catch {
    return null;
  }
}

// ============================================================================
// PERIOD HELPERS
// ============================================================================

function getWeekRange() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  return {
    start: start.toISOString().split('T')[0],
    end: now.toISOString().split('T')[0]
  };
}

function getMonthRange(month, year) {
  const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
  const end = new Date(year, month, 0).toISOString().split('T')[0];
  return { start, end };
}

function getQuarterRange(quarter, year) {
  const startMonth = (quarter - 1) * 3;
  const start = new Date(year, startMonth, 1).toISOString().split('T')[0];
  const end = new Date(year, startMonth + 3, 0).toISOString().split('T')[0];
  return { start, end };
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { type: 'weekly'|'monthly'|'quarterly', month?, year?, quarter? }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('reporting', tenant.slug);
  const type = payload.type || 'weekly';
  const now = new Date();

  let period, periodLabel;

  if (type === 'quarterly') {
    const quarter = payload.quarter || Math.ceil((now.getMonth() + 1) / 3);
    const year = payload.year || now.getFullYear();
    period = getQuarterRange(quarter, year);
    periodLabel = `Q${quarter} ${year}`;
  } else if (type === 'monthly') {
    const month = payload.month || now.getMonth() + 1;
    const year = payload.year || now.getFullYear();
    period = getMonthRange(month, year);
    const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });
    periodLabel = `${monthName} ${year}`;
  } else {
    period = getWeekRange();
    periodLabel = 'Weekly';
  }

  log.info(`Generating ${periodLabel} report`);

  const [entries, content, leads, jobs] = await Promise.all([
    getDateRangeEntries(tenant.id, period.start, period.end),
    getDateRangeContent(tenant.id, period.start, period.end),
    getDateRangeLeads(tenant.id, period.start, period.end),
    getDateRangeJobs(tenant.id, period.start, period.end)
  ]);

  const finance = computeFinanceMetrics(entries);
  const contentMetrics = computeContentMetrics(content);
  const leadMetrics = computeLeadMetrics(leads);
  const agentMetrics = computeAgentMetrics(jobs);

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Growth OS');
  const report = formatReport(period, periodLabel, finance, contentMetrics, leadMetrics, agentMetrics, businessName);

  // Generate AI insights
  const insights = await generateInsights(report, finance, contentMetrics, leadMetrics, agentMetrics);

  log.success(`${periodLabel} report generated`, {
    revenue: finance.total_income,
    content: contentMetrics.total,
    leads: leadMetrics.total_new
  });

  return {
    success: true,
    type,
    period,
    period_label: periodLabel,
    report,
    insights,
    metrics: {
      finance,
      content: contentMetrics,
      leads: leadMetrics,
      agents: agentMetrics
    }
  };
}

module.exports = run;
