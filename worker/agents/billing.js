/**
 * Growth OS — Billing Agent
 * Tracks invoicing, payment due dates, overdue alerts, and subscription billing.
 *
 * Multi-tenant: scoped by tenant_id.
 * Uses finance_entries (income), tenants table, and tenant_config.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function getIncomeEntries(tenantId, monthsBack = 3) {
  const since = new Date();
  since.setMonth(since.getMonth() - monthsBack);

  const { data, error } = await db
    .from('finance_entries')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'income')
    .gte('date', since.toISOString().split('T')[0])
    .order('date', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getRecurringExpenses(tenantId) {
  const { data, error } = await db
    .from('finance_entries')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .eq('recurring', true)
    .order('date', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getDebtPayments(tenantId) {
  const { data, error } = await db
    .from('debt_tracker')
    .select('*')
    .eq('tenant_id', tenantId)
    .gt('current_balance', 0)
    .order('current_balance', { ascending: false });

  if (error) return [];
  return data || [];
}

// ============================================================================
// BILLING ANALYSIS
// ============================================================================

function analyzeBilling(income, recurringExpenses, debts) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // Current month income
  const currentMonthIncome = income
    .filter(e => {
      const d = new Date(e.date);
      return d.getMonth() + 1 === currentMonth && d.getFullYear() === currentYear;
    })
    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

  // Previous month income
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
  const prevMonthIncome = income
    .filter(e => {
      const d = new Date(e.date);
      return d.getMonth() + 1 === prevMonth && d.getFullYear() === prevYear;
    })
    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

  // Monthly recurring expense total
  const monthlyRecurring = recurringExpenses
    .reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

  // Monthly debt obligations
  const monthlyDebtPayments = debts
    .reduce((sum, d) => sum + (parseFloat(d.monthly_payment) || 0), 0);

  // Total monthly obligations
  const totalObligations = monthlyRecurring + monthlyDebtPayments;

  // Alerts
  const alerts = [];

  if (currentMonthIncome < totalObligations) {
    alerts.push({
      severity: 'high',
      type: 'income_shortfall',
      message: `Current month income ($${currentMonthIncome.toFixed(2)}) is below monthly obligations ($${totalObligations.toFixed(2)})`
    });
  }

  if (prevMonthIncome > 0 && currentMonthIncome < prevMonthIncome * 0.8) {
    alerts.push({
      severity: 'medium',
      type: 'revenue_decline',
      message: `Revenue down ${Math.round((1 - currentMonthIncome / prevMonthIncome) * 100)}% vs last month`
    });
  }

  for (const debt of debts) {
    if (parseFloat(debt.monthly_payment) === 0 && parseFloat(debt.current_balance) > 0) {
      alerts.push({
        severity: 'low',
        type: 'no_payment_plan',
        message: `"${debt.name}" has no monthly payment set (balance: $${parseFloat(debt.current_balance).toFixed(2)})`
      });
    }
  }

  return {
    current_month_income: currentMonthIncome,
    previous_month_income: prevMonthIncome,
    monthly_recurring_expenses: monthlyRecurring,
    monthly_debt_payments: monthlyDebtPayments,
    total_obligations: totalObligations,
    net_after_obligations: currentMonthIncome - totalObligations,
    income_trend: prevMonthIncome > 0
      ? Math.round(((currentMonthIncome - prevMonthIncome) / prevMonthIncome) * 100)
      : null,
    outstanding_debts: debts.length,
    total_debt_balance: debts.reduce((sum, d) => sum + (parseFloat(d.current_balance) || 0), 0),
    alerts
  };
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { months_back?: number }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('billing', tenant.slug);
  const monthsBack = payload.months_back || 3;

  log.info('Running billing analysis');

  const [income, recurringExpenses, debts] = await Promise.all([
    getIncomeEntries(tenant.id, monthsBack),
    getRecurringExpenses(tenant.id),
    getDebtPayments(tenant.id)
  ]);

  const analysis = analyzeBilling(income, recurringExpenses, debts);

  log.success('Billing analysis complete', {
    alerts: analysis.alerts.length,
    net: analysis.net_after_obligations
  });

  return {
    success: true,
    ...analysis,
    income_entries: income.length,
    recurring_expenses: recurringExpenses.length
  };
}

module.exports = run;
