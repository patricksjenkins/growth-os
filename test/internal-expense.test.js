/**
 * Unit tests for the Internal Expense Tracker pure logic.
 * Run: npm test   (node --test)
 *
 * Covers: AI-draft sanitization, malformed-AI handling, approval validation,
 * and duplicate-fingerprint generation. No network / DB — pure functions only.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeDraft, emptyDraft, CATEGORIES } = require('../core/internal-expense-extractor');
const {
  buildDedupeKey,
  validateForApproval,
  isLowConfidence,
  toNullableDate,
  toNullableAmount,
  normalizeConfidence,
} = require('../core/internal-expense-validation');

// ---- sanitizeDraft -------------------------------------------------------

test('sanitizeDraft: parses a clean invoice object', () => {
  const d = sanitizeDraft({
    vendor_name: 'Anthropic, PBC',
    document_type: 'invoice',
    document_number: 'XTEVJD2D-0005',
    expense_date: '2026-05-30',
    due_date: '2026-05-30',
    currency: 'usd',
    subtotal_amount: 100,
    tax_amount: 0,
    total_amount: 100,
    payment_status: 'unpaid',
    category: 'AI/API Usage',
    expense_type: 'Software subscription',
    recurring: true,
    recurrence_frequency: 'monthly',
    line_items: [{ description: 'Max plan - 5x', quantity: 1, unit_price: 100, amount: 100 }],
    confidence: 0.91,
  });
  assert.equal(d.vendor_name, 'Anthropic, PBC');
  assert.equal(d.document_type, 'invoice');
  assert.equal(d.currency, 'USD');               // normalized upper-case
  assert.equal(d.total_amount, 100);
  assert.equal(d.category, 'AI/API Usage');
  assert.equal(d.recurring, true);
  assert.equal(d.recurrence_frequency, 'monthly');
  assert.equal(d.line_items.length, 1);
  assert.equal(d.confidence, 0.91);
});

test('sanitizeDraft: coerces messy/string amounts and bad enums', () => {
  const d = sanitizeDraft({
    vendor_name: 42,                       // non-string -> null
    document_type: 'banana',               // invalid -> unknown
    expense_date: '05/30/2026',            // wrong format -> null
    currency: undefined,                   // -> default USD
    total_amount: '$1,234.56',             // messy string -> number
    payment_status: 'maybe',               // invalid -> unknown
    category: 'Not A Category',            // invalid -> Other
    expense_type: 'nope',                  // invalid -> Operating expense
    confidence: '2',                       // clamps to 1
  });
  assert.equal(d.vendor_name, null);
  assert.equal(d.document_type, 'unknown');
  assert.equal(d.expense_date, null);
  assert.equal(d.currency, 'USD');
  assert.equal(d.total_amount, 1234.56);
  assert.equal(d.payment_status, 'unknown');
  assert.equal(d.category, 'Other');
  assert.equal(d.expense_type, 'Operating expense');
  assert.equal(d.confidence, 1);
});

test('sanitizeDraft: tolerates null / garbage input without throwing', () => {
  assert.doesNotThrow(() => sanitizeDraft(null));
  assert.doesNotThrow(() => sanitizeDraft('not an object'));
  const d = sanitizeDraft(undefined);
  assert.equal(d.category, 'Other');
  assert.equal(d.confidence, 0.5);          // default mid confidence
});

test('emptyDraft: confidence 0, unknown doc type', () => {
  const d = emptyDraft();
  assert.equal(d.confidence, 0);
  assert.equal(d.document_type, 'unknown');
  assert.ok(CATEGORIES.includes(d.category));
});

// ---- validateForApproval -------------------------------------------------

test('validateForApproval: passes a complete expense', () => {
  const { ok, errors } = validateForApproval({
    vendor_name: 'Anthropic',
    total_amount: 100,
    expense_date: '2026-05-30',
  });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test('validateForApproval: flags missing vendor / total / date', () => {
  const { ok, errors } = validateForApproval({ vendor_name: '', total_amount: null, expense_date: null });
  assert.equal(ok, false);
  assert.equal(errors.length, 3);
});

test('validateForApproval: rejects non-numeric and future dates', () => {
  const bad = validateForApproval({ vendor_name: 'X', total_amount: 'abc', expense_date: '2099-01-01' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /number/i.test(e)));
  assert.ok(bad.errors.some((e) => /future/i.test(e)));
});

test('validateForApproval: line items must roughly sum to subtotal/total', () => {
  const mismatch = validateForApproval({
    vendor_name: 'X', total_amount: 100, expense_date: '2026-05-30',
    subtotal_amount: 100,
    line_items: [{ amount: 40 }, { amount: 20 }],   // sums to 60, not 100
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some((e) => /line items/i.test(e)));

  const ok = validateForApproval({
    vendor_name: 'X', total_amount: 100, expense_date: '2026-05-30',
    subtotal_amount: 100,
    line_items: [{ amount: 60 }, { amount: 40 }],   // sums to 100
  });
  assert.equal(ok.ok, true);
});

// ---- buildDedupeKey ------------------------------------------------------

test('buildDedupeKey: identical invoices produce identical keys', () => {
  const a = buildDedupeKey({ vendor_name: 'Anthropic, PBC', document_number: 'XTEVJD2D-0005', expense_date: '2026-05-30', total_amount: 100 });
  const b = buildDedupeKey({ vendor_name: 'anthropic, pbc', document_number: 'xtevjd2d-0005', expense_date: '2026-05-30', total_amount: 100.0 });
  assert.equal(a, b);
});

test('buildDedupeKey: different totals produce different keys', () => {
  const a = buildDedupeKey({ vendor_name: 'X', document_number: '1', expense_date: '2026-05-30', total_amount: 100 });
  const b = buildDedupeKey({ vendor_name: 'X', document_number: '1', expense_date: '2026-05-30', total_amount: 200 });
  assert.notEqual(a, b);
});

test('buildDedupeKey: empty record yields null', () => {
  assert.equal(buildDedupeKey({}), null);
});

// ---- isLowConfidence -----------------------------------------------------

test('isLowConfidence: flags < 0.6', () => {
  assert.equal(isLowConfidence(0.4), true);
  assert.equal(isLowConfidence(0.6), false);
  assert.equal(isLowConfidence(0.91), false);
});

// ---- boundary sanitizers (DB-safe coercion) ------------------------------

test('toNullableDate: passes valid calendar dates', () => {
  assert.equal(toNullableDate('2026-05-30'), '2026-05-30');
  assert.equal(toNullableDate(' 2026-05-30 '), '2026-05-30');
});

test('toNullableDate: nulls empty/invalid/calendar-impossible dates', () => {
  assert.equal(toNullableDate(''), null);
  assert.equal(toNullableDate('N/A'), null);
  assert.equal(toNullableDate('2026-13-45'), null); // format ok, calendar invalid
  assert.equal(toNullableDate('2026-02-30'), null); // rolls over
  assert.equal(toNullableDate(null), null);
  assert.equal(toNullableDate(undefined), null);
});

test('toNullableAmount: strips currency symbols and commas', () => {
  assert.equal(toNullableAmount('$1,234.00'), 1234);
  assert.equal(toNullableAmount('1234.5'), 1234.5);
  assert.equal(toNullableAmount(99.99), 99.99);
});

test('toNullableAmount: nulls empty/non-numeric', () => {
  assert.equal(toNullableAmount(''), null);
  assert.equal(toNullableAmount('N/A'), null);
  assert.equal(toNullableAmount('-'), null);
  assert.equal(toNullableAmount(null), null);
});

test('normalizeConfidence: keeps 0-1, rescales 0-100, clamps overflow', () => {
  assert.equal(normalizeConfidence(0.92), 0.92);
  assert.equal(normalizeConfidence(85), 0.85);   // 0-100 scale -> 0.85
  assert.equal(normalizeConfidence(999), 0.999); // never overflows NUMERIC(4,3)
  assert.equal(normalizeConfidence(-1), 0);
  assert.equal(normalizeConfidence('nope'), null);
});

test('deepStripNullBytes: removes NUL from strings, arrays, and nested objects', () => {
  const { deepStripNullBytes } = require('../core/internal-expense-validation');
  assert.equal(deepStripNullBytes('a\u0000b'), 'ab');
  assert.deepEqual(deepStripNullBytes(['x\u0000', 'y']), ['x', 'y']);
  assert.deepEqual(
    deepStripNullBytes({ ocr_text: 'no\u0000ise', line_items: [{ description: 'wid\u0000get', amount: 5 }] }),
    { ocr_text: 'noise', line_items: [{ description: 'widget', amount: 5 }] },
  );
  assert.equal(deepStripNullBytes(42), 42);
  assert.equal(deepStripNullBytes(null), null);
});
