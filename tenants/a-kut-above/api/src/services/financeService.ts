import { supabase } from '../config/supabase';

export const financeService = {
  // ─── INCOME ───────────────────────────────────────────────────────────

  async getIncome(month: number, year: number) {
    const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('income_entries')
      .select('*')
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  async createIncome(entry: {
    customer_name: string;
    amount: number;
    date: string;
    job_type?: string;
    notes?: string;
  }) {
    const { data, error } = await supabase
      .from('income_entries')
      .insert(entry)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateIncome(id: string, updates: Record<string, any>) {
    const { data, error } = await supabase
      .from('income_entries')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async deleteIncome(id: string) {
    const { error } = await supabase
      .from('income_entries')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  // ─── EXPENSES ─────────────────────────────────────────────────────────

  async getExpenses(month: number, year: number) {
    const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('expense_entries')
      .select('*')
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  async createExpense(entry: {
    description: string;
    category: string;
    amount: number;
    date: string;
    is_recurring: boolean;
  }) {
    const { data, error } = await supabase
      .from('expense_entries')
      .insert(entry)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateExpense(id: string, updates: Record<string, any>) {
    const { data, error } = await supabase
      .from('expense_entries')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async deleteExpense(id: string) {
    const { error } = await supabase
      .from('expense_entries')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  async rolloverRecurringExpenses(targetMonth: number, targetYear: number) {
    // Determine previous month
    let prevMonth = targetMonth - 1;
    let prevYear = targetYear;
    if (prevMonth === 0) {
      prevMonth = 12;
      prevYear = targetYear - 1;
    }

    const prevStartDate = new Date(prevYear, prevMonth - 1, 1).toISOString().split('T')[0];
    const prevEndDate = new Date(prevYear, prevMonth, 0).toISOString().split('T')[0];

    // Get recurring expenses from previous month
    const { data: recurring, error: fetchError } = await supabase
      .from('expense_entries')
      .select('*')
      .eq('is_recurring', true)
      .gte('date', prevStartDate)
      .lte('date', prevEndDate);

    if (fetchError) throw fetchError;

    if (!recurring || recurring.length === 0) {
      return { created: 0, entries: [] };
    }

    // Create new entries for target month, setting date to the 1st
    const targetDate = new Date(targetYear, targetMonth - 1, 1).toISOString().split('T')[0];
    const newEntries = recurring.map((exp) => ({
      description: exp.description,
      category: exp.category,
      amount: exp.amount,
      date: targetDate,
      is_recurring: true,
    }));

    const { data: created, error: insertError } = await supabase
      .from('expense_entries')
      .insert(newEntries)
      .select();

    if (insertError) throw insertError;

    return { created: created?.length || 0, entries: created || [] };
  },

  // ─── CUSTOMERS (derived from income_entries) ─────────────────────────

  async getCustomers() {
    const { data, error } = await supabase
      .from('income_entries')
      .select('customer_name, amount, date, job_type');

    if (error) throw error;

    const customerMap: Record<string, {
      customer_name: string;
      total_revenue: number;
      job_count: number;
      first_job: string;
      last_job: string;
      job_types: Set<string>;
    }> = {};

    for (const entry of data || []) {
      const name = entry.customer_name;
      if (!customerMap[name]) {
        customerMap[name] = {
          customer_name: name,
          total_revenue: 0,
          job_count: 0,
          first_job: entry.date,
          last_job: entry.date,
          job_types: new Set(),
        };
      }
      customerMap[name].total_revenue += entry.amount;
      customerMap[name].job_count += 1;
      if (entry.date < customerMap[name].first_job) customerMap[name].first_job = entry.date;
      if (entry.date > customerMap[name].last_job) customerMap[name].last_job = entry.date;
      if (entry.job_type) customerMap[name].job_types.add(entry.job_type);
    }

    return Object.values(customerMap).map((c) => ({
      customer_name: c.customer_name,
      total_revenue: c.total_revenue,
      job_count: c.job_count,
      first_job: c.first_job,
      last_job: c.last_job,
      job_types: Array.from(c.job_types),
      is_repeat: c.job_count > 1,
    })).sort((a, b) => b.total_revenue - a.total_revenue);
  },

  async searchCustomers(query: string) {
    // Try trigram similarity first via RPC, fall back to ILIKE
    const pattern = `%${query}%`;

    const { data, error } = await supabase
      .from('income_entries')
      .select('customer_name, amount, date')
      .ilike('customer_name', pattern);

    if (error) throw error;

    // Aggregate matches
    const customerMap: Record<string, { customer_name: string; total_revenue: number; job_count: number }> = {};
    for (const entry of data || []) {
      const name = entry.customer_name;
      if (!customerMap[name]) {
        customerMap[name] = { customer_name: name, total_revenue: 0, job_count: 0 };
      }
      customerMap[name].total_revenue += entry.amount;
      customerMap[name].job_count += 1;
    }

    return Object.values(customerMap).sort((a, b) => b.total_revenue - a.total_revenue);
  },

  async getCustomerInsights(year?: number) {
    let query = supabase
      .from('income_entries')
      .select('customer_name, amount, date');

    if (year) {
      query = query.gte('date', `${year}-01-01`).lte('date', `${year}-12-31`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const entries = data || [];

    // Helper to detect "Cash" entries — these are anonymous cash transactions, not trackable customers
    const isCashEntry = (name: string): boolean => {
      if (!name) return false;
      const lower = name.toLowerCase().trim();
      return lower === 'cash' || lower.startsWith('cash ') || lower.startsWith('cash(') || lower.includes('(cash)');
    };

    // Separate cash entries from real customers
    let cashRevenue = 0;
    let cashJobCount = 0;
    const customerMap: Record<string, { job_count: number; total_revenue: number }> = {};

    for (const entry of entries) {
      const name = entry.customer_name;
      if (isCashEntry(name)) {
        cashRevenue += entry.amount;
        cashJobCount += 1;
        continue;
      }
      if (!customerMap[name]) {
        customerMap[name] = { job_count: 0, total_revenue: 0 };
      }
      customerMap[name].job_count += 1;
      customerMap[name].total_revenue += entry.amount;
    }

    const customers = Object.entries(customerMap);
    const totalCustomers = customers.length;
    const repeatCustomers = customers.filter(([, c]) => c.job_count > 1);
    const repeatRate = totalCustomers > 0 ? Math.round((repeatCustomers.length / totalCustomers) * 100) : 0;

    const repeatRevenue = repeatCustomers.reduce((sum, [, c]) => sum + c.total_revenue, 0);
    const newRevenue = customers
      .filter(([, c]) => c.job_count === 1)
      .reduce((sum, [, c]) => sum + c.total_revenue, 0);

    const topCustomers = customers
      .map(([name, stats]) => ({ customer_name: name, ...stats }))
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .slice(0, 10);

    return {
      total_customers: totalCustomers,
      repeat_customers: repeatCustomers.length,
      repeat_rate: repeatRate,
      repeat_revenue: repeatRevenue,
      new_customer_revenue: newRevenue,
      cash_revenue: cashRevenue,
      cash_job_count: cashJobCount,
      top_customers: topCustomers,
    };
  },

  // ─── DEBT ─────────────────────────────────────────────────────────────

  async getDebts() {
    const { data, error } = await supabase
      .from('debt_tracker')
      .select('*')
      .order('current_balance', { ascending: false });

    if (error) throw error;

    return (data || []).map((d) => ({
      ...d,
      paid_off: d.original_amount - d.current_balance,
      progress_pct: d.original_amount > 0
        ? Math.round(((d.original_amount - d.current_balance) / d.original_amount) * 100)
        : 0,
    }));
  },

  async createDebt(entry: {
    name: string;
    original_amount: number;
    current_balance: number;
    monthly_payment: number;
  }) {
    const { data, error } = await supabase
      .from('debt_tracker')
      .insert(entry)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateDebt(id: string, updates: Record<string, any>) {
    const { data, error } = await supabase
      .from('debt_tracker')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async deleteDebt(id: string) {
    const { error } = await supabase
      .from('debt_tracker')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  // ─── CREW ─────────────────────────────────────────────────────────────

  async getCrewMembers() {
    const { data, error } = await supabase
      .from('crew_members')
      .select('*')
      .eq('is_active', true)
      .order('name');

    if (error) throw error;
    return data || [];
  },

  async createCrewMember(entry: { name: string; daily_rate: number }) {
    const { data, error } = await supabase
      .from('crew_members')
      .insert({ ...entry, is_active: true })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateCrewMember(id: string, updates: Record<string, any>) {
    const { data, error } = await supabase
      .from('crew_members')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getCrewLog(month: number, year: number) {
    const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('crew_daily_log')
      .select('*, crew_members(name, daily_rate)')
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  async logCrewWorkDay(entry: {
    crew_member_id: string;
    date: string;
    worked: boolean;
  }) {
    // Upsert based on crew_member_id + date
    const { data: existing } = await supabase
      .from('crew_daily_log')
      .select('id')
      .eq('crew_member_id', entry.crew_member_id)
      .eq('date', entry.date)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from('crew_daily_log')
        .update({ worked: entry.worked })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    }

    const { data, error } = await supabase
      .from('crew_daily_log')
      .insert(entry)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async getCrewPaySummary(month: number, year: number) {
    const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const { data: members, error: membersError } = await supabase
      .from('crew_members')
      .select('id, name, daily_rate')
      .eq('is_active', true);

    if (membersError) throw membersError;

    const { data: logs, error: logsError } = await supabase
      .from('crew_daily_log')
      .select('crew_member_id, worked')
      .gte('date', startDate)
      .lte('date', endDate);

    if (logsError) throw logsError;

    const summary = (members || []).map((member) => {
      const memberLogs = (logs || []).filter((l) => l.crew_member_id === member.id);
      const daysWorked = memberLogs.filter((l) => l.worked).length;
      const totalPay = daysWorked * member.daily_rate;

      return {
        id: member.id,
        name: member.name,
        daily_rate: member.daily_rate,
        days_worked: daysWorked,
        total_pay: totalPay,
      };
    });

    const grandTotal = summary.reduce((sum, s) => sum + s.total_pay, 0);

    return { crew: summary, grand_total: grandTotal };
  },

  async getCrewYearlySummary(year: number) {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const { data: members, error: membersError } = await supabase
      .from('crew_members')
      .select('id, name, daily_rate');

    if (membersError) throw membersError;

    const { data: logs, error: logsError } = await supabase
      .from('crew_daily_log')
      .select('crew_member_id, date, worked')
      .gte('date', startDate)
      .lte('date', endDate);

    if (logsError) throw logsError;

    // Build per-month breakdown
    const monthly_breakdown: Record<string, { crew: { id: string; name: string; daily_rate: number; days_worked: number; total_pay: number }[]; grand_total: number }> = {};

    for (let m = 1; m <= 12; m++) {
      const monthStr = String(m).padStart(2, '0');
      const monthLogs = (logs || []).filter((l) => {
        const logMonth = l.date?.substring(5, 7);
        return logMonth === monthStr && l.worked;
      });

      const crew = (members || []).map((member) => {
        const daysWorked = monthLogs.filter((l) => l.crew_member_id === member.id).length;
        return {
          id: member.id,
          name: member.name,
          daily_rate: member.daily_rate,
          days_worked: daysWorked,
          total_pay: daysWorked * member.daily_rate,
        };
      }).filter((c) => c.days_worked > 0);

      const grand_total = crew.reduce((s, c) => s + c.total_pay, 0);
      monthly_breakdown[String(m)] = { crew, grand_total };
    }

    // Yearly totals
    const allWorkedLogs = (logs || []).filter((l) => l.worked);
    const yearlyCrew = (members || []).map((member) => {
      const daysWorked = allWorkedLogs.filter((l) => l.crew_member_id === member.id).length;
      return {
        id: member.id,
        name: member.name,
        daily_rate: member.daily_rate,
        days_worked: daysWorked,
        total_pay: daysWorked * member.daily_rate,
      };
    }).filter((c) => c.days_worked > 0);

    const grand_total = yearlyCrew.reduce((s, c) => s + c.total_pay, 0);

    return {
      year,
      crew: yearlyCrew,
      grand_total,
      monthly_breakdown,
    };
  },

  // ─── SUMMARY / DASHBOARD ─────────────────────────────────────────────

  async getYearSummary(year: number) {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const [{ data: income }, { data: expenses }] = await Promise.all([
      supabase
        .from('income_entries')
        .select('amount, date')
        .gte('date', startDate)
        .lte('date', endDate),
      supabase
        .from('expense_entries')
        .select('amount, date, category')
        .gte('date', startDate)
        .lte('date', endDate),
    ]);

    const monthlyBreakdown: Record<number, { income: number; expenses: number; net: number }> = {};
    for (let m = 1; m <= 12; m++) {
      monthlyBreakdown[m] = { income: 0, expenses: 0, net: 0 };
    }

    let totalIncome = 0;
    let totalExpenses = 0;

    for (const entry of income || []) {
      const month = new Date(entry.date).getMonth() + 1;
      monthlyBreakdown[month].income += entry.amount;
      totalIncome += entry.amount;
    }

    for (const entry of expenses || []) {
      const month = new Date(entry.date).getMonth() + 1;
      monthlyBreakdown[month].expenses += entry.amount;
      totalExpenses += entry.amount;
    }

    for (let m = 1; m <= 12; m++) {
      monthlyBreakdown[m].net = monthlyBreakdown[m].income - monthlyBreakdown[m].expenses;
    }

    return {
      year,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      net_profit: totalIncome - totalExpenses,
      monthly_breakdown: monthlyBreakdown,
    };
  },

  async getMonthlySummary(month: number, year: number) {
    const startDate = new Date(year, month - 1, 1).toISOString().split('T')[0];
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const [{ data: income }, { data: expenses }] = await Promise.all([
      supabase
        .from('income_entries')
        .select('*')
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: false }),
      supabase
        .from('expense_entries')
        .select('*')
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: false }),
    ]);

    const totalIncome = (income || []).reduce((sum, e) => sum + e.amount, 0);
    const totalExpenses = (expenses || []).reduce((sum, e) => sum + e.amount, 0);

    // Group expenses by category
    const expensesByCategory: Record<string, number> = {};
    for (const exp of expenses || []) {
      const cat = exp.category || 'Other';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + exp.amount;
    }

    return {
      month,
      year,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      net_profit: totalIncome - totalExpenses,
      income_entries: income || [],
      expense_entries: expenses || [],
      expenses_by_category: expensesByCategory,
    };
  },

  // ─── YEAR-END REPORT ─────────────────────────────────────────────────

  async getYearEndReport(year: number) {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const [{ data: income }, { data: expenses }] = await Promise.all([
      supabase
        .from('income_entries')
        .select('*')
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true }),
      supabase
        .from('expense_entries')
        .select('*')
        .gte('date', startDate)
        .lte('date', endDate)
        .order('date', { ascending: true }),
    ]);

    const allIncome = income || [];
    const allExpenses = expenses || [];

    const totalIncome = allIncome.reduce((sum, e) => sum + e.amount, 0);
    const totalExpenses = allExpenses.reduce((sum, e) => sum + e.amount, 0);

    // Expenses by category
    const expensesByCategory: Record<string, number> = {};
    for (const exp of allExpenses) {
      const cat = exp.category || 'Other';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + exp.amount;
    }

    // Monthly breakdown
    const monthlyBreakdown: Record<number, { income: number; expenses: number; net: number }> = {};
    for (let m = 1; m <= 12; m++) {
      monthlyBreakdown[m] = { income: 0, expenses: 0, net: 0 };
    }

    for (const entry of allIncome) {
      const month = new Date(entry.date).getMonth() + 1;
      monthlyBreakdown[month].income += entry.amount;
    }

    for (const entry of allExpenses) {
      const month = new Date(entry.date).getMonth() + 1;
      monthlyBreakdown[month].expenses += entry.amount;
    }

    for (let m = 1; m <= 12; m++) {
      monthlyBreakdown[m].net = monthlyBreakdown[m].income - monthlyBreakdown[m].expenses;
    }

    return {
      year,
      total_income: totalIncome,
      total_expenses: totalExpenses,
      net_profit: totalIncome - totalExpenses,
      profit_margin: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100) : 0,
      expenses_by_category: expensesByCategory,
      monthly_breakdown: monthlyBreakdown,
      income_entries: allIncome,
      expense_entries: allExpenses,
    };
  },

  // ─── SEED DATA ────────────────────────────────────────────────────────

  async seedData(payload: {
    income?: any[];
    expenses?: any[];
    debt?: any[];
    crew_members?: any[];
    crew_logs?: any[];
  }) {
    const results: Record<string, number> = {};

    if (payload.income && payload.income.length > 0) {
      const { data, error } = await supabase
        .from('income_entries')
        .insert(payload.income)
        .select();
      if (error) throw error;
      results.income = data?.length || 0;
    }

    if (payload.expenses && payload.expenses.length > 0) {
      const { data, error } = await supabase
        .from('expense_entries')
        .insert(payload.expenses)
        .select();
      if (error) throw error;
      results.expenses = data?.length || 0;
    }

    if (payload.debt && payload.debt.length > 0) {
      const { data, error } = await supabase
        .from('debt_tracker')
        .insert(payload.debt)
        .select();
      if (error) throw error;
      results.debt = data?.length || 0;
    }

    if (payload.crew_members && payload.crew_members.length > 0) {
      const { data, error } = await supabase
        .from('crew_members')
        .insert(payload.crew_members)
        .select();
      if (error) throw error;
      results.crew_members = data?.length || 0;
    }

    if (payload.crew_logs && payload.crew_logs.length > 0) {
      const { data, error } = await supabase
        .from('crew_daily_log')
        .insert(payload.crew_logs)
        .select();
      if (error) throw error;
      results.crew_logs = data?.length || 0;
    }

    return results;
  },
};
