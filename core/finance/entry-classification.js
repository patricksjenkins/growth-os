'use strict';

/**
 * ONE definition of how a finance entry hits the P&L.
 *
 * Built 2026-07-24 to kill a live $1,000 owner-facing defect. The
 * financial-dashboard agent classified entries as:
 *
 *     if (entry.entry_type === 'income') { income } else { EXPENSE }
 *
 * ...so FGA's single $1,000 `owner_contribution` (a capital injection on
 * 2026-05-23) was booked as an operating expense. The dashboard reported
 * $3,841.91 of 2026 expenses while the ledger summed $2,841.91, and net
 * profit was understated by the same $1,000.
 *
 * api/routes/finance.js, api/routes/metrics.js and
 * core/finance/canonical-calculation.js already excluded owner equity
 * correctly — the agent was the lone outlier. That is exactly the class of
 * drift this module exists to prevent: every consumer now asks the same
 * function instead of re-deriving the rule with an `else`.
 *
 * Semantics (matches ENTRY_KIND_MAP in canonical-calculation.js):
 *   income               → revenue, hits P&L
 *   expense              → operating expense, hits P&L
 *   owner_contribution   → owner equity IN  — capital, NOT an expense
 *   owner_draw           → owner equity OUT — distribution, NOT an expense
 *   sales_tax_collected  → pass-through liability, never revenue
 *   sales_tax_paid       → pass-through remittance, never an expense
 *   anything unknown     → excluded from P&L and reported, never silently
 *                          absorbed into expenses
 */

const PL_INCOME = 'income';
const PL_EXPENSE = 'expense';
const EQUITY_IN = 'equity_in';
const EQUITY_OUT = 'equity_out';
const PASS_THROUGH = 'pass_through';
const UNKNOWN = 'unknown';

const CLASSIFICATION = new Map([
  ['income', PL_INCOME],
  ['expense', PL_EXPENSE],
  ['owner_contribution', EQUITY_IN],
  ['owner_draw', EQUITY_OUT],
  ['sales_tax_collected', PASS_THROUGH],
  ['sales_tax_paid', PASS_THROUGH],
]);

/** Canonical class for an entry_type. Unrecognized types return 'unknown'. */
function classifyEntryType(entryType) {
  const key = String(entryType || '').trim().toLowerCase();
  return CLASSIFICATION.get(key) || UNKNOWN;
}

/** True only for real revenue. */
function isProfitAndLossIncome(entryType) {
  return classifyEntryType(entryType) === PL_INCOME;
}

/**
 * True only for real operating expense.
 *
 * The bug this replaces: `else` treated every non-income row as expense.
 * Never reintroduce a negated income check — ask this function.
 */
function isProfitAndLossExpense(entryType) {
  return classifyEntryType(entryType) === PL_EXPENSE;
}

/** Owner equity movements — capital, excluded from profit and loss. */
function isOwnerEquity(entryType) {
  const k = classifyEntryType(entryType);
  return k === EQUITY_IN || k === EQUITY_OUT;
}

/** Types deliberately excluded from P&L totals. */
function isExcludedFromProfitAndLoss(entryType) {
  const k = classifyEntryType(entryType);
  return k !== PL_INCOME && k !== PL_EXPENSE;
}

/**
 * Split a set of entries into reconciled P&L buckets.
 *
 * Returns explicit `excluded` and `unknownTypes` collections so a caller can
 * SHOW what it left out rather than quietly dropping (or absorbing) it — the
 * reporting habit that let the $1,000 hide.
 */
function summarizeEntries(entries = []) {
  const out = {
    income: 0,
    expense: 0,
    equityIn: 0,
    equityOut: 0,
    passThrough: 0,
    excludedFromPL: 0,
    unknownTypes: [],
    counts: { income: 0, expense: 0, equityIn: 0, equityOut: 0, passThrough: 0, unknown: 0 },
  };
  for (const e of entries) {
    const amt = Number.parseFloat(e?.amount) || 0;
    switch (classifyEntryType(e?.entry_type)) {
      case PL_INCOME: out.income += amt; out.counts.income++; break;
      case PL_EXPENSE: out.expense += amt; out.counts.expense++; break;
      case EQUITY_IN: out.equityIn += amt; out.excludedFromPL += amt; out.counts.equityIn++; break;
      case EQUITY_OUT: out.equityOut += amt; out.excludedFromPL += amt; out.counts.equityOut++; break;
      case PASS_THROUGH: out.passThrough += amt; out.excludedFromPL += amt; out.counts.passThrough++; break;
      default: {
        out.excludedFromPL += amt;
        out.counts.unknown++;
        const t = String(e?.entry_type || 'null');
        if (!out.unknownTypes.includes(t)) out.unknownTypes.push(t);
      }
    }
  }
  out.net = out.income - out.expense;
  return out;
}

module.exports = {
  PL_INCOME,
  PL_EXPENSE,
  EQUITY_IN,
  EQUITY_OUT,
  PASS_THROUGH,
  UNKNOWN,
  classifyEntryType,
  isProfitAndLossIncome,
  isProfitAndLossExpense,
  isOwnerEquity,
  isExcludedFromProfitAndLoss,
  summarizeEntries,
};
