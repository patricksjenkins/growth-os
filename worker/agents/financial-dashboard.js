/**
 * Growth OS — Financial Dashboard Agent
 * Generates financial snapshots, KPI summaries, and trend analysis.
 * Powers the mobile app finance overview with pre-computed metrics.
 *
 * Multi-tenant: scoped by tenant_id.
 * Uses finance_entries, debt_tracker, crew_members, crew_daily_log.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function getYearEntries(tenantId, year) {
  const { data, error } = await db
    .from('finance_entries')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('date', `${year}-01-01`)
    .lte('date', `${year}-12-31`)
    .order('date', { ascending: true });

  if (error) return [];
  return data || [];
}

async function getDebts(tenantId) {
  const { data, error } = await db
    .from('debt_tracker')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('current_balance', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getCrewCosts(tenantId, year) {
  const [membersRes, logsRes] = await Promise.all([
    db.from('crew_members').select('id, name, daily_rate').eq('tenant_id', tenantId).eq('is_active', true),
    db.from('crew_daily_log')
      .select('crew_member_id, date, worked')
      .eq('tenant_id', tenantId)
      .eq('worked', true)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
  ]);

  const members = membersRes.data || [];
  const logs = logsRes.data || [];

  let totalCrewCost = 0;
  const monthlyCrew = {};

  for (const log of logs) {
    const member = members.find(m => m.id === log.crew_member_id);
    if (!member) continue;
    const cost = parseFloat(member.daily_rate) || 0;
    totalCrewCost += cost;

    const month = new Date(log.date).getMonth() + 1;
    monthlyCrew[month] = (monthlyCrew[month] || 0) + cost;
  }

  return { totalCrewCost, monthlyCrew, memberCount: members.length };
}

// ============================================================================
// KPI COMPUTATION
// ============================================================================

function computeKPIs(entries, debts, crewData, year) {
  const now = new Date();
  const currentMonth = now.getFullYear() === year ? now.getMonth() + 1 : 12;

  // Monthly breakdown
  const monthly = {};
  for (let m = 1; m <= 12; m++) {
    monthly[m] = { income: 0, expenses: 0, net: 0 };
  }

  let totalIncome = 0;
  let totalExpenses = 0;
  const expensesByCategory = {};
  const incomeByCustomer = {};

  for (const entry of entries) {
    const amt = parseFloat(entry.amount) || 0;
    const month = new Date(entry.date).getMonth() + 1;

    if (entry.entry_type === 'income') {
      monthly[month].income += amt;
      totalIncome += amt;
      const cust = entry.customer_name || 'Other';
      incomeByCustomer[cust] = (incomeByCustomer[cust] || 0) + amt;
    } else {
      monthly[month].expenses += amt;
      totalExpenses += amt;
      const cat = entry.category || 'Other';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + amt;
    }
  }

  for (let m = 1; m <= 12; m++) {
    monthly[m].net = monthly[m].income - monthly[m].expenses;
  }

  // Averages (only completed months)
  const avgMonthlyIncome = currentMonth > 1 ? totalIncome / (currentMonth - 1) : totalIncome;
  const avgMonthlyExpenses = currentMonth > 1 ? totalExpenses / (currentMonth - 1) : totalExpenses;

  // Revenue trend (compare last 2 completed months)
  const lastMonth = currentMonth > 1 ? currentMonth - 1 : 1;
  const prevMonth = lastMonth > 1 ? lastMonth - 1 : 1;
  const revenueTrend = monthly[prevMonth].income > 0
    ? Math.round(((monthly[lastMonth].income - monthly[prevMonth].income) / monthly[prevMonth].income) * 100)
    : 0;

  // Debt summary
  const totalDebt = debts.reduce((s, d) => s + (parseFloat(d.current_balance) || 0), 0);
  const totalOriginalDebt = debts.reduce((s, d) => s + (parseFloat(d.original_amount) || 0), 0);
  const debtProgress = totalOriginalDebt > 0
    ? Math.round(((totalOriginalDebt - totalDebt) / totalOriginalDebt) * 100)
    : 100;

  // Top expense categories
  const topExpenses = Object.entries(expensesByCategory)
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // Top customers
  const topCustomers = Object.entries(incomeByCustomer)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  // Burn rate (average monthly expenses + crew costs)
  const avgCrewCost = crewData.totalCrewCost / Math.max(currentMonth - 1, 1);
  const burnRate = avgMonthlyExpenses + avgCrewCost;

  // Runway (if we have cash/income info)
  const netProfit = totalIncome - totalExpenses - crewData.totalCrewCost;

  return {
    year,
    as_of_month: currentMonth,
    revenue: {
      total: totalIncome,
      monthly_avg: Math.round(avgMonthlyIncome * 100) / 100,
      trend_pct: revenueTrend,
      top_customers: topCustomers
    },
    expenses: {
      total: totalExpenses,
      monthly_avg: Math.round(avgMonthlyExpenses * 100) / 100,
      by_category: expensesByCategory,
      top_categories: topExpenses
    },
    crew: {
      total_cost: crewData.totalCrewCost,
      member_count: crewData.memberCount,
      monthly_avg: Math.round(avgCrewCost * 100) / 100
    },
    profit: {
      gross: totalIncome - totalExpenses,
      net: netProfit,
      margin_pct: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0
    },
    debt: {
      total_outstanding: totalDebt,
      original_total: totalOriginalDebt,
      payoff_progress_pct: debtProgress,
      count: debts.length
    },
    burn_rate: Math.round(burnRate * 100) / 100,
    monthly_breakdown: monthly
  };
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { year?: number }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('financial-dashboard', tenant.slug);
  const year = payload.year || new Date().getFullYear();

  log.info(`Generating financial dashboard for ${year}`);

  const [entries, debts, crewData] = await Promise.all([
    getYearEntries(tenant.id, year),
    getDebts(tenant.id),
    getCrewCosts(tenant.id, year)
  ]);

  const kpis = computeKPIs(entries, debts, crewData, year);

  log.success('Financial dashboard generated', {
    revenue: kpis.revenue.total,
    expenses: kpis.expenses.total,
    net: kpis.profit.net
  });

  return {
    success: true,
    dashboard: kpis
  };
}

module.exports = run;
