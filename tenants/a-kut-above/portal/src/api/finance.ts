import client from './client';

// --- Income ---
export interface IncomeEntry {
  id?: string;
  customer_name: string;
  amount: number;
  date: string;
  job_type?: string;
  notes?: string;
}

export async function getIncome(month: number, year: number) {
  const res = await client.get('/api/finance/income', { params: { month, year } });
  return res.data;
}

export async function addIncome(data: Omit<IncomeEntry, 'id'>) {
  const res = await client.post('/api/finance/income', data);
  return res.data;
}

export async function updateIncome(id: string, data: Partial<IncomeEntry>) {
  const res = await client.patch(`/api/finance/income/${id}`, data);
  return res.data;
}

export async function deleteIncome(id: string) {
  const res = await client.delete(`/api/finance/income/${id}`);
  return res.data;
}

// --- Expenses ---
export interface ExpenseEntry {
  id?: string;
  description: string;
  category: string;
  amount: number;
  date: string;
  recurring?: boolean;
}

export async function getExpenses(month: number, year: number) {
  const res = await client.get('/api/finance/expenses', { params: { month, year } });
  return res.data;
}

export async function addExpense(data: Omit<ExpenseEntry, 'id'>) {
  const res = await client.post('/api/finance/expenses', data);
  return res.data;
}

export async function updateExpense(id: string, data: Partial<ExpenseEntry>) {
  const res = await client.patch(`/api/finance/expenses/${id}`, data);
  return res.data;
}

export async function deleteExpense(id: string) {
  const res = await client.delete(`/api/finance/expenses/${id}`);
  return res.data;
}

export async function rolloverExpenses(month: number, year: number) {
  const res = await client.post('/api/finance/expenses/rollover', { month, year });
  return res.data;
}

// --- Customers ---
export interface CustomerData {
  customer_name: string;
  total_revenue: number;
  job_count: number;
  first_job: string;
  last_job: string;
  is_repeat: boolean;
}

export async function getCustomers() {
  const res = await client.get('/api/finance/customers');
  return res.data;
}

export async function searchCustomers(q: string) {
  const res = await client.get('/api/finance/customers/search', { params: { q } });
  return res.data;
}

export async function getCustomerInsights(year?: number) {
  const res = await client.get('/api/finance/customers/insights', { params: year ? { year } : {} });
  return res.data;
}

// --- Dashboard / Summary ---
export async function getDashboard(year: number) {
  const res = await client.get('/api/finance/summary', { params: { year } });
  return res.data;
}

export async function getYearlySummary(year: number) {
  const res = await client.get('/api/finance/summary', { params: { year } });
  return res.data;
}

// --- Crew ---
export interface CrewMember {
  id?: string;
  name: string;
  daily_rate: number;
}

export interface CrewLog {
  crew_member_id: string;
  date: string;
  worked: boolean;
}

export async function getCrewMembers() {
  const res = await client.get('/api/finance/crew');
  return res.data;
}

export async function addCrewMember(data: { name: string; daily_rate: number }) {
  const res = await client.post('/api/finance/crew', data);
  return res.data;
}

export async function updateCrewMember(id: string, data: Partial<CrewMember>) {
  const res = await client.patch(`/api/finance/crew/${id}`, data);
  return res.data;
}

export async function deleteCrewMember(id: string) {
  const res = await client.delete(`/api/finance/crew/${id}`);
  return res.data;
}

export async function getCrewLogs(month: number, year: number) {
  const res = await client.get('/api/finance/crew/log', { params: { month, year } });
  return res.data;
}

export async function toggleCrewLog(crew_member_id: string, date: string) {
  const res = await client.post('/api/finance/crew/log', { crew_member_id, date, worked: true });
  return res.data;
}

export async function getCrewYearlySummary(year: number) {
  const res = await client.get('/api/finance/crew/yearly-summary', { params: { year } });
  return res.data;
}

// --- Debt ---
export interface DebtEntry {
  id?: string;
  name: string;
  original_amount: number;
  current_balance: number;
  monthly_payment: number;
}

export async function getDebts() {
  const res = await client.get('/api/finance/debt');
  return res.data;
}

export async function addDebt(data: Omit<DebtEntry, 'id'>) {
  const res = await client.post('/api/finance/debt', data);
  return res.data;
}

export async function updateDebt(id: string, data: Partial<DebtEntry>) {
  const res = await client.patch(`/api/finance/debt/${id}`, data);
  return res.data;
}

export async function deleteDebt(id: string) {
  const res = await client.delete(`/api/finance/debt/${id}`);
  return res.data;
}

// --- Reports ---
export async function getPLReport(year: number) {
  const res = await client.get('/api/finance/report/year-end', { params: { year } });
  return res.data;
}

// --- Jobs & Leads ---
export async function getJobs(_page = 1) {
  const res = await client.get('/api/leads', { params: { status: 'won', limit: 50 } });
  return res.data;
}

export async function getLeads(status = '', _page = 1) {
  const res = await client.get('/api/leads', { params: { status, limit: 50 } });
  return res.data;
}

export async function updateLead(id: string, data: Record<string, unknown>) {
  const res = await client.put(`/api/leads/${id}`, data);
  return res.data;
}
