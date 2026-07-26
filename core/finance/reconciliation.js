'use strict';

/**
 * Reconciliation & authority — can these numbers be trusted right now?
 *
 * Codex audit 2026-07-26: "The Reports & Insights UI is polished, but it is
 * displaying an incomplete ledger assembled from disconnected sources." The
 * page showed clean totals while production was bound to a Stripe sandbox,
 * $775 of real revenue was missing, and the books disagreed with the bank by
 * $2,415. Nothing on the surface hinted at any of it.
 *
 * A financial report that cannot say how confident it is, is a liability.
 * This module answers four questions the page must display alongside every
 * total:
 *
 *   AUTHORITY      — is the provider identity correct (live account, real
 *                    webhook), or are we reading a disconnected feed?
 *   FRESHNESS      — when did each provider last actually deliver anything?
 *   RECONCILIATION — do the books agree with the bank?
 *   VARIANCE       — if not, by how much, and is any of it explained?
 *
 * Read-only. Never mutates the ledger.
 */

const { FGA_TENANT_ID } = require('../config');

/** A provider feed is stale if it has produced nothing in this long. */
const STALE_HOURS = { stripe: 24 * 40, mercury: 36, gmail: 24 * 3 };

const hoursSince = (iso) =>
  iso ? Math.round((Date.now() - new Date(iso).getTime()) / 3600000) : null;

/**
 * Ledger totals for a year, split the way the P&L actually uses them.
 * Equity movements (owner contributions/draws) are NOT income or expense and
 * are returned separately — conflating them is what produced the original
 * $1,000 variance.
 */
async function ledgerTotals(db, year, tenantId = FGA_TENANT_ID) {
  const { data, error } = await db.from('finance_entries')
    .select('entry_type, amount, date, metadata')
    .eq('tenant_id', tenantId)
    .gte('date', `${year}-01-01`).lte('date', `${year}-12-31`).limit(5000);
  if (error) throw new Error(`ledger read failed: ${error.message}`);
  const rows = data || [];
  const sum = (pred) => rows.filter(pred).reduce((n, r) => n + Number(r.amount || 0), 0);
  return {
    income: sum((r) => r.entry_type === 'income'),
    expenses: sum((r) => r.entry_type === 'expense'),
    /*
     * Transfers are NOT equity, and they are not cash movement either.
     *
     * When the $390 Amex payment was correctly reclassified out of expenses, it
     * landed in this bucket because the bucket was "anything that isn't income
     * or expense" — so book cash gained $390 from a row that moved money
     * BETWEEN accounts. Paying a card settles expenses already on the books;
     * counting the settlement again double-counts it, with the sign flipped.
     * Same for a Stripe payout: it settles income already recognised.
     *
     * Reported separately, and excluded from book cash entirely.
     */
    transfers: sum((r) => r.entry_type === 'transfer'),
    equity: sum((r) => !['income', 'expense', 'transfer'].includes(r.entry_type)),
    rows: rows.length,
    // Provider-backed rows are the ones we can point at an immutable external
    // record for. The rest are hand-entered and only as good as the typist.
    /*
     * Provider-backed = we can point the row at an external record.
     *
     * `mercury_transaction_id` was a guess; Mercury actually writes
     * `mercury_txn_id`, so every Mercury-backed row was being excluded and the
     * header under-reported coverage. A metric that is confidently wrong is
     * worse than one that is absent.
     *
     * Deliberately NOT claimed: that these ids were verified against the
     * provider. They evidence provenance, not validity.
     */
    providerBacked: rows.filter((r) => {
      const m = r.metadata || {};
      // `stripe_fee_for_charge` is the Stripe charge id a fee row belongs to —
      // an immutable provider record like any other, but it was omitted, so
      // every processing-fee row read as hand-typed.
      return m.stripe_invoice_id || m.stripe_charge_id || m.stripe_payment_intent
        || m.stripe_checkout_session_id || m.stripe_fee_for_charge
        || m.mercury_txn_id || m.mercury_transaction_id;
    }).length,
    // How rows arrived, so the UI never calls a Mercury or scanner row
    // "typed by hand" again.
    bySource: rows.reduce((acc, r) => {
      // NOT 'manual'. A row with no source tag is a row whose origin we cannot
      // prove — it may have been typed, imported, or written by code that
      // forgot to stamp itself. Calling that "manual" asserted a provenance
      // nobody established.
      const src = (r.metadata || {}).source || 'unattributed';
      acc[src] = (acc[src] || 0) + 1;
      return acc;
    }, {}),
  };
}

/** When did each provider last put something in the ledger / on record? */
async function providerFreshness(db, tenantId = FGA_TENANT_ID) {
  const latest = async (table, build) => {
    try {
      const { data } = await build(db.from(table).select('created_at'))
        .order('created_at', { ascending: false }).limit(1);
      return data?.[0]?.created_at || null;
    } catch { return null; }
  };

  /*
   * Measure the CONNECTOR, not its output.
   *
   * This previously used "last new ledger row" for Mercury and "last created
   * expense" for Gmail. A connector that ran perfectly and correctly found
   * nothing new was therefore labelled stale — a quiet week became a false
   * alarm, and false alarms are what taught everyone to ignore this panel.
   * A successful agent run is the evidence that a feed is alive.
   */
  const lastRun = async (agent) => {
    try {
      const { data } = await db.from('agent_jobs')
        .select('created_at, status').eq('tenant_id', tenantId).eq('agent_name', agent)
        .eq('status', 'completed').order('created_at', { ascending: false }).limit(1);
      return data?.[0]?.created_at || null;
    } catch { return null; }
  };

  const [stripeEvent, mercuryRun, gmailRun] = await Promise.all([
    // Stripe is genuinely event-driven: no events means nothing arrived.
    latest('stripe_events', (q) => q),
    lastRun('mercury-sync'),
    lastRun('invoice-scan'),
  ]);

  const mk = (name, at, limitHours) => {
    const age = hoursSince(at);
    return {
      provider: name,
      last_activity_at: at,
      hours_since: age,
      // "never" is a distinct state from "stale" — a feed that has NEVER
      // delivered is not late, it is not connected.
      state: at === null ? 'never' : age > limitHours ? 'stale' : 'fresh',
    };
  };
  return [
    mk('stripe', stripeEvent, STALE_HOURS.stripe),
    mk('mercury', mercuryRun, STALE_HOURS.mercury),
    mk('gmail', gmailRun, STALE_HOURS.gmail),
  ];
}

/**
 * Books vs bank.
 *
 * Book cash = income - expenses + equity (transfers excluded: internal movement). Compared against the last observed
 * Mercury balance. A non-zero variance is normal in-flight (a Stripe payout
 * takes days to settle), so the number is reported with its likely
 * explanation rather than as a pass/fail.
 */
async function cashReconciliation(db, year, tenantId = FGA_TENANT_ID) {
  const totals = await ledgerTotals(db, year, tenantId);
  const bookCash = totals.income - totals.expenses + totals.equity;

  let bankCash = null;
  let bankAt = null;
  try {
    const { data } = await db.from('agent_jobs')
      .select('result, created_at').eq('tenant_id', tenantId).eq('agent_name', 'mercury-sync')
      .order('created_at', { ascending: false }).limit(5);
    const withBalance = (data || []).find((j) => j.result && j.result.cash_balance != null);
    if (withBalance) {
      bankCash = Number(withBalance.result.cash_balance);
      bankAt = withBalance.created_at;
    }
  } catch { /* balance unavailable — reported as unknown below */ }

  const variance = bankCash == null ? null : Number((bankCash - bookCash).toFixed(2));

  /*
   * HONESTY ABOUT WHAT THIS IS.
   *
   * Codex 2026-07-26 (round 2), correctly: this is NOT an accounting
   * reconciliation. It compares one year's P&L-plus-equity against today's
   * bank balance, which ignores the opening balance, prior-year retained
   * cash, inter-account transfers, unpaid bills, receivables, card
   * liabilities and deposits in transit.
   *
   * The number is still useful — a large gap is worth investigating — but
   * presenting it as "unexplained variance" implied a rigour that does not
   * exist, and a precise-looking wrong number is worse than an admitted
   * estimate. It is now labelled an INDICATOR, with its own limits attached,
   * and it no longer claims to be reconciled: `reconciled` is null until a
   * real reconciliation (opening balance + full period activity) exists.
   */
  return {
    method: 'indicative',
    is_accounting_reconciliation: false,
    book_cash: Number(bookCash.toFixed(2)),
    bank_cash: bankCash,
    bank_observed_at: bankAt,
    variance,
    // null = not assessed, deliberately distinct from false = assessed and off.
    reconciled: null,
    caveat: 'Indicative only: compares this year\'s income − expenses + equity against the current '
      + 'bank balance. Excludes the opening balance, prior-year cash, inter-account transfers, '
      + 'unpaid bills, receivables, card liabilities and deposits in transit. Not an accounting reconciliation.',
    possible_causes: variance == null ? ['bank balance unknown — Mercury has not reported'] : [
      'opening balance and prior-year cash are not modelled',
      variance > 0 ? 'Stripe payouts settled but not yet recorded as transfers' : null,
      variance > 0 ? 'expenses paid but not captured from receipts' : null,
      variance < 0 ? 'ledger entries with no matching bank movement' : null,
    ].filter(Boolean),
    ledger: totals,
  };
}

/**
 * The single verdict the page leads with.
 *
 * Deliberately strict: the report claims authority ONLY when the provider
 * identity is right, money has demonstrably flowed through it, and the books
 * agree with the bank. Anything less is "provisional" — which is what the last
 * two months actually were, while the UI implied certainty.
 */
function authorityVerdict({ providerHealth, reconciliation, freshness }) {
  const problems = [];
  if (!providerHealth?.stripe?.ok) {
    problems.push(providerHealth?.stripe?.detail || 'Stripe provider identity is not verified');
  }
  if (!providerHealth?.webhook?.ok) {
    problems.push('No payment has ever been booked by the Stripe webhook');
  }
  if (providerHealth?.linkage && providerHealth.linkage.ok === false) {
    problems.push(`${providerHealth.linkage.gaps.length} billed tenant(s) are not linked to a provider customer`);
  }
  // The cash figure is an INDICATOR, not a reconciliation, so it is reported
  // as something to look into — never as a proven discrepancy.
  if (reconciliation && reconciliation.variance != null && Math.abs(reconciliation.variance) >= 1) {
    problems.push(
      `Books and bank differ by $${Math.abs(reconciliation.variance).toFixed(2)} (indicative — no true reconciliation exists yet)`);
  }
  for (const f of freshness || []) {
    if (f.state === 'never') problems.push(`${f.provider} has never delivered data`);
    else if (f.state === 'stale') problems.push(`${f.provider} last delivered ${Math.round(f.hours_since / 24)}d ago`);
  }
  return {
    authoritative: problems.length === 0,
    level: problems.length === 0 ? 'authoritative' : problems.length <= 2 ? 'provisional' : 'unreliable',
    problems,
  };
}


/**
 * Card-liability coverage — did we capture what we actually paid the card?
 *
 * Once a card payment is correctly a transfer, the ONLY way a card-charged
 * expense reaches the books is a captured receipt. FGA has no card feed (an
 * emailed statement is not a feed), so a missed receipt now UNDERSTATES
 * expenses instead of double-counting them — trading an over-deduction for a
 * lost one, which costs real money at tax time.
 *
 * So the correction has to be two-sided. This compares what left the bank for
 * the card against the vendor expenses captured in the same window. It cannot
 * attribute individual charges without a card feed, so it reports a coverage
 * RATIO and says plainly that it is an estimate — a signal to go looking, not
 * an accusation.
 */
async function cardCoverage(db, { days = 90, tenantId = FGA_TENANT_ID } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { data, error } = await db.from('finance_entries')
    .select('entry_type, amount, description, category, metadata, date')
    .eq('tenant_id', tenantId).gte('date', since).limit(3000);
  if (error) return { available: false, detail: error.message };

  const rows = data || [];
  const isCardPayment = (r) =>
    (r.metadata || {}).kind === 'card_payment'
    || /american express|amex|card payment|credit card/i.test(`${r.description || ''} ${r.category || ''}`);

  const cardPaid = rows.filter((r) => r.entry_type === 'transfer' && isCardPayment(r))
    .reduce((n, r) => n + Math.abs(Number(r.amount)), 0);
  // Vendor expenses are the capture side. Card payments misfiled as expenses
  // are excluded so a legacy row cannot make coverage look complete.
  const vendorExpenses = rows.filter((r) => r.entry_type === 'expense' && !isCardPayment(r))
    .reduce((n, r) => n + Number(r.amount), 0);

  const ratio = cardPaid > 0 ? vendorExpenses / cardPaid : null;
  return {
    available: true,
    window_days: days,
    card_paid: Number(cardPaid.toFixed(2)),
    vendor_expenses_captured: Number(vendorExpenses.toFixed(2)),
    coverage_ratio: ratio == null ? null : Number(ratio.toFixed(2)),
    // Vendor spend legitimately exceeds card payments (bank-paid vendors,
    // billing lag), so only a SHORTFALL is a signal worth raising.
    likely_missing_receipts: ratio != null && ratio < 0.9,
    detail: cardPaid === 0
      ? 'No card payments in the window.'
      : `Paid the card $${cardPaid.toFixed(2)}; captured $${vendorExpenses.toFixed(2)} of vendor expenses`
        + (ratio != null && ratio < 0.9
          ? ' — receipts are probably missing, and unrecorded card charges are lost deductions.'
          : '.'),
  };
}

module.exports = {
  STALE_HOURS,
  ledgerTotals,
  providerFreshness,
  cashReconciliation,
  authorityVerdict,
  cardCoverage,
};
