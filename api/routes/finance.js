/**
 * Growth OS — Finance Routes
 * Full financial tracking: income, expenses, debt, crew, summaries, P&L
 * Multi-tenant via req.tenantId
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const { db } = require('../../db/client');

router.use(requireModule('finance'));

// ============================================================================
// INCOME
// ============================================================================

/** GET /api/finance/income?month=4&year=2026 */
router.get('/income', async (req, res) => {
  try {
    const { month, year } = req.query;
    let query = db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income')
      .order('date', { ascending: false });

    if (month && year) {
      const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
      const end = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/income */
router.post('/income', async (req, res) => {
  try {
    const { data, error } = await db
      .from('finance_entries')
      .insert({
        tenant_id: req.tenantId,
        entry_type: 'income',
        customer_name: req.body.customer_name,
        amount: req.body.amount,
        date: req.body.date,
        job_type: req.body.job_type || null,
        description: req.body.notes || req.body.description || null,
        lead_id: req.body.lead_id || null,
        metadata: req.body.metadata || {}
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/income/:id */
router.patch('/income/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('finance_entries')
      .update(req.body)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'income')
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/income/:id */
router.delete('/income/:id', async (req, res) => {
  try {
    const { error } = await db
      .from('finance_entries')
      .delete()
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'income');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// EXPENSES
// ============================================================================

/** GET /api/finance/expenses?month=4&year=2026 */
router.get('/expenses', async (req, res) => {
  try {
    const { month, year } = req.query;
    let query = db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'expense')
      .order('date', { ascending: false });

    if (month && year) {
      const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
      const end = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/expenses */
router.post('/expenses', async (req, res) => {
  try {
    const { data, error } = await db
      .from('finance_entries')
      .insert({
        tenant_id: req.tenantId,
        entry_type: 'expense',
        category: req.body.category,
        amount: req.body.amount,
        date: req.body.date,
        description: req.body.description,
        recurring: req.body.recurring || req.body.is_recurring || false,
        metadata: req.body.metadata || {}
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/expenses/:id */
router.patch('/expenses/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('finance_entries')
      .update(req.body)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'expense')
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/expenses/:id */
router.delete('/expenses/:id', async (req, res) => {
  try {
    const { error } = await db
      .from('finance_entries')
      .delete()
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .eq('entry_type', 'expense');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/expenses/rollover — copy recurring expenses from previous month */
router.post('/expenses/rollover', async (req, res) => {
  try {
    const { month, year } = req.body;
    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth === 0) { prevMonth = 12; prevYear = year - 1; }

    const prevStart = new Date(prevYear, prevMonth - 1, 1).toISOString().split('T')[0];
    const prevEnd = new Date(prevYear, prevMonth, 0).toISOString().split('T')[0];

    const { data: recurring, error: fetchErr } = await db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'expense')
      .eq('recurring', true)
      .gte('date', prevStart)
      .lte('date', prevEnd);

    if (fetchErr) throw fetchErr;
    if (!recurring || recurring.length === 0) {
      return res.json({ success: true, data: { created: 0, entries: [] } });
    }

    const targetDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    // Only roll over monthly recurring (skip yearly — those are billed annually)
    const monthlyRecurring = recurring.filter(exp => {
      const freq = exp.metadata?.recurring_frequency;
      return !freq || freq === 'monthly'; // default to monthly for backward compat
    });

    if (monthlyRecurring.length === 0) {
      return res.json({ success: true, data: { created: 0, entries: [] } });
    }

    const newEntries = monthlyRecurring.map(exp => ({
      tenant_id: req.tenantId,
      entry_type: 'expense',
      description: exp.description,
      category: exp.category,
      amount: exp.amount,
      date: targetDate,
      recurring: true,
      metadata: exp.metadata || { recurring_frequency: 'monthly' }
    }));

    const { data: created, error: insertErr } = await db
      .from('finance_entries')
      .insert(newEntries)
      .select();

    if (insertErr) throw insertErr;
    res.json({ success: true, data: { created: created?.length || 0, entries: created || [] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// CUSTOMERS (derived from income entries)
// ============================================================================

/** GET /api/finance/customers */
router.get('/customers', async (req, res) => {
  try {
    const { data, error } = await db
      .from('finance_entries')
      .select('customer_name, amount, date, job_type')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income')
      .not('customer_name', 'is', null);

    if (error) throw error;

    const customerMap = {};
    for (const entry of (data || [])) {
      const name = entry.customer_name;
      if (!name) continue;
      if (!customerMap[name]) {
        customerMap[name] = { customer_name: name, total_revenue: 0, job_count: 0, first_job: entry.date, last_job: entry.date, job_types: new Set() };
      }
      customerMap[name].total_revenue += parseFloat(entry.amount) || 0;
      customerMap[name].job_count += 1;
      if (entry.date < customerMap[name].first_job) customerMap[name].first_job = entry.date;
      if (entry.date > customerMap[name].last_job) customerMap[name].last_job = entry.date;
      if (entry.job_type) customerMap[name].job_types.add(entry.job_type);
    }

    const customers = Object.values(customerMap).map(c => ({
      ...c,
      job_types: Array.from(c.job_types),
      is_repeat: c.job_count > 1
    })).sort((a, b) => b.total_revenue - a.total_revenue);

    res.json({ success: true, data: customers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/customers/search?q=... */
router.get('/customers/search', async (req, res) => {
  try {
    const pattern = `%${req.query.q || ''}%`;
    const { data, error } = await db
      .from('finance_entries')
      .select('customer_name, amount, date')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income')
      .ilike('customer_name', pattern);

    if (error) throw error;

    const customerMap = {};
    for (const entry of (data || [])) {
      const name = entry.customer_name;
      if (!customerMap[name]) customerMap[name] = { customer_name: name, total_revenue: 0, job_count: 0 };
      customerMap[name].total_revenue += parseFloat(entry.amount) || 0;
      customerMap[name].job_count += 1;
    }

    res.json({ success: true, data: Object.values(customerMap).sort((a, b) => b.total_revenue - a.total_revenue) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/customers/insights?year=2026 */
router.get('/customers/insights', async (req, res) => {
  try {
    let query = db
      .from('finance_entries')
      .select('customer_name, amount, date')
      .eq('tenant_id', req.tenantId)
      .eq('entry_type', 'income');

    if (req.query.year) {
      query = query.gte('date', `${req.query.year}-01-01`).lte('date', `${req.query.year}-12-31`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const isCash = (name) => {
      if (!name) return false;
      const lower = name.toLowerCase().trim();
      return lower === 'cash' || lower.startsWith('cash ') || lower.startsWith('cash(') || lower.includes('(cash)');
    };

    let cashRevenue = 0, cashJobCount = 0;
    const customerMap = {};

    for (const entry of (data || [])) {
      if (isCash(entry.customer_name)) {
        cashRevenue += parseFloat(entry.amount) || 0;
        cashJobCount++;
        continue;
      }
      const name = entry.customer_name;
      if (!name) continue;
      if (!customerMap[name]) customerMap[name] = { job_count: 0, total_revenue: 0 };
      customerMap[name].job_count += 1;
      customerMap[name].total_revenue += parseFloat(entry.amount) || 0;
    }

    const customers = Object.entries(customerMap);
    const totalCustomers = customers.length;
    const repeatCustomers = customers.filter(([, c]) => c.job_count > 1);
    const repeatRate = totalCustomers > 0 ? Math.round((repeatCustomers.length / totalCustomers) * 100) : 0;

    const topCustomers = customers
      .map(([name, stats]) => ({ customer_name: name, ...stats }))
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, 10);

    res.json({
      success: true,
      data: {
        total_customers: totalCustomers,
        repeat_customers: repeatCustomers.length,
        repeat_rate: repeatRate,
        cash_revenue: cashRevenue,
        cash_job_count: cashJobCount,
        top_customers: topCustomers
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// SUMMARY / DASHBOARD
// ============================================================================

/** GET /api/finance/summary?year=2026 */
router.get('/summary', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const { data, error } = await db
      .from('finance_entries')
      .select('entry_type, amount, date, category')
      .eq('tenant_id', req.tenantId)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`);

    if (error) throw error;

    const monthlyBreakdown = {};
    for (let m = 1; m <= 12; m++) monthlyBreakdown[m] = { income: 0, expenses: 0, net: 0 };

    let totalIncome = 0, totalExpenses = 0;
    const expensesByCategory = {};

    for (const entry of (data || [])) {
      const amt = parseFloat(entry.amount) || 0;
      const month = new Date(entry.date).getMonth() + 1;

      if (entry.entry_type === 'income') {
        monthlyBreakdown[month].income += amt;
        totalIncome += amt;
      } else {
        monthlyBreakdown[month].expenses += amt;
        totalExpenses += amt;
        const cat = entry.category || 'Other';
        expensesByCategory[cat] = (expensesByCategory[cat] || 0) + amt;
      }
    }

    for (let m = 1; m <= 12; m++) {
      monthlyBreakdown[m].net = monthlyBreakdown[m].income - monthlyBreakdown[m].expenses;
    }

    res.json({
      success: true,
      data: {
        year,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_profit: totalIncome - totalExpenses,
        profit_margin: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0,
        monthly_breakdown: monthlyBreakdown,
        expenses_by_category: expensesByCategory
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/report/year-end?year=2026 — full P&L report */
router.get('/report/year-end', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const { data, error } = await db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
      .order('date', { ascending: true });

    if (error) throw error;

    const entries = data || [];
    const income = entries.filter(e => e.entry_type === 'income');
    const expenses = entries.filter(e => e.entry_type === 'expense');

    const totalIncome = income.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

    const expensesByCategory = {};
    for (const exp of expenses) {
      const cat = exp.category || 'Other';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + (parseFloat(exp.amount) || 0);
    }

    const monthlyBreakdown = {};
    for (let m = 1; m <= 12; m++) monthlyBreakdown[m] = { income: 0, expenses: 0, net: 0 };
    for (const e of entries) {
      const m = new Date(e.date).getMonth() + 1;
      const amt = parseFloat(e.amount) || 0;
      if (e.entry_type === 'income') monthlyBreakdown[m].income += amt;
      else monthlyBreakdown[m].expenses += amt;
    }
    for (let m = 1; m <= 12; m++) monthlyBreakdown[m].net = monthlyBreakdown[m].income - monthlyBreakdown[m].expenses;

    res.json({
      success: true,
      data: {
        year,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_profit: totalIncome - totalExpenses,
        profit_margin: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0,
        expenses_by_category: expensesByCategory,
        monthly_breakdown: monthlyBreakdown,
        income_entries: income,
        expense_entries: expenses
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// DEBT
// ============================================================================

/** GET /api/finance/debt */
router.get('/debt', async (req, res) => {
  try {
    const { data, error } = await db
      .from('debt_tracker')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('current_balance', { ascending: false });
    if (error) throw error;

    const debts = (data || []).map(d => ({
      ...d,
      paid_off: d.original_amount - d.current_balance,
      progress_pct: d.original_amount > 0
        ? Math.round(((d.original_amount - d.current_balance) / d.original_amount) * 100)
        : 0
    }));

    res.json({ success: true, data: debts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/debt */
router.post('/debt', async (req, res) => {
  try {
    const { data, error } = await db
      .from('debt_tracker')
      .insert({
        tenant_id: req.tenantId,
        name: req.body.name,
        original_amount: req.body.original_amount,
        current_balance: req.body.current_balance,
        monthly_payment: req.body.monthly_payment || 0
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/debt/:id */
router.patch('/debt/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('debt_tracker')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/debt/:id */
router.delete('/debt/:id', async (req, res) => {
  try {
    const { error } = await db
      .from('debt_tracker')
      .delete()
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// CREW
// ============================================================================

/** GET /api/finance/crew */
router.get('/crew', async (req, res) => {
  try {
    const { data, error } = await db
      .from('crew_members')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/crew */
router.post('/crew', async (req, res) => {
  try {
    const { data, error } = await db
      .from('crew_members')
      .insert({
        tenant_id: req.tenantId,
        name: req.body.name,
        daily_rate: req.body.daily_rate,
        is_active: true
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** PATCH /api/finance/crew/:id */
router.patch('/crew/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('crew_members')
      .update(req.body)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** DELETE /api/finance/crew/:id */
router.delete('/crew/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('crew_members')
      .update({ is_active: false })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/crew/log?month=4&year=2026 */
router.get('/crew/log', async (req, res) => {
  try {
    const { month, year } = req.query;
    const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const end = new Date(year, month, 0).toISOString().split('T')[0];

    const { data, error } = await db
      .from('crew_daily_log')
      .select('*, crew_members(name, daily_rate)')
      .eq('tenant_id', req.tenantId)
      .gte('date', start)
      .lte('date', end)
      .order('date', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/finance/crew/log — toggle a crew work day */
router.post('/crew/log', async (req, res) => {
  try {
    const { crew_member_id, date, worked } = req.body;

    // Upsert: check if exists
    const { data: existing } = await db
      .from('crew_daily_log')
      .select('id')
      .eq('crew_member_id', crew_member_id)
      .eq('date', date)
      .maybeSingle();

    let result;
    if (existing) {
      const { data, error } = await db
        .from('crew_daily_log')
        .update({ worked })
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await db
        .from('crew_daily_log')
        .insert({ tenant_id: req.tenantId, crew_member_id, date, worked })
        .select()
        .single();
      if (error) throw error;
      result = data;
    }

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** GET /api/finance/crew/yearly-summary?year=2026 */
router.get('/crew/yearly-summary', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const [membersRes, logsRes] = await Promise.all([
      db.from('crew_members').select('id, name, daily_rate').eq('tenant_id', req.tenantId),
      db.from('crew_daily_log')
        .select('crew_member_id, date, worked')
        .eq('tenant_id', req.tenantId)
        .gte('date', `${year}-01-01`)
        .lte('date', `${year}-12-31`)
    ]);

    if (membersRes.error) throw membersRes.error;
    if (logsRes.error) throw logsRes.error;

    const members = membersRes.data || [];
    const logs = (logsRes.data || []).filter(l => l.worked);

    // Yearly totals
    const yearlyCrew = members.map(m => {
      const daysWorked = logs.filter(l => l.crew_member_id === m.id).length;
      return { id: m.id, name: m.name, daily_rate: m.daily_rate, days_worked: daysWorked, total_pay: daysWorked * m.daily_rate };
    }).filter(c => c.days_worked > 0);

    // Monthly breakdown
    const monthly_breakdown = {};
    for (let mo = 1; mo <= 12; mo++) {
      const monthStr = String(mo).padStart(2, '0');
      const monthLogs = logs.filter(l => l.date?.substring(5, 7) === monthStr);
      const crew = members.map(m => {
        const daysWorked = monthLogs.filter(l => l.crew_member_id === m.id).length;
        return { id: m.id, name: m.name, daily_rate: m.daily_rate, days_worked: daysWorked, total_pay: daysWorked * m.daily_rate };
      }).filter(c => c.days_worked > 0);
      monthly_breakdown[String(mo)] = { crew, grand_total: crew.reduce((s, c) => s + c.total_pay, 0) };
    }

    res.json({
      success: true,
      data: {
        year,
        crew: yearlyCrew,
        grand_total: yearlyCrew.reduce((s, c) => s + c.total_pay, 0),
        monthly_breakdown
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// LEGACY ENDPOINTS (backward compat)
// ============================================================================

/** GET /api/finance — list all entries (original) */
router.get('/', async (req, res) => {
  try {
    let query = db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('date', { ascending: false });

    if (req.query.type) query = query.eq('entry_type', req.query.type);
    if (req.query.category) query = query.eq('category', req.query.category);
    if (req.query.from) query = query.gte('date', req.query.from);
    if (req.query.to) query = query.lte('date', req.query.to);
    query = query.limit(parseInt(req.query.limit) || 200);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, entries: data, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
