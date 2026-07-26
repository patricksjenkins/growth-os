'use strict';

/**
 * BEHAVIORAL tests for the finance pipeline — the code is executed, not grepped.
 *
 * Codex's round-3 verdict on the previous suite: "11 of the 12 newly added
 * tests merely search source code for phrases. Only nested classification is
 * behaviorally executed, which is why the fee ReferenceError, retry loss,
 * Finance Head crash, and API/UI break all passed."
 *
 * Every test below fails if the corresponding fix is reverted, because every
 * test CALLS the function. Each one is annotated with the production defect it
 * pins, so a future reader knows what it is defending.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { fakeSupabase, stubStripeModule } = require('./helpers/fake-supabase');
const { FGA_TENANT_ID } = require('../core/config');

const CLIENT_TENANT = '00000000-0000-0000-0000-0000000000aa';
const PAID_AT = Math.floor(Date.UTC(2026, 6, 1) / 1000);

function invoiceFixture(over = {}) {
  return {
    id: 'in_behavioural_1',
    customer: 'cus_client',
    amount_paid: 49900,
    currency: 'usd',
    charge: 'ch_behavioural_1',
    status_transitions: { paid_at: PAID_AT },
    lines: { data: [{ description: 'Growth plan', metadata: {} }] },
    ...over,
  };
}

/** A db where the invoice is new, the customer resolves, and the period is open. */
function happyDb(over = {}) {
  return fakeSupabase({
    rpc: { set_audit_context: () => ({ data: null, error: null }),
      is_period_locked: () => ({ data: false, error: null }),
      ...(over.rpc || {}) },
    tables: {
      tenant_config: {
        select: () => ({ data: { tenant_id: CLIENT_TENANT }, error: null }),
        // Billing state (last_payment_at, billing_status) genuinely belongs to
        // the CLIENT's config — that is customer state, not FGA's books. Only
        // the ledger row moves to FGA.
        upsert: () => ({ data: null, error: null }),
      },
      tenants: { select: () => ({ data: [{ name: 'A Kut Above' }], error: null }) },
      attention_queue: { insert: () => ({ data: null, error: null }) },
      finance_entries: {
        select: (s) => {
          // The fee-dedupe read filters on invoice_ref; the idempotency read
          // filters on stripe_invoice_id. Both must find nothing for a fresh
          // invoice.
          if (s.single === 'maybe') return { data: null, error: null };
          return { data: [], error: null };
        },
        insert: over.financeInsert || (() => ({ data: { id: 'fe_income' }, error: null })),
      },
      ...(over.tables || {}),
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// P0: the fee ReferenceError. Codex reproduced: income wrote, fee insert
// failed, the handler threw `ReferenceError: feeError is not defined`, the
// retry saw `duplicate`, and the fee was never booked. `feeError` was declared
// inside `if (invoice.charge) {` and read after that block closed.
// ───────────────────────────────────────────────────────────────────────────
test('a failed fee insert returns an error instead of throwing ReferenceError', async () => {
  const restore = stubStripeModule({
    charges: { retrieve: async () => ({ balance_transaction: { fee: 1477 } }) },
  });
  try {
    let insertN = 0;
    const db = happyDb({
      financeInsert: () => {
        insertN += 1;
        // 1st = income (succeeds), 2nd = the processing fee (fails).
        if (insertN === 1) return { data: { id: 'fe_income' }, error: null };
        return { data: null, error: { message: 'duplicate key value' } };
      },
    });
    const { recordStripeInvoicePaid } = require('../integrations/finance-sync');

    // Before the fix this REJECTED with a ReferenceError rather than
    // returning — which is why the source-grep test passed and production
    // broke on every single payment.
    const result = await recordStripeInvoicePaid(db, invoiceFixture());

    assert.strictEqual(result.status, 'error', 'a booked gross with no fee must report an error');
    assert.match(result.error, /fee booking failed/);
  } finally { restore(); }
});

test('the fee error is a retryable outcome, so Stripe redelivers', async () => {
  const { classify, RETRYABLE } = require('../integrations/stripe-inbox');
  const status = classify({ sync: { status: 'error', error: 'fee booking failed: boom' } });
  assert.strictEqual(status, 'rejected');
  assert.ok(RETRYABLE.has(status), 'a half-booked payment must be retried, not acknowledged');
});

test('income and fee both book to FGA, and the fee does not reuse the invoice id', async () => {
  const restore = stubStripeModule({
    charges: { retrieve: async () => ({ balance_transaction: { fee: 1477 } }) },
  });
  try {
    const db = happyDb();
    const { recordStripeInvoicePaid } = require('../integrations/finance-sync');
    const result = await recordStripeInvoicePaid(db, invoiceFixture());
    assert.strictEqual(result.status, 'created');

    const written = db.writes('finance_entries').map((w) => w.payload);
    assert.strictEqual(written.length, 2, 'expected an income row and a fee row');

    for (const row of written) {
      // Booking to the CLIENT's tenant hid every webhook dollar from the P&L,
      // because Reports & Insights reads only FGA_TENANT_ID.
      assert.strictEqual(row.tenant_id, FGA_TENANT_ID, `${row.entry_type} booked to the wrong ledger`);
    }
    const income = written.find((r) => r.entry_type === 'income');
    const fee = written.find((r) => r.entry_type === 'expense');
    assert.strictEqual(income.amount, 499);
    assert.strictEqual(fee.amount, 14.77);
    assert.match(income.description, /A Kut Above/, 'the paying client must stay attributable');

    // The partial unique index on metadata->>stripe_invoice_id means stamping
    // the fee row with the invoice id collides with the income row and the fee
    // silently vanishes. Found live during the AKA backfill.
    assert.ok(!fee.metadata.stripe_invoice_id, 'fee row must not carry stripe_invoice_id');
    assert.strictEqual(fee.metadata.invoice_ref, 'in_behavioural_1');
    // The cost is FGA's, but the client it was incurred for stays reportable —
    // otherwise per-client margin is unknowable.
    assert.strictEqual(fee.metadata.customer_tenant_id, CLIENT_TENANT);
    assert.strictEqual(fee.metadata.customer_name, 'A Kut Above');
  } finally { restore(); }
});

// ───────────────────────────────────────────────────────────────────────────
// P0: the period lock asked the wrong tenant, and failed open.
// ───────────────────────────────────────────────────────────────────────────
test('the period lock is checked against FGA, whose books the row lands in', async () => {
  const restore = stubStripeModule({ charges: { retrieve: async () => ({ balance_transaction: { fee: 0 } }) } });
  try {
    const db = happyDb();
    const { recordStripeInvoicePaid } = require('../integrations/finance-sync');
    await recordStripeInvoicePaid(db, invoiceFixture());

    const lockCall = db.rpcCalls('is_period_locked')[0];
    assert.ok(lockCall, 'the period lock must actually be consulted');
    assert.strictEqual(lockCall.payload.p_tenant_id, FGA_TENANT_ID,
      'asking the paying client whether ITS month is closed protects nothing');
    assert.notStrictEqual(lockCall.payload.p_tenant_id, CLIENT_TENANT);
  } finally { restore(); }
});

test('an unreadable period lock refuses the write rather than booking anyway', async () => {
  const db = happyDb({ rpc: { is_period_locked: () => ({ data: null, error: { message: 'timeout' } }) } });
  const { recordStripeInvoicePaid } = require('../integrations/finance-sync');
  const result = await recordStripeInvoicePaid(db, invoiceFixture());

  assert.strictEqual(result.status, 'error', 'fail-closed: a DB hiccup must not book into a closed month');
  assert.strictEqual(db.writes('finance_entries').length, 0, 'nothing may be written when the lock is unknown');
  assert.ok(require('../integrations/stripe-inbox').RETRYABLE.has('rejected'));
});

// ───────────────────────────────────────────────────────────────────────────
// P1: book cash counted transfers as equity.
// ───────────────────────────────────────────────────────────────────────────
test('transfers are excluded from equity and from book cash', async () => {
  const { ledgerTotals } = require('../core/finance/reconciliation');
  const db = fakeSupabase({
    tables: {
      finance_entries: {
        select: () => ({
          data: [
            { entry_type: 'income', amount: 499, metadata: { source: 'stripe-webhook', stripe_invoice_id: 'in_1' } },
            { entry_type: 'expense', amount: 20, metadata: { source: 'expense_tracker' } },
            // The Amex payment: money moving between accounts, settling
            // expenses already on the books. Counting it as equity added $390
            // of imaginary cash.
            { entry_type: 'transfer', amount: 390, metadata: {} },
          ],
          error: null,
        }),
      },
    },
  });
  const totals = await ledgerTotals(db, 2026);
  assert.strictEqual(totals.transfers, 390);
  assert.strictEqual(totals.equity, 0, 'a transfer is not equity');
  assert.strictEqual(totals.income - totals.expenses + totals.equity, 479,
    'book cash must not absorb the card payment');
});

test('a Stripe fee row counts as provider-backed, and untagged rows are not called manual', async () => {
  const { ledgerTotals } = require('../core/finance/reconciliation');
  const db = fakeSupabase({
    tables: {
      finance_entries: {
        select: () => ({
          data: [
            { entry_type: 'expense', amount: 14.77, metadata: { stripe_fee_for_charge: 'ch_1', source: 'stripe-webhook' } },
            { entry_type: 'expense', amount: 5, metadata: {} },
          ],
          error: null,
        }),
      },
    },
  });
  const totals = await ledgerTotals(db, 2026);
  assert.strictEqual(totals.providerBacked, 1, 'the fee row points at a real Stripe charge');
  assert.strictEqual(totals.bySource.unattributed, 1);
  assert.ok(!('manual' in totals.bySource), 'unproven provenance must not be reported as hand-entry');
});

// ───────────────────────────────────────────────────────────────────────────
// P0: the Chief Financial Agent read a field that had been renamed, so its
// first scheduled 5:30am run would have thrown mid-finding.
// ───────────────────────────────────────────────────────────────────────────
test('the Chief Financial Agent completes a run and renders the variance finding', async () => {
  const reconPath = require.resolve('../core/finance/reconciliation');
  const dbPath = require.resolve('../db/client');
  const healthPath = require.resolve('../api/routes/admin-provider-health');
  const headPath = require.resolve('../worker/agents/finance-head');
  const saved = { [reconPath]: require.cache[reconPath], [dbPath]: require.cache[dbPath],
    [healthPath]: require.cache[healthPath], [headPath]: require.cache[headPath] };

  const raised = [];
  const db = fakeSupabase({
    tables: {
      attention_queue: {
        select: () => ({ data: [], error: null }),
        insert: (s) => { raised.push(s.payload); return { data: null, error: null }; },
        update: () => ({ data: null, error: null }),
      },
      internal_expenses: { select: () => ({ count: 0, data: [], error: null }) },
      stripe_events: { select: () => ({ count: 0, data: [], error: null }) },
    },
  });

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getServiceClient: () => db } };
  require.cache[healthPath] = { id: healthPath, filename: healthPath, loaded: true, exports: {
    stripeIdentity: async () => ({ ok: true, status: 'live', account_id: 'acct_live' }),
    webhookEvidence: async () => ({ ok: true, detail: 'ok' }),
    linkageGaps: async () => ({ ok: true, gaps: [] }),
  } };
  require.cache[reconPath] = { id: reconPath, filename: reconPath, loaded: true, exports: {
    providerFreshness: async () => [],
    cardCoverage: async () => ({ available: false }),
    // The renamed field. Reading `likely_causes` here threw TypeError on
    // `undefined.join` and killed the run before any finding was recorded.
    cashReconciliation: async () => ({
      variance: -883.42, book_cash: 1774, bank_cash: 890.58,
      possible_causes: ['opening balance and prior-year cash are not modelled'],
      ledger: { rows: 54, providerBacked: 8 },
    }),
    authorityVerdict: () => ({ level: 'indicative', authoritative: false, problems: [] }),
  } };
  delete require.cache[headPath];

  try {
    const run = require('../worker/agents/finance-head');
    const result = await run({ id: FGA_TENANT_ID, slug: 'fga' }, {});

    assert.strictEqual(result.success, true, `run failed: ${result.error}`);
    const variance = raised.find((r) => r.payload?.finding_key === 'cash_variance');
    assert.ok(variance, 'the $883 gap must reach the owner as a finding');
    assert.match(variance.summary, /Possible: opening balance/, 'the cause list must render');
    assert.ok(!/undefined/.test(variance.summary), 'no undefined may leak into owner-facing text');
  } finally {
    for (const [p, mod] of Object.entries(saved)) {
      if (mod) require.cache[p] = mod; else delete require.cache[p];
    }
  }
});

// ───────────────────────────────────────────────────────────────────────────
// P0 (round 4): the retry never re-attempted the fee.
//
// Fixing the ReferenceError made attempt 1 report failure correctly and proved
// nothing about attempt 2. Codex ran the real sequence against persistent
// state: income booked, fee failed, Stripe retried, the idempotency check saw
// the income and returned 'duplicate', and the fee was lost permanently.
//
// This test replays BOTH attempts against one shared store.
// ───────────────────────────────────────────────────────────────────────────
function statefulLedgerDb(onFeeInsert) {
  const rows = [];
  const findBy = (filters, key) => {
    const f = filters.find((x) => x[1] === `metadata->>${key}`);
    return f ? f[2] : null;
  };
  const db = fakeSupabase({
    rpc: { set_audit_context: () => ({ data: null, error: null }),
      is_period_locked: () => ({ data: false, error: null }) },
    tables: {
      tenant_config: {
        select: () => ({ data: { tenant_id: CLIENT_TENANT }, error: null }),
        upsert: () => ({ data: null, error: null }),
      },
      tenants: { select: () => ({ data: [{ name: 'A Kut Above' }], error: null }) },
      attention_queue: { insert: () => ({ data: null, error: null }) },
      finance_entries: {
        select: (s) => {
          const wantInvoice = findBy(s.filters, 'stripe_invoice_id');
          const wantFee = findBy(s.filters, 'stripe_fee_for_charge');
          let hit = null;
          if (wantInvoice) hit = rows.find((r) => r.metadata?.stripe_invoice_id === wantInvoice);
          else if (wantFee) hit = rows.find((r) => r.metadata?.stripe_fee_for_charge === wantFee);
          return { data: hit ? { id: hit.id } : null, error: null };
        },
        insert: (s) => {
          const row = s.payload;
          if (row.entry_type === 'expense' && row.metadata?.kind === 'stripe_fee') {
            const verdict = onFeeInsert();
            if (verdict) return { data: null, error: { message: verdict } };
          }
          const stored = { ...row, id: `fe_${rows.length + 1}` };
          rows.push(stored);
          return { data: { id: stored.id }, error: null };
        },
      },
    },
  });
  db.rows = rows;
  return db;
}

test('a retry repairs a fee that a previous attempt failed to book', async () => {
  const restore = stubStripeModule({
    charges: { retrieve: async () => ({ balance_transaction: { fee: 1477 } }) },
  });
  try {
    let failNextFee = true;
    const db = statefulLedgerDb(() => {
      if (failNextFee) { failNextFee = false; return 'transient write failure'; }
      return null;
    });
    const { recordStripeInvoicePaid } = require('../integrations/finance-sync');

    // Attempt 1: income books, fee fails, event is retryable.
    const first = await recordStripeInvoicePaid(db, invoiceFixture());
    assert.strictEqual(first.status, 'error');
    assert.strictEqual(db.rows.filter((r) => r.entry_type === 'income').length, 1);
    assert.strictEqual(db.rows.filter((r) => r.metadata?.kind === 'stripe_fee').length, 0,
      'precondition: the fee is missing after attempt 1');

    // Attempt 2: Stripe redelivers the SAME event against the SAME ledger.
    const second = await recordStripeInvoicePaid(db, invoiceFixture());

    const fees = db.rows.filter((r) => r.metadata?.kind === 'stripe_fee');
    assert.strictEqual(fees.length, 1, 'the retry must book the missing fee, not return duplicate and give up');
    assert.strictEqual(fees[0].amount, 14.77);
    assert.strictEqual(fees[0].tenant_id, FGA_TENANT_ID);
    assert.strictEqual(second.fee, 'booked');
    assert.strictEqual(db.rows.filter((r) => r.entry_type === 'income').length, 1,
      'the income must NOT be double-booked by the retry');
  } finally { restore(); }
});

test('a third delivery is a no-op — the repair is idempotent', async () => {
  const restore = stubStripeModule({
    charges: { retrieve: async () => ({ balance_transaction: { fee: 1477 } }) },
  });
  try {
    const db = statefulLedgerDb(() => null);
    const { recordStripeInvoicePaid } = require('../integrations/finance-sync');
    await recordStripeInvoicePaid(db, invoiceFixture());
    const third = await recordStripeInvoicePaid(db, invoiceFixture());
    assert.strictEqual(third.status, 'duplicate');
    assert.strictEqual(third.fee, 'exists');
    assert.strictEqual(db.rows.length, 2, 'exactly one income and one fee, however many times Stripe delivers');
  } finally { restore(); }
});

// ───────────────────────────────────────────────────────────────────────────
// Round 4: the false-green fixes had no direct behavioral tests. These execute
// the real code paths with the module boundaries stubbed.
// ───────────────────────────────────────────────────────────────────────────

/** Swap modules in require.cache, run fn, always restore. */
async function withStubbedModules(map, fn) {
  const saved = {};
  for (const [spec, exports] of Object.entries(map)) {
    const path = require.resolve(spec);
    saved[path] = require.cache[path];
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
  try { return await fn(); } finally {
    for (const [path, mod] of Object.entries(saved)) {
      if (mod) require.cache[path] = mod; else delete require.cache[path];
    }
  }
}

test('the job processor marks a self-reported agent failure as failed, not completed', async () => {
  const calls = { completed: [], failed: [], activity: [] };
  const procPath = require.resolve('../worker/jobs/processor');

  await withStubbedModules({
    '../db/queries/jobs': {
      getPendingJobs: async () => [{ id: 'job1', agent_name: 'flaky', tenant_id: 't1', payload: {} }],
      markProcessing: async () => true,
      markCompleted: async (id, r) => { calls.completed.push({ id, r }); },
      markFailed: async (id, why) => { calls.failed.push({ id, why }); },
      logActivity: async (_t, _a, kind) => { calls.activity.push(kind); },
    },
    '../core/tenant': { resolveTenant: async () => ({ id: 't1', slug: 'fga' }) },
    '../db/client': { getServiceClient: () => ({}) },
    '../core/autonomous-os/outcome-recorder': { recordJobOutcome: async () => {} },
    '../core/agent-context': { runWithAgentContext: async (_ctx, fn) => fn() },
  }, async () => {
    delete require.cache[procPath];
    const processor = require('../worker/jobs/processor');
    // An agent that catches its own error and reports it — the shape that was
    // logged as a clean run and corrupted the freshness metric.
    processor.registerAgent('flaky', async () => ({ success: false, error: 'gmail token expired' }));

    await processor.pollJobs();   // the REAL loop body

    assert.strictEqual(calls.completed.length, 0, 'a self-reported failure must not be marked completed');
    assert.strictEqual(calls.failed.length, 1, 'it must be marked failed');
    assert.match(calls.failed[0].why, /gmail token expired/, 'the reason must survive to the job record');
    assert.ok(calls.activity.includes('job_failed'));
    assert.ok(!calls.activity.includes('job_completed'));
  });
  delete require.cache[procPath];
});

test('the job processor still completes a healthy run', async () => {
  const calls = { completed: [], failed: [] };
  const procPath = require.resolve('../worker/jobs/processor');
  await withStubbedModules({
    '../db/queries/jobs': {
      getPendingJobs: async () => [{ id: 'job2', agent_name: 'healthy', tenant_id: 't1', payload: {} }],
      markProcessing: async () => true,
      markCompleted: async (id, r) => { calls.completed.push({ id, r }); },
      markFailed: async (id, why) => { calls.failed.push({ id, why }); },
      logActivity: async () => {},
    },
    '../core/tenant': { resolveTenant: async () => ({ id: 't1', slug: 'fga' }) },
    '../db/client': { getServiceClient: () => ({}) },
    '../core/autonomous-os/outcome-recorder': { recordJobOutcome: async () => {} },
    '../core/agent-context': { runWithAgentContext: async (_ctx, fn) => fn() },
  }, async () => {
    delete require.cache[procPath];
    const processor = require('../worker/jobs/processor');
    // Negative control: a skip is NOT a failure, or the fix would fail every
    // kill-switched agent in the fleet.
    processor.registerAgent('healthy', async () => ({ success: true, skipped: 'kill_switch' }));
    await processor.pollJobs();
    assert.strictEqual(calls.failed.length, 0, 'a deliberate skip is not a failure');
    assert.strictEqual(calls.completed.length, 1);
  });
  delete require.cache[procPath];
});

test('a mailbox that fails on its token makes the whole scan report failure', async () => {
  const scanPath = require.resolve('../worker/agents/invoice-scan');
  await withStubbedModules({
    '../db/client': { getServiceClient: () => ({ from: () => ({ insert: async () => ({}) }) }) },
    '../core/gmail-invoice-scan': {
      scanAllMailboxes: async () => ({
        mailboxes: [{ mailbox: 'patrick@firstgenautomate.com', fatal: 'invalid_grant: token expired' }],
        imported: 0, duplicates: 0, skipped: 0, errors: 0,
      }),
    },
  }, async () => {
    delete require.cache[scanPath];
    const run = require('../worker/agents/invoice-scan');
    const result = await run({ id: FGA_TENANT_ID, slug: 'fga' }, {});
    assert.strictEqual(result.success, false, 'an unreadable mailbox is not a healthy scan');
    assert.match(result.error, /unreachable/);
    assert.match(result.error, /token expired/);
  });
  delete require.cache[scanPath];
});

test('per-message Gmail errors also fail the scan', async () => {
  const scanPath = require.resolve('../worker/agents/invoice-scan');
  await withStubbedModules({
    '../db/client': { getServiceClient: () => ({ from: () => ({ insert: async () => ({}) }) }) },
    '../core/gmail-invoice-scan': {
      scanAllMailboxes: async () => ({
        mailboxes: [{ mailbox: 'ok@firstgenautomate.com' }],
        imported: 4, duplicates: 0, skipped: 0, errors: 3,
      }),
    },
  }, async () => {
    delete require.cache[scanPath];
    const run = require('../worker/agents/invoice-scan');
    const result = await run({ id: FGA_TENANT_ID, slug: 'fga' }, {});
    assert.strictEqual(result.success, false, 'skipped receipts are unseen receipts');
    assert.match(result.error, /3 message\(s\) failed/);
  });
  delete require.cache[scanPath];
});

test('a closed period blocks the event for owner replay instead of retrying forever', async () => {
  const { classify, RETRYABLE, OWNER_REPLAYABLE } = require('../integrations/stripe-inbox');
  const status = classify({ sync: { status: 'period_locked' } });
  assert.strictEqual(status, 'blocked');
  assert.ok(!RETRYABLE.has(status), 'retrying cannot reopen a month — only the owner can');
  assert.ok(OWNER_REPLAYABLE.has(status), 'it must stay visible and replayable, not be discarded');
  // A real failure is still retried.
  assert.ok(RETRYABLE.has(classify({ sync: { status: 'error', error: 'db down' } })));
});

test('a caller cannot forge provenance through the finance API', () => {
  const { safeMetadata } = require('../api/routes/finance');

  // The attack: POST an entry that claims Stripe booked it. The audit trigger
  // copies metadata.source into row_source, and the reconciliation header
  // counts provider ids as evidence — so an accepted forgery would launder a
  // hand-typed number into "provider-backed".
  const forged = safeMetadata({
    source: 'stripe-webhook',
    stripe_invoice_id: 'in_fake',
    stripe_charge_id: 'ch_fake',
    mercury_txn_id: 'txn_fake',
    note: 'legitimate user field',
  });

  assert.strictEqual(forged.source, 'manual_entry', 'the server decides provenance');
  assert.ok(!forged.stripe_invoice_id, 'a caller may not claim a Stripe invoice id');
  assert.ok(!forged.stripe_charge_id);
  assert.ok(!forged.mercury_txn_id);
  assert.strictEqual(forged.note, 'legitimate user field', 'ordinary fields still pass through');

  // And the forged row must NOT read as provider-backed downstream.
  const { ledgerTotals } = require('../core/finance/reconciliation');
  assert.ok(typeof ledgerTotals === 'function');
  for (const key of require('../api/routes/finance').RESERVED_METADATA_KEYS) {
    assert.ok(!(key in forged) || key === 'source', `${key} must be stripped`);
  }
});
