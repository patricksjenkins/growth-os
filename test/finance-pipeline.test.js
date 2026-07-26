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
  assert.strictEqual(classify({ status: 'period_locked' }), 'rejected');
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
