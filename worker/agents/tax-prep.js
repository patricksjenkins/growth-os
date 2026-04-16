/**
 * Growth OS — Tax Prep Agent
 * Generates quarterly estimated tax summaries, tracks deductible expenses,
 * and produces year-end tax preparation data.
 *
 * Multi-tenant: scoped by tenant_id.
 * Uses finance_entries, crew_daily_log, debt_tracker.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

// ============================================================================
// TAX-DEDUCTIBLE CATEGORIES
// ============================================================================

const DEDUCTIBLE_CATEGORIES = {
  'Software & SaaS': { schedule: 'C', line: 'Other expenses', deduction_pct: 100 },
  'Marketing & Advertising': { schedule: 'C', line: 'Advertising', deduction_pct: 100 },
  'Office & Equipment': { schedule: 'C', line: 'Office expense', deduction_pct: 100 },
  'Subscriptions': { schedule: 'C', line: 'Other expenses', deduction_pct: 100 },
  'Insurance': { schedule: 'C', line: 'Insurance', deduction_pct: 100 },
  'Legal & Professional': { schedule: 'C', line: 'Legal and professional services', deduction_pct: 100 },
  'Vehicle & Fuel': { schedule: 'C', line: 'Car and truck expenses', deduction_pct: 100 },
  'Travel & Conferences': { schedule: 'C', line: 'Travel', deduction_pct: 100 },
  'Meals & Entertainment': { schedule: 'C', line: 'Meals', deduction_pct: 50 },
  'Education & Training': { schedule: 'C', line: 'Other expenses', deduction_pct: 100 },
  'Supplies & Materials': { schedule: 'C', line: 'Supplies', deduction_pct: 100 },
  'Communication': { schedule: 'C', line: 'Utilities', deduction_pct: 100 },
  'Utilities': { schedule: 'C', line: 'Utilities', deduction_pct: 100 },
  'Hosting & Infrastructure': { schedule: 'C', line: 'Other expenses', deduction_pct: 100 },
  'Taxes & Fees': { schedule: 'C', line: 'Taxes and licenses', deduction_pct: 100 },
  'Payroll & Contractors': { schedule: 'C', line: 'Contract labor', deduction_pct: 100 }
};

// Simplified federal self-employment + income tax brackets (2026 estimates)
const SE_TAX_RATE = 0.153; // 15.3% self-employment tax
const SE_DEDUCTION = 0.5;  // Deduct half of SE tax

const FEDERAL_BRACKETS = [
  { min: 0, max: 11600, rate: 0.10 },
  { min: 11600, max: 47150, rate: 0.12 },
  { min: 47150, max: 100525, rate: 0.22 },
  { min: 100525, max: 191950, rate: 0.24 },
  { min: 191950, max: 243725, rate: 0.32 },
  { min: 243725, max: 609350, rate: 0.35 },
  { min: 609350, max: Infinity, rate: 0.37 }
];

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function getEntries(tenantId, year) {
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

async function getCrewPayroll(tenantId, year) {
  const [membersRes, logsRes] = await Promise.all([
    db.from('crew_members').select('id, name, daily_rate').eq('tenant_id', tenantId),
    db.from('crew_daily_log')
      .select('crew_member_id, date, worked')
      .eq('tenant_id', tenantId)
      .eq('worked', true)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
  ]);

  const members = membersRes.data || [];
  const logs = logsRes.data || [];

  return members.map(m => {
    const days = logs.filter(l => l.crew_member_id === m.id).length;
    return {
      name: m.name,
      days_worked: days,
      total_paid: days * (parseFloat(m.daily_rate) || 0)
    };
  }).filter(m => m.days_worked > 0);
}

// ============================================================================
// TAX COMPUTATION
// ============================================================================

function computeFederalTax(taxableIncome) {
  let tax = 0;
  for (const bracket of FEDERAL_BRACKETS) {
    if (taxableIncome <= bracket.min) break;
    const taxable = Math.min(taxableIncome, bracket.max) - bracket.min;
    tax += taxable * bracket.rate;
  }
  return tax;
}

function buildTaxSummary(entries, crewPayroll, quarter = null) {
  let filtered = entries;

  if (quarter) {
    const startMonth = (quarter - 1) * 3;
    const endMonth = startMonth + 3;
    filtered = entries.filter(e => {
      const month = new Date(e.date).getMonth();
      return month >= startMonth && month < endMonth;
    });
  }

  const income = filtered.filter(e => e.entry_type === 'income');
  const expenses = filtered.filter(e => e.entry_type === 'expense');

  const grossIncome = income.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  // Crew costs (contractor labor deduction)
  let crewCosts = 0;
  if (!quarter) {
    crewCosts = crewPayroll.reduce((s, c) => s + c.total_paid, 0);
  } else {
    // Proportional crew costs for quarter
    const totalCrew = crewPayroll.reduce((s, c) => s + c.total_paid, 0);
    crewCosts = totalCrew / 4; // Simplified proportional split
  }

  // Deduction breakdown by schedule line
  const deductionsByLine = {};
  let totalDeductions = 0;

  for (const exp of expenses) {
    const catInfo = DEDUCTIBLE_CATEGORIES[exp.category];
    if (catInfo) {
      const deductible = (parseFloat(exp.amount) || 0) * (catInfo.deduction_pct / 100);
      const line = catInfo.line;
      deductionsByLine[line] = (deductionsByLine[line] || 0) + deductible;
      totalDeductions += deductible;
    }
  }

  // Add crew costs as contract labor deduction
  if (crewCosts > 0) {
    deductionsByLine['Contract labor'] = (deductionsByLine['Contract labor'] || 0) + crewCosts;
    totalDeductions += crewCosts;
  }

  // Net self-employment income
  const netSEIncome = grossIncome - totalDeductions;

  // Self-employment tax
  const seTax = Math.max(0, netSEIncome * 0.9235 * SE_TAX_RATE); // 92.35% of net SE income
  const seDeduction = seTax * SE_DEDUCTION;

  // Taxable income (after SE deduction + standard deduction)
  const standardDeduction = quarter ? 14600 / 4 : 14600; // Single filer 2026 estimate
  const taxableIncome = Math.max(0, netSEIncome - seDeduction - standardDeduction);

  // Federal income tax
  const annualizedTaxable = quarter ? taxableIncome * 4 : taxableIncome;
  const federalTax = computeFederalTax(annualizedTaxable) / (quarter ? 4 : 1);

  // Total estimated tax
  const totalEstimatedTax = seTax + federalTax;
  const quarterlyPayment = quarter ? totalEstimatedTax : totalEstimatedTax / 4;

  return {
    gross_income: grossIncome,
    total_expenses: totalExpenses,
    crew_costs: crewCosts,
    total_deductions: totalDeductions,
    deductions_by_line: deductionsByLine,
    net_self_employment_income: netSEIncome,
    self_employment_tax: Math.round(seTax * 100) / 100,
    federal_income_tax: Math.round(federalTax * 100) / 100,
    total_estimated_tax: Math.round(totalEstimatedTax * 100) / 100,
    quarterly_payment: Math.round(quarterlyPayment * 100) / 100,
    effective_rate: grossIncome > 0
      ? Math.round((totalEstimatedTax / grossIncome) * 100 * 10) / 10
      : 0
  };
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { year?: number, quarter?: 1|2|3|4 }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('tax-prep', tenant.slug);
  const year = payload.year || new Date().getFullYear();
  const quarter = payload.quarter || null;

  const label = quarter ? `Q${quarter} ${year}` : `${year} full year`;
  log.info(`Generating tax prep: ${label}`);

  const [entries, crewPayroll] = await Promise.all([
    getEntries(tenant.id, year),
    getCrewPayroll(tenant.id, year)
  ]);

  const taxSummary = buildTaxSummary(entries, crewPayroll, quarter);

  // Quarterly breakdown if full year
  let quarterlyBreakdown = null;
  if (!quarter) {
    quarterlyBreakdown = {};
    for (let q = 1; q <= 4; q++) {
      quarterlyBreakdown[`Q${q}`] = buildTaxSummary(entries, crewPayroll, q);
    }
  }

  log.success('Tax prep complete', {
    gross: taxSummary.gross_income,
    estimated_tax: taxSummary.total_estimated_tax,
    effective_rate: `${taxSummary.effective_rate}%`
  });

  return {
    success: true,
    period: label,
    year,
    quarter,
    summary: taxSummary,
    crew_payroll: crewPayroll,
    quarterly_breakdown: quarterlyBreakdown,
    note: 'These are estimates only. Consult a tax professional for actual filings.'
  };
}

module.exports = run;
