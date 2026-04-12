/**
 * Growth OS — Financial Dashboard API
 * Platform-level financial overview: MRR, expenses, cashflow, per-client breakdown
 *
 * These routes are for the FGA operator (Patrick), not per-tenant.
 * Auth: platform admin only.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../../db/client');
const { getRevenueSummary } = require('../../integrations/stripe');
const { createLogger } = require('../../core/logger');
const log = createLogger('finance-dashboard');

// ---------------------------------------------------------------------------
// GET /finance/summary
// MRR, customer count by tier, total revenue, expenses, net margin
// ---------------------------------------------------------------------------
router.get('/finance/summary', async (req, res) => {
  try {
    // Revenue from Stripe
    const revenue = await getRevenueSummary();

    // Expenses from finance_entries (platform-level or aggregated)
    const { data: expenseData, error: expenseErr } = await db
      .from('finance_entries')
      .select('amount')
      .eq('entry_type', 'expense');

    if (expenseErr) throw expenseErr;

    const totalExpenses = (expenseData || []).reduce(
      (sum, e) => sum + parseFloat(e.amount || 0), 0
    );

    const netMargin = revenue.mrr - totalExpenses;
    const marginPercent = revenue.mrr > 0
      ? ((netMargin / revenue.mrr) * 100).toFixed(1)
      : 0;

    res.json({
      success: true,
      data: {
        mrr: revenue.mrr,
        mrrFormatted: revenue.mrrFormatted,
        totalCustomers: revenue.totalCustomers,
        activeSubscriptions: revenue.activeSubscriptions,
        tiers: revenue.tiers,
        totalExpenses,
        netMargin,
        marginPercent: `${marginPercent}%`,
      },
    });
  } catch (err) {
    log.error(`Summary fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /finance/mrr-history
// Monthly MRR over time
// ---------------------------------------------------------------------------
router.get('/finance/mrr-history', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;

    // Pull monthly income from finance_entries as MRR proxy
    const { data, error } = await db
      .from('finance_entries')
      .select('date, amount')
      .eq('entry_type', 'income')
      .eq('category', 'subscription')
      .order('date', { ascending: true });

    if (error) throw error;

    // Group by month
    const monthlyMap = {};
    for (const entry of (data || [])) {
      const month = entry.date.substring(0, 7); // YYYY-MM
      monthlyMap[month] = (monthlyMap[month] || 0) + parseFloat(entry.amount || 0);
    }

    // Build sorted array of last N months
    const sortedMonths = Object.keys(monthlyMap).sort().slice(-months);
    const history = sortedMonths.map(month => ({
      month,
      mrr: monthlyMap[month],
    }));

    res.json({ success: true, data: history });
  } catch (err) {
    log.error(`MRR history fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /finance/expenses
// Expenses grouped by category
// ---------------------------------------------------------------------------
router.get('/finance/expenses', async (req, res) => {
  try {
    const { month, year } = req.query;

    let query = db
      .from('finance_entries')
      .select('*')
      .eq('entry_type', 'expense')
      .order('date', { ascending: false });

    if (month && year) {
      const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
      const end = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Group by category
    const byCategory = {};
    for (const entry of (data || [])) {
      const cat = entry.category || 'uncategorized';
      if (!byCategory[cat]) byCategory[cat] = { total: 0, entries: [] };
      byCategory[cat].total += parseFloat(entry.amount || 0);
      byCategory[cat].entries.push(entry);
    }

    res.json({ success: true, data: byCategory });
  } catch (err) {
    log.error(`Expenses fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /finance/clients
// Per-client revenue and cost breakdown
// ---------------------------------------------------------------------------
router.get('/finance/clients', async (req, res) => {
  try {
    // Get all tenants
    const { data: tenants, error: tenantErr } = await db
      .from('tenants')
      .select('id, name, slug, status')
      .eq('status', 'active');

    if (tenantErr) throw tenantErr;

    // Get income entries grouped by tenant
    const { data: income, error: incomeErr } = await db
      .from('finance_entries')
      .select('tenant_id, amount, category, date')
      .eq('entry_type', 'income');

    if (incomeErr) throw incomeErr;

    // Get expense entries by tenant (operational costs)
    const { data: expenses, error: expErr } = await db
      .from('finance_entries')
      .select('tenant_id, amount, category, date')
      .eq('entry_type', 'expense');

    if (expErr) throw expErr;

    // Build per-client breakdown
    const clients = (tenants || []).map(tenant => {
      const clientIncome = (income || [])
        .filter(e => e.tenant_id === tenant.id)
        .reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);

      const clientExpenses = (expenses || [])
        .filter(e => e.tenant_id === tenant.id)
        .reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);

      return {
        tenantId: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        totalRevenue: clientIncome,
        totalCost: clientExpenses,
        netMargin: clientIncome - clientExpenses,
      };
    });

    res.json({ success: true, data: clients });
  } catch (err) {
    log.error(`Client breakdown fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /finance/cashflow
// Income vs expenses by month
// ---------------------------------------------------------------------------
router.get('/finance/cashflow', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;

    const { data, error } = await db
      .from('finance_entries')
      .select('date, amount, entry_type')
      .in('entry_type', ['income', 'expense'])
      .order('date', { ascending: true });

    if (error) throw error;

    // Group by month and type
    const monthlyMap = {};
    for (const entry of (data || [])) {
      const month = entry.date.substring(0, 7);
      if (!monthlyMap[month]) monthlyMap[month] = { income: 0, expenses: 0 };
      const amount = parseFloat(entry.amount || 0);
      if (entry.entry_type === 'income') {
        monthlyMap[month].income += amount;
      } else {
        monthlyMap[month].expenses += amount;
      }
    }

    const sortedMonths = Object.keys(monthlyMap).sort().slice(-months);
    const cashflow = sortedMonths.map(month => ({
      month,
      income: monthlyMap[month].income,
      expenses: monthlyMap[month].expenses,
      net: monthlyMap[month].income - monthlyMap[month].expenses,
    }));

    res.json({ success: true, data: cashflow });
  } catch (err) {
    log.error(`Cashflow fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
