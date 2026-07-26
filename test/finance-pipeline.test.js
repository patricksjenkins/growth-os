/**
 * The finance truth pipeline, after the 2026-07-26 Codex audit.
 *
 * Every test here pins a defect that was real in production, not a
 * hypothetical: events silently destroyed, revenue that never booked,
 * bank payouts double-counted as income, and an invoice scanner that
 * could not read an invoice sitting in an email body.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const SERVER = read('api', 'server.js');
const INBOX = read('integrations', 'stripe-inbox.js');
const STRIPE = read('integrations', 'stripe.js');
const SYNC = read('integrations', 'finance-sync.js');
const MERCURY = read('worker', 'agents', 'mercury-sync.js');
const CRON = read('worker', 'scheduler', 'cron.js');

/* ── Durable event inbox ── */

test('a failed webhook returns 500 so Stripe retries, not 200', () => {
  // THE BUG: the route answered 200 to every handler result, including
  // {status:'error'}. Stripe marks 200 delivered and stops retrying.
  assert.match(SERVER, /if \(outcome\.retryable\)/);
  assert.match(SERVER, /res\.status\(500\)/, 'a retryable failure must not answer 200');
  assert.match(SERVER, /handleWebhookDurable/, 'route must go through the inbox');
});

test('the event is stored BEFORE it is processed', () => {
  const store = INBOX.indexOf("from('stripe_events')");
  const process = INBOX.indexOf("require('./stripe')");
  assert.ok(store > 0 && process > 0 && store < process,
    'arrival must be durable before any handler runs — otherwise a crash destroys the event');
});

test('an inbox write failure refuses to process', () => {
  assert.match(INBOX, /inbox write failed/,
    'processing without a record is the exact condition that hid the original loss');
});

test('a redelivered event is not reprocessed', () => {
  assert.match(INBOX, /already processed — acknowledging without reprocessing/);
});

test('orphans do not trigger infinite retries', () => {
  const { RETRYABLE } = require('../integrations/stripe-inbox');
  assert.ok(RETRYABLE.has('rejected'), 'our failures should retry');
  assert.ok(!RETRYABLE.has('orphaned'), 'a missing customer link is fixed by a human, not by retrying');
  assert.ok(!RETRYABLE.has('ignored'));
});

test('classify maps handler results to inbox states', () => {
  const { classify } = require('../integrations/stripe-inbox');
  assert.strictEqual(classify({ status: 'error' }), 'rejected');
  assert.strictEqual(classify({ status: 'orphaned' }), 'orphaned');
  // A closed period needs an owner decision, not a redelivery (round 4).
  assert.strictEqual(classify({ status: 'period_locked' }), 'blocked');
  assert.strictEqual(classify({ action: 'ignored' }), 'ignored');
  assert.strictEqual(classify({ action: 'invoice_recorded' }), 'processed');
});

/* ── Full revenue event coverage ── */

test('checkout payments book income (setup fees used to vanish)', () => {
  assert.match(STRIPE, /recordStripeCheckoutPayment/,
    'checkout.session.completed only onboarded; a setup fee produced no revenue row');
  assert.match(SYNC, /subscription checkout books via invoice\.paid/,
    'subscription checkouts must be skipped to avoid double-counting');
});

test('refunds reduce revenue and disputes escalate', () => {
  assert.match(STRIPE, /case 'charge\.refunded'/);
  assert.match(STRIPE, /case 'charge\.dispute\.created'/);
  assert.match(SYNC, /amount: -Math\.abs\(refunded\)/, 'a refund is negative revenue, not an expense');
  assert.match(SYNC, /stripe_dispute/, 'a dispute must reach the owner before the evidence window closes');
});

test('every money handler books to FGA, never the client', () => {
  for (const fn of ['recordStripeCheckoutPayment', 'recordStripeRefund']) {
    const body = SYNC.slice(SYNC.indexOf(`async function ${fn}`), SYNC.indexOf(`async function ${fn}`) + 3000);
    assert.match(body, /tenant_id: FGA_TENANT_ID/, `${fn} must book to FGA's ledger`);
    assert.match(body, /customer_tenant_id/, `${fn} must still attribute the client`);
  }
});

/* ── Mercury demoted to settlement, not revenue ── */

test('Stripe payouts are settlements by DEFAULT, not income', () => {
  assert.match(MERCURY, /STRIPE_REVENUE_AUTHORITATIVE !== 'false'/,
    'default must be Stripe-authoritative; booking a payout as income double-counts revenue');
});

test('a failed Mercury sync cannot report success', () => {
  assert.match(MERCURY, /syncError = err\.message/);
  assert.match(MERCURY, /success: false/, 'a broken bank feed must not look like a quiet day');
  assert.match(MERCURY, /business_outcome_state: 'not_achieved'/);
});

/* ── Gmail: read the email, not just its attachments ── */

test('the scan no longer requires an attachment', () => {
  const { buildInvoiceQuery } = require('../core/gmail-invoice-scan');
  const q = buildInvoiceQuery(14);
  assert.ok(!q.includes('has:attachment'),
    'body-only receipts (Vercel, Anthropic, Google) were invisible to the scanner');
  assert.ok(buildInvoiceQuery(14, { attachmentsOnly: true }).includes('has:attachment'),
    'the attachment-only mode should still be expressible');
});

test('it extracts vendor, amount and date from a real receipt body', () => {
  const { extractInvoiceFromText } = require('../core/gmail-invoice-scan');
  const r = extractInvoiceFromText(
    'Thanks for your payment. Amount charged: $20.00\nInvoice date: July 4, 2026',
    { fromAddress: 'billing@vercel.com' });
  assert.strictEqual(r.total_amount, 20);
  assert.strictEqual(r.vendor_name, 'Vercel');
  assert.strictEqual(r.invoice_date, '2026-07-04');
  assert.strictEqual(r.confidence, 'high');
});

test('an unreadable body reports nothing rather than guessing', () => {
  const { extractInvoiceFromText } = require('../core/gmail-invoice-scan');
  const r = extractInvoiceFromText('Your account has been updated.', { fromAddress: 'x@y.com' });
  assert.strictEqual(r.total_amount, null, 'no amount must mean no amount, not a fabricated one');
});

test('incomplete extraction is an exception, never "extracted"', () => {
  const SCAN = read('core', 'gmail-invoice-scan.js');
  assert.match(SCAN, /extraction_status: complete \? 'extracted' : 'partial'/,
    '18 of 23 rows claimed "extracted" with no usable amount, vendor or date');
  assert.match(SCAN, /review_status: 'pending'/, 'the scanner proposes; the owner disposes');
  assert.match(SCAN, /stats\.incomplete\+\+/);
});

test('Gmail results are paginated and truncation is admitted', () => {
  const SCAN = read('core', 'gmail-invoice-scan.js');
  assert.match(SCAN, /nextPageToken/, 'a single 50-row page silently cut off busy months');
  assert.match(SCAN, /stats\.truncated = truncated/, 'hitting the ceiling must be reported, not hidden');
});

test('the scan runs daily, not weekly', () => {
  assert.match(CRON, /agent: 'invoice-scan',\s+cron: '0 7 \* \* \*'/,
    'a weekly scan means up to 7 days of blind spots');
});

/* ── Credit card: the payment is a transfer, not an expense ──
 *
 * Patrick 2026-07-26: "The fees like Vercel are charged to the company Amex.
 * So it shows as an individual expense and then the payment to Amex."
 * Booking both deducts the same dollar twice — and double-counted expenses
 * understate profit, i.e. claiming a deduction twice.
 */

test('a payment to a card issuer is classified as a transfer', () => {
  assert.match(MERCURY, /_isCardPayment/);
  assert.match(MERCURY, /cardLiabilitySettlement\s*\?\s*'transfer'/,
    'the card payment settles a liability; the vendor charge is the expense');
  assert.match(MERCURY, /american express\|amex/i);
});

test('card payments are tagged so the reconciler can find them', () => {
  assert.match(MERCURY, /kind: cardLiabilitySettlement \? 'card_payment'/);
});

test('missing card receipts are detected — the other half of the fix', () => {
  // Once card payments are transfers, receipts are the ONLY path for a
  // card-charged expense. A missed receipt becomes a LOST DEDUCTION, so the
  // reclassification is only safe with this detector beside it.
  const REC = read('core', 'finance', 'reconciliation.js');
  assert.match(REC, /cardCoverage/);
  assert.match(REC, /likely_missing_receipts/);
  assert.match(REC, /lost deductions/);
  const HEAD = read('worker', 'agents', 'finance-head.js');
  assert.match(HEAD, /card_receipts_missing/, 'the Finance Head must own this finding');
});

test('coverage only flags a SHORTFALL, not vendor spend above card payments', () => {
  const REC = read('core', 'finance', 'reconciliation.js');
  assert.match(REC, /ratio < 0\.9/,
    'bank-paid vendors legitimately exceed card payments — only a shortfall is a signal');
});

/* ── Codex round 2: defects found in my own fixes ── */

test('P0: a NESTED failure is classified as a failure', () => {
  // invoice.paid returns its bookkeeping verdict under `sync`. classify() only
  // read the top level, so a database failure while recording a real payment
  // scored 'processed' and answered 200 — Stripe would never retry it. The
  // exact defect the inbox was built to prevent, one level down.
  const { classify } = require('../integrations/stripe-inbox');
  assert.strictEqual(classify({ action: 'invoice_paid', sync: { status: 'error' } }), 'rejected');
  assert.strictEqual(classify({ action: 'invoice_paid', sync: { status: 'orphaned' } }), 'orphaned');
  assert.strictEqual(classify({ action: 'invoice_paid', sync: { status: 'period_locked' } }), 'blocked');
  assert.strictEqual(classify({ action: 'invoice_paid', sync: { status: 'created' } }), 'processed');
  // Checkout carries its outcome under `booking`.
  assert.strictEqual(classify({ action: 'checkout_completed', booking: { status: 'error' } }), 'rejected');
});

/*
 * The two source-slicing fee tests that lived here were deleted in round 4.
 *
 * They asserted on SUBSTRINGS of finance-sync.js (`SYNC.slice(...)` + regex),
 * so extracting the fee logic into ensureFeeBooked() — a pure refactor that
 * changed no behaviour — broke them, while the far more serious defects they
 * were supposed to guard (the feeError ReferenceError, and the retry that
 * never re-attempted the fee) sailed straight past them.
 *
 * The same guarantees are now asserted by EXECUTING the code, in
 * test/finance-behavioral.test.js:
 *   - 'income and fee both book to FGA, and the fee does not reuse the invoice id'
 *   - 'a retry repairs a fee that a previous attempt failed to book'
 *   - 'a third delivery is a no-op — the repair is idempotent'
 */

test('a fee that fails to book makes the whole event retryable', () => {
  assert.match(SYNC, /fee booking failed/, 'booked gross with a missing fee overstates profit');
});

test('checkout booking failures reach the classifier instead of being logged away', () => {
  assert.match(STRIPE, /checkoutBooking = \{ status: 'error'/);
  assert.match(STRIPE, /booking: checkoutBooking/);
});

/* ── Metrics that were confidently wrong ── */

test('provider-backed counts Mercury rows (key was misspelled)', () => {
  const REC = read('core', 'finance', 'reconciliation.js');
  assert.match(REC, /m\.mercury_txn_id/,
    'Mercury writes mercury_txn_id; the guessed mercury_transaction_id excluded every Mercury row');
});

test('row provenance is reported, so nothing is miscalled "typed by hand"', () => {
  const REC = read('core', 'finance', 'reconciliation.js');
  assert.match(REC, /bySource/, 'rows arrive via expense_tracker and mercury, not only manually');
});

test('freshness measures the CONNECTOR running, not new rows appearing', () => {
  const REC = read('core', 'finance', 'reconciliation.js');
  assert.match(REC, /lastRun\('mercury-sync'\)/,
    'a connector that ran fine and found nothing new was being labelled stale');
  assert.match(REC, /lastRun\('invoice-scan'\)/);
});

test('the cash figure admits it is an indicator, not a reconciliation', () => {
  const REC = read('core', 'finance', 'reconciliation.js');
  assert.match(REC, /is_accounting_reconciliation: false/);
  assert.match(REC, /reconciled: null/, 'null = not assessed, distinct from assessed-and-off');
  assert.match(REC, /opening balance/, 'the caveat must name what it excludes');
});

/* ── Remaining false greens ── */

test('the Finance Head fails when it cannot record a finding', () => {
  const HEAD = read('worker', 'agents', 'finance-head.js');
  assert.match(HEAD, /success: writeFailures\.length === 0/,
    'a head that could not record what it found has not done its job');
});

test('body-only receipts count as imports and trigger the owner alert', () => {
  const SCAN = read('core', 'gmail-invoice-scan.js');
  assert.match(SCAN, /imported: acc\.imported \+ m\.imported \+ \(m\.body_drafts \|\| 0\)/,
    'body drafts were created silently — the alert only fired on attachment imports');
  assert.match(SCAN, /body_imported/);
});

test('a truncated or budget-exhausted scan does not report success', () => {
  const AGENT = read('worker', 'agents', 'invoice-scan.js');
  assert.match(AGENT, /success: !incompleteScan/);
  assert.match(AGENT, /Receipts may be unseen/);
});
