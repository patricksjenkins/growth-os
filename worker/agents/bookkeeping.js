/**
 * Growth OS — Bookkeeping Agent
 * Auto-categorizes transactions, flags uncategorized entries,
 * identifies duplicate entries, and reconciles monthly books.
 *
 * Multi-tenant: scoped by tenant_id.
 * Uses finance_entries table + Claude for smart categorization.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');
const { askClaudeJSON } = require('../../integrations/claude');

// ============================================================================
// STANDARD EXPENSE CATEGORIES
// ============================================================================

const EXPENSE_CATEGORIES = [
  'Software & SaaS',
  'Marketing & Advertising',
  'Payroll & Contractors',
  'Office & Equipment',
  'Travel & Conferences',
  'Insurance',
  'Legal & Professional',
  'Subscriptions',
  'Utilities',
  'Meals & Entertainment',
  'Vehicle & Fuel',
  'Supplies & Materials',
  'Education & Training',
  'Taxes & Fees',
  'Hosting & Infrastructure',
  'Communication',
  'Other'
];

// ============================================================================
// DATA FETCHERS
// ============================================================================

async function getUncategorizedExpenses(tenantId) {
  const { data, error } = await db
    .from('finance_entries')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .or('category.is.null,category.eq.')
    .order('date', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getMonthEntries(tenantId, month, year) {
  const start = new Date(year, month - 1, 1).toISOString().split('T')[0];
  const end = new Date(year, month, 0).toISOString().split('T')[0];

  const { data, error } = await db
    .from('finance_entries')
    .select('*')
    .eq('tenant_id', tenantId)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true });

  if (error) return [];
  return data || [];
}

async function getAllExpenses(tenantId) {
  const { data, error } = await db
    .from('finance_entries')
    .select('id, description, amount, date, category, recurring')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'expense')
    .order('date', { ascending: false })
    .limit(500);

  if (error) return [];
  return data || [];
}

// ============================================================================
// CATEGORIZATION (Claude-powered)
// ============================================================================

async function categorizeExpenses(expenses) {
  if (expenses.length === 0) return [];

  const expenseList = expenses.map(e => ({
    id: e.id,
    description: e.description,
    amount: e.amount
  }));

  const systemPrompt = `You are a bookkeeping assistant. Categorize each expense into one of these categories:
${EXPENSE_CATEGORIES.join(', ')}

Return a JSON array of objects with "id" and "category" fields.`;

  const userMessage = `Categorize these expenses:\n${JSON.stringify(expenseList, null, 2)}`;

  try {
    const result = await askClaudeJSON(systemPrompt, userMessage, { maxTokens: 2048 });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

// ============================================================================
// DUPLICATE DETECTION
// ============================================================================

function findDuplicates(expenses) {
  const duplicates = [];
  const seen = new Map();

  for (const exp of expenses) {
    const key = `${exp.description?.toLowerCase().trim()}|${exp.amount}|${exp.date}`;
    if (seen.has(key)) {
      duplicates.push({
        original_id: seen.get(key).id,
        duplicate_id: exp.id,
        description: exp.description,
        amount: exp.amount,
        date: exp.date
      });
    } else {
      seen.set(key, exp);
    }
  }

  return duplicates;
}

// ============================================================================
// MONTHLY RECONCILIATION
// ============================================================================

function reconcileMonth(entries) {
  const income = entries.filter(e => e.entry_type === 'income');
  const expenses = entries.filter(e => e.entry_type === 'expense');

  const totalIncome = income.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);

  const uncategorized = expenses.filter(e => !e.category || e.category === '');
  const byCategory = {};
  for (const exp of expenses) {
    const cat = exp.category || 'Uncategorized';
    byCategory[cat] = (byCategory[cat] || 0) + (parseFloat(exp.amount) || 0);
  }

  const issues = [];
  if (uncategorized.length > 0) {
    issues.push(`${uncategorized.length} expense(s) missing category`);
  }
  if (totalExpenses > totalIncome && totalIncome > 0) {
    issues.push(`Expenses ($${totalExpenses.toFixed(2)}) exceed income ($${totalIncome.toFixed(2)})`);
  }

  return {
    total_income: totalIncome,
    total_expenses: totalExpenses,
    net: totalIncome - totalExpenses,
    income_count: income.length,
    expense_count: expenses.length,
    uncategorized_count: uncategorized.length,
    expenses_by_category: byCategory,
    issues
  };
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { action: 'categorize' | 'reconcile' | 'check', month?, year? }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('bookkeeping', tenant.slug);
  const action = payload.action || 'check';

  log.info(`Running bookkeeping: ${action}`);

  if (action === 'categorize') {
    // Auto-categorize uncategorized expenses
    const uncategorized = await getUncategorizedExpenses(tenant.id);

    if (uncategorized.length === 0) {
      log.success('No uncategorized expenses');
      return { success: true, categorized: 0, message: 'All expenses are categorized' };
    }

    const categories = await categorizeExpenses(uncategorized);
    let updated = 0;

    for (const cat of categories) {
      if (cat.id && cat.category && EXPENSE_CATEGORIES.includes(cat.category)) {
        const { error } = await db
          .from('finance_entries')
          .update({ category: cat.category })
          .eq('id', cat.id)
          .eq('tenant_id', tenant.id);

        if (!error) updated++;
      }
    }

    log.success('Categorization complete', { updated, total: uncategorized.length });
    return { success: true, categorized: updated, total_uncategorized: uncategorized.length };
  }

  if (action === 'reconcile') {
    // Monthly reconciliation
    const now = new Date();
    const month = payload.month || now.getMonth() + 1;
    const year = payload.year || now.getFullYear();

    const entries = await getMonthEntries(tenant.id, month, year);
    const reconciliation = reconcileMonth(entries);

    log.success('Reconciliation complete', { month, year, net: reconciliation.net });
    return { success: true, month, year, ...reconciliation };
  }

  // Default: health check
  const [uncategorized, allExpenses] = await Promise.all([
    getUncategorizedExpenses(tenant.id),
    getAllExpenses(tenant.id)
  ]);

  const duplicates = findDuplicates(allExpenses);

  const now = new Date();
  const entries = await getMonthEntries(tenant.id, now.getMonth() + 1, now.getFullYear());
  const reconciliation = reconcileMonth(entries);

  const health = {
    uncategorized_count: uncategorized.length,
    duplicate_count: duplicates.length,
    current_month: reconciliation,
    issues: [
      ...reconciliation.issues,
      ...(duplicates.length > 0 ? [`${duplicates.length} potential duplicate(s) found`] : [])
    ]
  };

  log.success('Bookkeeping check complete', {
    uncategorized: health.uncategorized_count,
    duplicates: health.duplicate_count,
    issues: health.issues.length
  });

  return {
    success: true,
    ...health,
    duplicates: duplicates.slice(0, 10)
  };
}

module.exports = run;
