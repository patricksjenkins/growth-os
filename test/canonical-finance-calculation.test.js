'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  FinanceContractError,
  majorToMinorUnits,
  minorUnitsToDecimal,
  calculateCanonicalFinance,
} = require('../core/finance/canonical-calculation');

function authoritativeEntry(overrides = {}) {
  return {
    id: 'entry-1',
    kind: 'income',
    amount: '10.00',
    currency: 'USD',
    authority: 'authoritative',
    attribution: 'attributed',
    ...overrides,
  };
}

function matchedCheck(overrides = {}) {
  return {
    id: 'bank-operating',
    currency: 'USD',
    evidenceStatus: 'available',
    authoritativeAmount: '10.00',
    ledgerAmount: '10.00',
    ...overrides,
  };
}

test('major-unit parsing uses exact integer minor units without float drift', () => {
  const sum = majorToMinorUnits(0.1) + majorToMinorUnits(0.2);
  assert.strictEqual(sum, 30);
  assert.strictEqual(minorUnitsToDecimal(sum), '0.30');
  assert.strictEqual(majorToMinorUnits('10.000'), 1000);
  assert.strictEqual(minorUnitsToDecimal(-7), '-0.07');
});

test('money precision is rejected instead of silently rounded', () => {
  assert.throws(
    () => majorToMinorUnits('1.005'),
    (error) => error instanceof FinanceContractError
      && error.code === 'MONEY_PRECISION_EXCEEDED',
  );
});

test('verified result requires authoritative attributed entries and exact evidence', () => {
  const result = calculateCanonicalFinance({
    entries: [
      authoritativeEntry({ id: 'income-a', amount: '0.10' }),
      authoritativeEntry({ id: 'income-b', amount: '0.20' }),
      authoritativeEntry({
        id: 'expense-a',
        kind: 'expense',
        amount: '0.05',
      }),
    ],
    reconciliations: [
      matchedCheck({
        authoritativeAmount: '0.25',
        ledgerAmount: '0.25',
      }),
    ],
  });

  assert.deepStrictEqual(result.amounts.ledger, {
    incomeMinor: 30,
    expenseMinor: 5,
    netOperatingMinor: 25,
    ownerContributionMinor: 0,
    ownerDrawMinor: 0,
    salesTaxCollectedMinor: 0,
    salesTaxPaidMinor: 0,
  });
  assert.strictEqual(result.controls.canClose, true);
  assert.strictEqual(result.controls.canSignOff, true);
  assert.deepStrictEqual(result.controls.blockers, []);
  assert.deepStrictEqual(result.health, { state: 'verified', isGreen: true });
  assert.strictEqual(result.reconciliation.unreconciledMinor, 0);
});

test('authority and attribution are orthogonal and separately visible', () => {
  const result = calculateCanonicalFinance({
    entries: [
      authoritativeEntry({
        id: 'authoritative-unattributed',
        amount: '11.00',
        attribution: 'unattributed',
      }),
      authoritativeEntry({
        id: 'provisional-attributed',
        kind: 'expense',
        amount: '2.50',
        authority: 'provisional',
      }),
    ],
    reconciliations: [matchedCheck()],
  });

  assert.strictEqual(result.amounts.authoritative.incomeMinor, 1100);
  assert.strictEqual(result.amounts.unattributed.incomeMinor, 1100);
  assert.strictEqual(result.amounts.unverified.expenseMinor, 250);
  assert.ok(result.controls.blockers.some((b) => b.code === 'UNATTRIBUTED_AMOUNT'));
  assert.ok(result.controls.blockers.some((b) => b.code === 'NON_AUTHORITATIVE_AMOUNT'));
  assert.strictEqual(result.health.isGreen, false);
});

test('one-cent reconciliation difference blocks close and signoff', () => {
  const result = calculateCanonicalFinance({
    entries: [authoritativeEntry()],
    reconciliations: [
      matchedCheck({ authoritativeAmount: '10.00', ledgerAmount: '9.99' }),
    ],
  });

  assert.strictEqual(result.reconciliation.complete, true);
  assert.strictEqual(result.reconciliation.unreconciledMinor, 1);
  assert.strictEqual(result.reconciliation.checks[0].differenceMinor, -1);
  assert.strictEqual(result.controls.canClose, false);
  assert.strictEqual(result.controls.canSignOff, false);
  assert.ok(result.controls.blockers.some((b) => b.code === 'RECONCILIATION_DIFFERENCE'));
  assert.deepStrictEqual(result.health, { state: 'blocked', isGreen: false });
});

test('missing or unavailable evidence is unknown, never reported as zero variance', () => {
  const missing = calculateCanonicalFinance({
    entries: [authoritativeEntry()],
    reconciliations: [],
  });
  assert.strictEqual(missing.reconciliation.unreconciledMinor, null);
  assert.ok(missing.controls.blockers.some((b) => b.code === 'RECONCILIATION_EVIDENCE_MISSING'));

  const unavailable = calculateCanonicalFinance({
    entries: [authoritativeEntry()],
    reconciliations: [
      matchedCheck({
        evidenceStatus: 'unavailable',
        authoritativeAmount: undefined,
        ledgerAmount: undefined,
      }),
    ],
  });
  assert.strictEqual(unavailable.reconciliation.complete, false);
  assert.strictEqual(unavailable.reconciliation.knownUnreconciledMinor, 0);
  assert.strictEqual(unavailable.reconciliation.unreconciledMinor, null);
  assert.ok(unavailable.controls.blockers.some((b) => b.code === 'RECONCILIATION_UNAVAILABLE'));
  assert.strictEqual(unavailable.health.isGreen, false);
});

test('an empty ledger needs an explicit zero-activity attestation', () => {
  const noAttestation = calculateCanonicalFinance({
    entries: [],
    reconciliations: [
      matchedCheck({ authoritativeAmount: '0.00', ledgerAmount: '0.00' }),
    ],
  });
  assert.ok(noAttestation.controls.blockers.some((b) => b.code === 'LEDGER_EVIDENCE_MISSING'));
  assert.strictEqual(noAttestation.health.isGreen, false);

  const attested = calculateCanonicalFinance({
    entries: [],
    zeroActivityAttested: true,
    reconciliations: [
      matchedCheck({ authoritativeAmount: '0.00', ledgerAmount: '0.00' }),
    ],
  });
  assert.strictEqual(attested.controls.canClose, true);
});

test('invalid ledger values are surfaced and block close instead of disappearing', () => {
  const result = calculateCanonicalFinance({
    entries: [
      authoritativeEntry(),
      authoritativeEntry({ id: 'bad', amount: 'not-money' }),
    ],
    reconciliations: [matchedCheck()],
  });

  assert.strictEqual(result.entryCounts.received, 2);
  assert.strictEqual(result.entryCounts.valid, 1);
  assert.strictEqual(result.entryCounts.invalid, 1);
  assert.deepStrictEqual(result.invalidEntries, [
    { index: 1, id: 'bad', code: 'INVALID_MONEY' },
  ]);
  assert.strictEqual(result.controls.canClose, false);
  assert.ok(result.controls.blockers.some((b) => b.code === 'INVALID_MONEY'));
});

test('currency mismatch and duplicate entry identity fail closed', () => {
  const result = calculateCanonicalFinance({
    currency: 'USD',
    entries: [
      authoritativeEntry(),
      authoritativeEntry({ id: 'entry-1' }),
      authoritativeEntry({ id: 'eur-entry', currency: 'EUR' }),
    ],
    reconciliations: [matchedCheck()],
  });

  assert.ok(result.controls.blockers.some((b) => b.code === 'DUPLICATE_ENTRY_ID'));
  assert.ok(result.controls.blockers.some((b) => b.code === 'CURRENCY_MISMATCH'));
  assert.strictEqual(result.health.isGreen, false);
});

test('owner equity and sales tax stay outside operating profit', () => {
  const result = calculateCanonicalFinance({
    entries: [
      authoritativeEntry({ id: 'income', amount: '50.00' }),
      authoritativeEntry({ id: 'expense', kind: 'expense', amount: '20.00' }),
      authoritativeEntry({
        id: 'contribution',
        kind: 'owner_contribution',
        amount: '100.00',
      }),
      authoritativeEntry({
        id: 'sales-tax',
        kind: 'sales_tax_collected',
        amount: '4.00',
      }),
    ],
    reconciliations: [
      matchedCheck({ authoritativeAmount: '134.00', ledgerAmount: '134.00' }),
    ],
  });

  assert.strictEqual(result.amounts.ledger.netOperatingMinor, 3000);
  assert.strictEqual(result.amounts.ledger.ownerContributionMinor, 10000);
  assert.strictEqual(result.amounts.ledger.salesTaxCollectedMinor, 400);
});

test('aggregate overflow throws rather than losing integer precision', () => {
  assert.throws(
    () => calculateCanonicalFinance({
      entries: [
        authoritativeEntry({ id: 'a', amountMinor: Number.MAX_SAFE_INTEGER, amount: undefined }),
        authoritativeEntry({ id: 'b', amountMinor: 1, amount: undefined }),
      ],
      reconciliations: [matchedCheck()],
    }),
    (error) => error instanceof FinanceContractError && error.code === 'MONEY_OUT_OF_RANGE',
  );
});
