/**
 * Finance entry classification — the axis that was never tested (2026-07-24).
 *
 * The Financials rebuild added tests pinning page-vs-page consistency. It
 * never pinned AGENT-OUTPUT vs LEDGER-SUM, which is the axis that failed:
 * financial-dashboard reported $3,841.91 of 2026 FGA expenses while the
 * ledger summed $2,841.91, because a $1,000 owner_contribution fell into an
 * `else` branch and was booked as an operating expense.
 *
 * These tests encode the accounting rule and the reconciliation identity, so
 * any future consumer that re-derives classification with a negated income
 * check fails here instead of on Patrick's dashboard.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyEntryType,
  isProfitAndLossIncome,
  isProfitAndLossExpense,
  isOwnerEquity,
  isExcludedFromProfitAndLoss,
  summarizeEntries,
} = require('../core/finance/entry-classification');

test('owner equity is never an expense — the exact $1,000 defect', () => {
  assert.strictEqual(isProfitAndLossExpense('owner_contribution'), false,
    'owner_contribution must NOT be an operating expense');
  assert.strictEqual(isProfitAndLossExpense('owner_draw'), false);
  assert.strictEqual(isOwnerEquity('owner_contribution'), true);
  assert.strictEqual(isExcludedFromProfitAndLoss('owner_contribution'), true);
});

test('pass-through sales tax is neither revenue nor expense', () => {
  for (const t of ['sales_tax_collected', 'sales_tax_paid']) {
    assert.strictEqual(isProfitAndLossIncome(t), false, `${t} is not revenue`);
    assert.strictEqual(isProfitAndLossExpense(t), false, `${t} is not an expense`);
    assert.strictEqual(isExcludedFromProfitAndLoss(t), true);
  }
});

test('only income and expense hit the P&L', () => {
  assert.strictEqual(isProfitAndLossIncome('income'), true);
  assert.strictEqual(isProfitAndLossExpense('expense'), true);
  assert.strictEqual(isExcludedFromProfitAndLoss('income'), false);
  assert.strictEqual(isExcludedFromProfitAndLoss('expense'), false);
});

test('unknown entry types are excluded and REPORTED, never absorbed', () => {
  assert.strictEqual(classifyEntryType('some_new_type_2027'), 'unknown');
  assert.strictEqual(isProfitAndLossExpense('some_new_type_2027'), false,
    'an unrecognized type must not silently become an expense');
  const s = summarizeEntries([{ entry_type: 'some_new_type_2027', amount: '42.00' }]);
  assert.strictEqual(s.expense, 0);
  assert.strictEqual(s.excludedFromPL, 42);
  assert.deepStrictEqual(s.unknownTypes, ['some_new_type_2027'],
    'unknown types must be listed so a human can classify them');
});

test('classification is case/whitespace tolerant', () => {
  assert.strictEqual(classifyEntryType(' Owner_Contribution '), 'equity_in');
  assert.strictEqual(classifyEntryType('EXPENSE'), 'expense');
});

test('reconciliation identity: FGA production shape reproduces the true numbers', () => {
  // Mirrors FGA's real 2026 ledger shape at the time of the defect:
  // 47 expense rows = $2,841.91 · 2 income = $999.00 · 1 owner_contribution = $1,000.00
  const entries = [
    { entry_type: 'expense', amount: '2841.91' },
    { entry_type: 'income', amount: '999.00' },
    { entry_type: 'owner_contribution', amount: '1000.00' },
  ];
  const s = summarizeEntries(entries);
  assert.strictEqual(s.expense, 2841.91, 'expenses must equal the ledger expense sum');
  assert.strictEqual(s.income, 999);
  assert.strictEqual(s.equityIn, 1000);
  assert.strictEqual(s.excludedFromPL, 1000);
  // The bug produced 3841.91. Prove we no longer can.
  assert.notStrictEqual(s.expense, 3841.91, 'the $1,000 defect must not reappear');
  // Ledger identity: every dollar lands in exactly one bucket.
  const total = s.income + s.expense + s.excludedFromPL;
  assert.strictEqual(Math.round(total * 100) / 100, 4840.91,
    'income + expense + excluded must equal the full ledger');
});

test('financial-dashboard uses the shared classifier, not a negated income check', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'worker', 'agents', 'financial-dashboard.js'), 'utf8');
  assert.match(src, /require\('\.\.\/\.\.\/core\/finance\/entry-classification'\)/,
    'the agent must import the shared classifier');
  assert.match(src, /isProfitAndLossExpense\(entry\.entry_type\)/,
    'expense classification must ask the shared function');
  assert.ok(!/entry\.entry_type === 'income'\)\s*\{[\s\S]{0,400}\}\s*else\s*\{[\s\S]{0,120}monthly\[month\]\.expenses/.test(src),
    'the if-income/else-expense pattern must not return');
  assert.match(src, /excluded_from_pl/,
    'excluded amounts must be surfaced in the report payload');
});
