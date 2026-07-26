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
    equity: sum((r) => !['income', 'expense'].includes(r.entry_type)),
    rows: rows.length,
    // Provider-backed rows are the ones we can point at an immutable external
    // record for. The rest are hand-entered and only as good as the typist.
    providerBacked: rows.filter((r) => {
      const m = r.metadata || {};
      return m.stripe_invoice_id || m.stripe_charge_id || m.stripe_payment_intent
        || m.stripe_checkout_session_id || m.mercury_transaction_id;
    }).length,
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

  const [stripeEvent, mercuryEntry, gmailScan] = await Promise.all([
    latest('stripe_events', (q) => q),
    latest('finance_entries', (q) => q.eq('tenant_id', tenantId).filter('metadata->>source', 'eq', 'mercury')),
    latest('internal_expenses', (q) => q),
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
    mk('mercury', mercuryEntry, STALE_HOURS.mercury),
    mk('gmail', gmailScan, STALE_HOURS.gmail),
  ];
}

/**
 * Books vs bank.
 *
 * Book cash = income - expenses + equity. Compared against the last observed
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
  return {
    book_cash: Number(bookCash.toFixed(2)),
    bank_cash: bankCash,
    bank_observed_at: bankAt,
    variance,
    // Under a dollar is rounding; anything larger is real and unexplained
    // until someone explains it.
    reconciled: variance != null && Math.abs(variance) < 1,
    likely_causes: variance == null ? ['bank balance unknown — Mercury has not reported'] : [
      variance > 0 ? 'Stripe payouts settled to the bank but not yet recorded as transfers' : null,
      variance > 0 ? 'expenses paid but not yet captured from receipts' : null,
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
  if (reconciliation && reconciliation.reconciled === false && reconciliation.variance != null) {
    problems.push(`Books and bank differ by $${Math.abs(reconciliation.variance).toFixed(2)}`);
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

module.exports = {
  STALE_HOURS,
  ledgerTotals,
  providerFreshness,
  cashReconciliation,
  authorityVerdict,
};
