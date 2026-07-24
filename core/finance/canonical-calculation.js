'use strict';

/**
 * Canonical finance calculation and reconciliation contract.
 *
 * This module is deliberately pure: it does not query a database, mutate a
 * period lock, or call a payment provider. Callers must supply explicit
 * authority, attribution, and reconciliation evidence. Missing evidence is a
 * blocker, never an implied zero or a green status.
 *
 * All calculations use integer minor units. Major-unit decimals are parsed as
 * strings and converted without binary floating-point arithmetic.
 */

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_MINOR = BigInt(Number.MIN_SAFE_INTEGER);

const ENTRY_KIND_MAP = new Map([
  ['income', 'income'],
  ['expense', 'expense'],
  ['owner_contribution', 'ownerContribution'],
  ['owner_draw', 'ownerDraw'],
  ['sales_tax_collected', 'salesTaxCollected'],
  ['sales_tax_paid', 'salesTaxPaid'],
]);

const AUTHORITY_STATES = new Set(['authoritative', 'provisional', 'unknown']);
const ATTRIBUTION_STATES = new Set(['attributed', 'unattributed', 'unknown']);

class FinanceContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FinanceContractError';
    this.code = code;
  }
}

function assertMinorUnitExponent(exponent) {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 6) {
    throw new FinanceContractError(
      'INVALID_MINOR_UNIT_EXPONENT',
      'minorUnitExponent must be an integer from 0 through 6',
    );
  }
}

function safeBigIntToNumber(value) {
  if (value > MAX_SAFE_MINOR || value < MIN_SAFE_MINOR) {
    throw new FinanceContractError(
      'MONEY_OUT_OF_RANGE',
      'amount exceeds the safe integer range for minor-unit calculations',
    );
  }
  return Number(value);
}

function addSafeMinor(left, right) {
  return safeBigIntToNumber(BigInt(left) + BigInt(right));
}

function subtractSafeMinor(left, right) {
  return safeBigIntToNumber(BigInt(left) - BigInt(right));
}

/**
 * Convert a major-unit decimal (for example "12.34" USD) to integer minor
 * units. Values with non-zero precision beyond the configured exponent are
 * rejected instead of silently rounded.
 */
function majorToMinorUnits(value, minorUnitExponent = 2) {
  assertMinorUnitExponent(minorUnitExponent);
  if (value === null || value === undefined || value === '') {
    throw new FinanceContractError('MONEY_REQUIRED', 'amount is required');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new FinanceContractError('INVALID_MONEY', 'amount must be finite');
  }

  const raw = String(value).trim();
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) {
    throw new FinanceContractError(
      'INVALID_MONEY',
      'amount must be a plain base-10 decimal without separators or exponents',
    );
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = match[2];
  const fraction = match[3] || '';
  const retained = fraction.slice(0, minorUnitExponent);
  const discarded = fraction.slice(minorUnitExponent);
  if (/[1-9]/.test(discarded)) {
    throw new FinanceContractError(
      'MONEY_PRECISION_EXCEEDED',
      `amount has more than ${minorUnitExponent} non-zero decimal places`,
    );
  }

  const scale = 10n ** BigInt(minorUnitExponent);
  const fractionMinor = retained.padEnd(minorUnitExponent, '0') || '0';
  const minor = sign * ((BigInt(whole) * scale) + BigInt(fractionMinor));
  return safeBigIntToNumber(minor);
}

function parseMinorUnits(value) {
  if (value === null || value === undefined || value === '') {
    throw new FinanceContractError('MONEY_REQUIRED', 'minor-unit amount is required');
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isSafeInteger(value))) {
    throw new FinanceContractError(
      'INVALID_MINOR_UNITS',
      'minor-unit amount must be a safe integer',
    );
  }
  const raw = String(value).trim();
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new FinanceContractError(
      'INVALID_MINOR_UNITS',
      'minor-unit amount must be an integer',
    );
  }
  return safeBigIntToNumber(BigInt(raw));
}

function minorUnitsToDecimal(value, minorUnitExponent = 2) {
  assertMinorUnitExponent(minorUnitExponent);
  const minor = parseMinorUnits(value);
  const sign = minor < 0 ? '-' : '';
  const digits = String(Math.abs(minor)).padStart(minorUnitExponent + 1, '0');
  if (minorUnitExponent === 0) return `${sign}${digits}`;
  const split = digits.length - minorUnitExponent;
  return `${sign}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function normalizeCurrency(value, expectedCurrency) {
  const currency = String(value || expectedCurrency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new FinanceContractError('INVALID_CURRENCY', 'currency must be a three-letter code');
  }
  return currency;
}

function readAmountMinor(record, minorUnitExponent, majorKey, minorKey) {
  if (Object.prototype.hasOwnProperty.call(record, minorKey)) {
    return parseMinorUnits(record[minorKey]);
  }
  return majorToMinorUnits(record[majorKey], minorUnitExponent);
}

function emptyTotals() {
  return {
    incomeMinor: 0,
    expenseMinor: 0,
    netOperatingMinor: 0,
    ownerContributionMinor: 0,
    ownerDrawMinor: 0,
    salesTaxCollectedMinor: 0,
    salesTaxPaidMinor: 0,
  };
}

function addToTotals(totals, kind, amountMinor) {
  if (kind === 'income') totals.incomeMinor = addSafeMinor(totals.incomeMinor, amountMinor);
  else if (kind === 'expense') totals.expenseMinor = addSafeMinor(totals.expenseMinor, amountMinor);
  else if (kind === 'ownerContribution') {
    totals.ownerContributionMinor = addSafeMinor(totals.ownerContributionMinor, amountMinor);
  } else if (kind === 'ownerDraw') {
    totals.ownerDrawMinor = addSafeMinor(totals.ownerDrawMinor, amountMinor);
  } else if (kind === 'salesTaxCollected') {
    totals.salesTaxCollectedMinor = addSafeMinor(totals.salesTaxCollectedMinor, amountMinor);
  } else if (kind === 'salesTaxPaid') {
    totals.salesTaxPaidMinor = addSafeMinor(totals.salesTaxPaidMinor, amountMinor);
  }
  totals.netOperatingMinor = subtractSafeMinor(totals.incomeMinor, totals.expenseMinor);
}

function addBlocker(blockers, code, detail = {}) {
  blockers.push({ code, ...detail });
}

function normalizeEntry(entry, index, expectedCurrency, minorUnitExponent) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new FinanceContractError('INVALID_ENTRY', 'entry must be an object');
  }
  const id = String(entry.id || '').trim();
  if (!id) throw new FinanceContractError('ENTRY_ID_REQUIRED', 'entry id is required');

  const rawKind = entry.kind || entry.entry_type;
  const kind = ENTRY_KIND_MAP.get(rawKind);
  if (!kind) {
    throw new FinanceContractError(
      'UNSUPPORTED_ENTRY_KIND',
      `entry kind at index ${index} is not part of the canonical contract`,
    );
  }

  const currency = normalizeCurrency(entry.currency, expectedCurrency);
  if (currency !== expectedCurrency) {
    throw new FinanceContractError(
      'CURRENCY_MISMATCH',
      `entry ${id} uses ${currency}; expected ${expectedCurrency}`,
    );
  }

  const authority = AUTHORITY_STATES.has(entry.authority) ? entry.authority : 'unknown';
  const attribution = ATTRIBUTION_STATES.has(entry.attribution)
    ? entry.attribution
    : 'unknown';
  const amountMinor = readAmountMinor(entry, minorUnitExponent, 'amount', 'amountMinor');
  return { id, kind, amountMinor, currency, authority, attribution };
}

function normalizeReconciliation(
  check,
  index,
  expectedCurrency,
  minorUnitExponent,
) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    throw new FinanceContractError(
      'INVALID_RECONCILIATION',
      'reconciliation check must be an object',
    );
  }
  const id = String(check.id || '').trim();
  if (!id) {
    throw new FinanceContractError(
      'RECONCILIATION_ID_REQUIRED',
      `reconciliation check at index ${index} requires an id`,
    );
  }
  const currency = normalizeCurrency(check.currency, expectedCurrency);
  if (currency !== expectedCurrency) {
    throw new FinanceContractError(
      'CURRENCY_MISMATCH',
      `reconciliation ${id} uses ${currency}; expected ${expectedCurrency}`,
    );
  }

  if (check.evidenceStatus !== 'available') {
    return {
      id,
      currency,
      status: 'unavailable',
      authoritativeMinor: null,
      ledgerMinor: null,
      differenceMinor: null,
      absoluteDifferenceMinor: null,
    };
  }

  const authoritativeMinor = readAmountMinor(
    check,
    minorUnitExponent,
    'authoritativeAmount',
    'authoritativeAmountMinor',
  );
  const ledgerMinor = readAmountMinor(
    check,
    minorUnitExponent,
    'ledgerAmount',
    'ledgerAmountMinor',
  );
  const differenceMinor = subtractSafeMinor(ledgerMinor, authoritativeMinor);
  return {
    id,
    currency,
    status: differenceMinor === 0 ? 'matched' : 'different',
    authoritativeMinor,
    ledgerMinor,
    differenceMinor,
    absoluteDifferenceMinor: Math.abs(differenceMinor),
  };
}

/**
 * Produce a fail-closed finance result suitable for an outcome contract.
 *
 * The result never labels a period verified unless:
 * - every ledger input is valid, authoritative, and attributed;
 * - at least one reconciliation check has available evidence; and
 * - every reconciliation difference is exactly zero minor units.
 */
function calculateCanonicalFinance({
  currency = 'USD',
  minorUnitExponent = 2,
  entries = [],
  reconciliations = [],
  zeroActivityAttested = false,
} = {}) {
  assertMinorUnitExponent(minorUnitExponent);
  const expectedCurrency = normalizeCurrency(currency);
  if (!Array.isArray(entries) || !Array.isArray(reconciliations)) {
    throw new FinanceContractError(
      'INVALID_COLLECTION',
      'entries and reconciliations must be arrays',
    );
  }

  const blockers = [];
  const validEntries = [];
  const invalidEntries = [];
  const seenEntryIds = new Set();
  if (entries.length === 0 && zeroActivityAttested !== true) {
    addBlocker(blockers, 'LEDGER_EVIDENCE_MISSING');
  }

  entries.forEach((entry, index) => {
    try {
      const normalized = normalizeEntry(entry, index, expectedCurrency, minorUnitExponent);
      if (seenEntryIds.has(normalized.id)) {
        addBlocker(blockers, 'DUPLICATE_ENTRY_ID', { entryId: normalized.id });
        return;
      }
      seenEntryIds.add(normalized.id);
      validEntries.push(normalized);
    } catch (error) {
      const code = error instanceof FinanceContractError ? error.code : 'INVALID_ENTRY';
      invalidEntries.push({
        index,
        id: entry && entry.id ? String(entry.id) : null,
        code,
      });
      addBlocker(blockers, code, {
        entryId: entry && entry.id ? String(entry.id) : null,
      });
    }
  });

  const ledger = emptyTotals();
  const authoritative = emptyTotals();
  const unattributed = emptyTotals();
  const unverified = emptyTotals();
  const attributionUnknown = emptyTotals();

  for (const entry of validEntries) {
    addToTotals(ledger, entry.kind, entry.amountMinor);
    if (entry.authority === 'authoritative') {
      addToTotals(authoritative, entry.kind, entry.amountMinor);
    } else {
      addToTotals(unverified, entry.kind, entry.amountMinor);
      addBlocker(blockers, 'NON_AUTHORITATIVE_AMOUNT', {
        entryId: entry.id,
        authority: entry.authority,
      });
    }

    if (entry.attribution === 'unattributed') {
      addToTotals(unattributed, entry.kind, entry.amountMinor);
      addBlocker(blockers, 'UNATTRIBUTED_AMOUNT', { entryId: entry.id });
    } else if (entry.attribution === 'unknown') {
      addToTotals(attributionUnknown, entry.kind, entry.amountMinor);
      addBlocker(blockers, 'ATTRIBUTION_UNKNOWN', { entryId: entry.id });
    }
  }

  const checks = [];
  const seenCheckIds = new Set();
  if (reconciliations.length === 0) {
    addBlocker(blockers, 'RECONCILIATION_EVIDENCE_MISSING');
  }

  reconciliations.forEach((check, index) => {
    try {
      const normalized = normalizeReconciliation(
        check,
        index,
        expectedCurrency,
        minorUnitExponent,
      );
      if (seenCheckIds.has(normalized.id)) {
        addBlocker(blockers, 'DUPLICATE_RECONCILIATION_ID', {
          reconciliationId: normalized.id,
        });
        return;
      }
      seenCheckIds.add(normalized.id);
      checks.push(normalized);
      if (normalized.status === 'unavailable') {
        addBlocker(blockers, 'RECONCILIATION_UNAVAILABLE', {
          reconciliationId: normalized.id,
        });
      } else if (normalized.status === 'different') {
        addBlocker(blockers, 'RECONCILIATION_DIFFERENCE', {
          reconciliationId: normalized.id,
          differenceMinor: normalized.differenceMinor,
        });
      }
    } catch (error) {
      const code = error instanceof FinanceContractError
        ? error.code
        : 'INVALID_RECONCILIATION';
      checks.push({
        id: check && check.id ? String(check.id) : null,
        status: 'invalid',
        authoritativeMinor: null,
        ledgerMinor: null,
        differenceMinor: null,
        absoluteDifferenceMinor: null,
        errorCode: code,
      });
      addBlocker(blockers, code, {
        reconciliationId: check && check.id ? String(check.id) : null,
      });
    }
  });

  const allDifferencesKnown = checks.length > 0
    && checks.every((check) => Number.isSafeInteger(check.absoluteDifferenceMinor));
  const knownUnreconciledMinor = checks.reduce((sum, check) => (
    addSafeMinor(
      sum,
      Number.isSafeInteger(check.absoluteDifferenceMinor)
        ? check.absoluteDifferenceMinor
        : 0,
    )
  ), 0);
  const canClose = blockers.length === 0;

  return {
    contractVersion: 1,
    currency: expectedCurrency,
    minorUnitExponent,
    entryCounts: {
      received: entries.length,
      valid: validEntries.length,
      invalid: invalidEntries.length,
      authoritative: validEntries.filter((entry) => entry.authority === 'authoritative').length,
      unattributed: validEntries.filter((entry) => entry.attribution === 'unattributed').length,
      unverified: validEntries.filter((entry) => entry.authority !== 'authoritative').length,
    },
    amounts: {
      ledger,
      authoritative,
      unattributed,
      unverified,
      attributionUnknown,
    },
    invalidEntries,
    reconciliation: {
      checks,
      complete: allDifferencesKnown,
      knownUnreconciledMinor,
      unreconciledMinor: allDifferencesKnown ? knownUnreconciledMinor : null,
    },
    controls: {
      canClose,
      canSignOff: canClose,
      blockers,
    },
    health: {
      state: canClose ? 'verified' : 'blocked',
      isGreen: canClose,
    },
  };
}

module.exports = {
  FinanceContractError,
  ENTRY_KIND_MAP,
  AUTHORITY_STATES,
  ATTRIBUTION_STATES,
  majorToMinorUnits,
  parseMinorUnits,
  minorUnitsToDecimal,
  calculateCanonicalFinance,
};
