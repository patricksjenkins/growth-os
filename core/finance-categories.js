/**
 * Growth OS — Canonical finance categories + income classification
 *
 * The FGA books accumulated near-duplicate expense categories from different
 * entry paths ("AI & APIs" vs "AI/API Usage", "Infrastructure" vs "Hosting &
 * Infrastructure", "Tools & Subscriptions" vs "Software & Tools", ...).
 * Accountant-ready reporting needs ONE category set.
 *
 * This module normalizes at DISPLAY/ROLLUP time only — historical rows are
 * never mutated (finance_audit_log stays truthful). Reports both roll up by
 * canonical category and surface the raw→canonical mapping as a data-quality
 * item so the owner can clean source rows deliberately if desired.
 *
 * Canonical set mirrors a Schedule-C-friendly software business P&L.
 */

const CANONICAL_EXPENSE_CATEGORIES = [
  'AI/API Usage',
  'Hosting & Infrastructure',
  'SMS/Voice/Communication',
  'Payment Processing',
  'Bank & Payout Fees',
  'Software & Tools',
  'Advertising & Marketing',
  'Design & Creative',
  'Legal & Professional',
  'Office & Admin',
  'Contractors & Payroll',
  'Insurance',
  'Travel & Meals',
  'Education & Training',
  'Taxes & Fees',
  'Other',
];

// Raw category (lowercased, trimmed) → canonical. Anything not listed and not
// already canonical falls through to itself (kept visible, flagged in data
// quality) so nothing silently disappears from the books.
const CATEGORY_ALIASES = {
  'ai & apis': 'AI/API Usage',
  'ai/api': 'AI/API Usage',
  'ai': 'AI/API Usage',
  'infrastructure': 'Hosting & Infrastructure',
  'hosting': 'Hosting & Infrastructure',
  'hosting & infrastructure': 'Hosting & Infrastructure',
  'communications': 'SMS/Voice/Communication',
  'communication': 'SMS/Voice/Communication',
  'sms/voice/communication': 'SMS/Voice/Communication',
  'payment processing': 'Payment Processing',
  'bank/payout fees': 'Bank & Payout Fees',
  'bank fees': 'Bank & Payout Fees',
  'payout fees': 'Bank & Payout Fees',
  'software & tools': 'Software & Tools',
  'software & saas': 'Software & Tools',
  'tools & subscriptions': 'Software & Tools',
  'subscriptions': 'Software & Tools',
  'software': 'Software & Tools',
  'marketing': 'Advertising & Marketing',
  'marketing & advertising': 'Advertising & Marketing',
  'advertising/marketing': 'Advertising & Marketing',
  'advertising & marketing': 'Advertising & Marketing',
  'ads': 'Advertising & Marketing',
  'design/creative': 'Design & Creative',
  'design & creative': 'Design & Creative',
  'design': 'Design & Creative',
  'llc & legal': 'Legal & Professional',
  'legal & professional': 'Legal & Professional',
  'legal': 'Legal & Professional',
  'office/admin': 'Office & Admin',
  'office & admin': 'Office & Admin',
  'office & equipment': 'Office & Admin',
  'office': 'Office & Admin',
  'payroll & contractors': 'Contractors & Payroll',
  'contractors': 'Contractors & Payroll',
  'insurance': 'Insurance',
  'travel & conferences': 'Travel & Meals',
  'meals & entertainment': 'Travel & Meals',
  'travel & meals': 'Travel & Meals',
  'education & training': 'Education & Training',
  'taxes & fees': 'Taxes & Fees',
  'utilities': 'Office & Admin',
  'supplies & materials': 'Office & Admin',
  'other': 'Other',
  'uncategorized': 'Other',
};

const CANONICAL_SET = new Set(CANONICAL_EXPENSE_CATEGORIES);

/**
 * Normalize a raw expense category to its canonical form.
 * @returns {{ canonical: string, wasAlias: boolean, raw: string }}
 */
function normalizeCategory(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { canonical: 'Other', wasAlias: true, raw: trimmed || '(none)' };
  if (CANONICAL_SET.has(trimmed)) return { canonical: trimmed, wasAlias: false, raw: trimmed };
  const alias = CATEGORY_ALIASES[trimmed.toLowerCase()];
  if (alias) return { canonical: alias, wasAlias: true, raw: trimmed };
  // Unknown category — keep it visible rather than hiding money in "Other".
  return { canonical: trimmed, wasAlias: false, raw: trimmed };
}

/**
 * Classify an income ledger row into a revenue source bucket. Heuristics over
 * job_type/category/description — kept here so every report agrees.
 */
const INCOME_SOURCES = [
  'Subscription Revenue',
  'Setup Fee',
  'Usage Revenue',
  'Custom Work',
  'Consulting',
  'Other Income',
];

function classifyIncome(e) {
  const tags = `${e.job_type || ''} ${e.category || ''} ${e.description || ''}`.toLowerCase();
  if (/setup\s*fee|onboarding\s*fee|one[-\s]?time\s*setup/.test(tags)) return 'Setup Fee';
  if (/subscription|monthly|recurring|growth\s*tier|scale\s*tier|mrr/.test(tags)) return 'Subscription Revenue';
  if (/usage|overage|metered/.test(tags)) return 'Usage Revenue';
  if (/consult/.test(tags)) return 'Consulting';
  if (/custom|build|project/.test(tags)) return 'Custom Work';
  return 'Other Income';
}

module.exports = {
  CANONICAL_EXPENSE_CATEGORIES,
  CATEGORY_ALIASES,
  normalizeCategory,
  INCOME_SOURCES,
  classifyIncome,
};
