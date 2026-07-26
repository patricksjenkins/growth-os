/**
 * Chief Financial Agent — the operating runtime for Finance & Data Governance.
 *
 * OWNS: that the books are TRUE. Not that a report renders — that the numbers
 * in it can be relied on.
 *
 * WHY IT EXISTS
 * The department had a mission, an authority contract, supervised tables and
 * accepted report types (catalog.js, migration 090) and NO agent. Codex,
 * 2026-07-26: "control schema built; operating runtime absent." So while
 * production sat bound to a Stripe sandbox for two months, $775 of real
 * revenue never reached the ledger, Mercury stopped importing, and the books
 * drifted $2,415 from the bank — nothing was watching, because nothing existed
 * to watch.
 *
 * Every check here answers a question the owner would otherwise have to think
 * to ask, and each one failed silently in production at least once.
 *
 * SAFETY (deliberate)
 *   - FGA tenant only.
 *   - NEVER writes to finance_entries. It does not book, adjust, or reclassify
 *     money. Its only outputs are attention items and a close checklist —
 *     evidence and escalation, not authority over the ledger.
 *   - One attention item per (day, condition), updated in place, auto-resolved
 *     when the condition clears.
 *   - Kill switch: finance_head_enabled.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID, getConfig } = require('../../core/config');
const {
  providerFreshness, cashReconciliation, authorityVerdict,
} = require('../../core/finance/reconciliation');

/** Variance below this is rounding, not a finding. */
const VARIANCE_TOLERANCE_USD = 1;
/** Days before month end to start preparing the close. */
const CLOSE_PREP_DAYS = 5;

/**
 * One attention item per condition, updated rather than duplicated.
 * Mirrors the revenue guardian's incident model — a persistent problem must
 * read as ONE open item, not a new alert every morning.
 */
async function upsertFinding(db, { key, severity, title, summary, payload, log }) {
  const { data: existing } = await db.from('attention_queue')
    .select('id').eq('tenant_id', FGA_TENANT_ID).eq('type', 'finance_exception')
    .filter('payload->>finding_key', 'eq', key).is('resolved_at', null).limit(1);

  const row = {
    severity, title, summary,
    payload: { ...payload, finding_key: key },
    produced_at: new Date().toISOString(),
  };
  if (existing && existing.length) {
    await db.from('attention_queue').update(row).eq('id', existing[0].id).then(() => {}, () => {});
    return { key, action: 'updated' };
  }
  const { error } = await db.from('attention_queue').insert({
    tenant_id: FGA_TENANT_ID, type: 'finance_exception', entity_type: 'finance',
    quick_actions: [{ label: 'Open Finance', href: '/admin/finance' }],
    produced_by: 'finance-head', ...row,
  });
  if (error) {
    log.error(`finding insert failed (${key}): ${error.message}`);
    return { key, action: 'failed', error: error.message };
  }
  return { key, action: 'raised' };
}

/** Close findings whose condition no longer holds — alerts are live state. */
async function resolveFindings(db, openKeys, log) {
  const { data } = await db.from('attention_queue')
    .select('id, payload').eq('tenant_id', FGA_TENANT_ID).eq('type', 'finance_exception')
    .is('resolved_at', null).limit(50);
  const stale = (data || []).filter((r) => !openKeys.has(r.payload?.finding_key));
  if (!stale.length) return 0;
  await db.from('attention_queue').update({
    resolved_at: new Date().toISOString(), resolution: 'auto_resolved',
    resolved_by_label: 'finance-head: condition cleared',
  }).in('id', stale.map((r) => r.id)).eq('tenant_id', FGA_TENANT_ID).then(() => {}, () => {});
  log.info(`Resolved ${stale.length} cleared finance finding(s)`);
  return stale.length;
}

/**
 * Monthly close readiness.
 *
 * Not a close — a CHECKLIST with evidence. Says what would block a clean close
 * if the owner sat down to do one today: unreviewed expense drafts, unlinked
 * payers, an unreconciled variance, a stale feed.
 */
async function closeReadiness(db, now) {
  const daysLeft = (() => {
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return end - now.getDate();
  })();

  const [pendingDrafts, orphanEvents] = await Promise.all([
    db.from('internal_expenses').select('id', { count: 'exact', head: true })
      .eq('review_status', 'pending')
      .then((r) => r.count || 0, () => 0),
    db.from('stripe_events').select('id', { count: 'exact', head: true })
      .in('status', ['orphaned', 'rejected'])
      .then((r) => r.count || 0, () => 0),
  ]);

  return {
    days_to_month_end: daysLeft,
    in_prep_window: daysLeft <= CLOSE_PREP_DAYS,
    blockers: [
      pendingDrafts > 0 ? `${pendingDrafts} expense draft(s) awaiting review` : null,
      orphanEvents > 0 ? `${orphanEvents} Stripe event(s) unresolved (orphaned or rejected)` : null,
    ].filter(Boolean),
    pending_expense_drafts: pendingDrafts,
    unresolved_stripe_events: orphanEvents,
  };
}

async function run(tenant, payload = {}) {
  const log = createLogger('finance-head', tenant.slug);
  const isFga = tenant.id === FGA_TENANT_ID || tenant.slug === 'fga' || tenant.slug === 'platform';
  if (!isFga) return { success: true, skipped: 'not_fga_tenant' };
  if (String(getConfig(tenant, 'finance_head_enabled', 'true')) === 'false') {
    return { success: true, skipped: 'kill_switch' };
  }

  const db = getServiceClient();
  const now = new Date();
  const year = now.getFullYear();

  // Reuse the SAME probes Reports & Insights displays, so the head's verdict
  // and the owner's screen can never disagree.
  const { stripeIdentity, webhookEvidence, linkageGaps } = require('../../api/routes/admin-provider-health');
  let stripe = { ok: false, detail: 'probe unavailable' };
  let webhook = { ok: false, detail: 'probe unavailable' };
  let linkage = { ok: true, gaps: [] };
  try {
    [stripe, webhook, linkage] = await Promise.all([stripeIdentity(), webhookEvidence(db), linkageGaps(db)]);
  } catch (err) {
    log.warn(`provider probes unavailable: ${err.message}`);
  }

  const [freshness, reconciliation, close] = await Promise.all([
    providerFreshness(db),
    cashReconciliation(db, year),
    closeReadiness(db, now),
  ]);
  const verdict = authorityVerdict({ providerHealth: { stripe, webhook, linkage }, reconciliation, freshness });

  // ── Findings: each one failed silently in production at least once ──
  const findings = [];
  const openKeys = new Set();
  const raise = async (key, severity, title, summary, extra = {}) => {
    openKeys.add(key);
    findings.push(await upsertFinding(db, { key, severity, title, summary, payload: extra, log }));
  };

  if (!stripe.ok) {
    await raise('provider_identity', 'red',
      'Payment provider identity is wrong',
      `${stripe.detail} Revenue cannot reach the books until this is corrected.`,
      { account_id: stripe.account_id, status: stripe.status });
  }
  if (!webhook.ok) {
    await raise('webhook_never_booked', 'red',
      'No payment has ever been booked automatically',
      'Every dollar on the books was hand-entered or bank-derived. Until a real charge books itself, the pipeline is unproven.',
      { detail: webhook.detail });
  }
  if (linkage.ok === false && linkage.gaps.length) {
    await raise('unlinked_payers', 'amber',
      `${linkage.gaps.length} billed client(s) not linked to a payment provider`,
      `${linkage.gaps.map((g) => g.tenant).join(', ')} are billed but have no stripe_customer_id, so their payments cannot be matched to them.`,
      { gaps: linkage.gaps });
  }
  if (reconciliation.variance != null && Math.abs(reconciliation.variance) >= VARIANCE_TOLERANCE_USD) {
    await raise('cash_variance', 'amber',
      `Books and bank differ by $${Math.abs(reconciliation.variance).toFixed(2)}`,
      `Ledger says ${reconciliation.book_cash.toFixed(2)}, bank says ${reconciliation.bank_cash}. `
        + `Likely: ${reconciliation.likely_causes.join('; ')}.`,
      { variance: reconciliation.variance, book_cash: reconciliation.book_cash, bank_cash: reconciliation.bank_cash });
  }
  for (const f of freshness) {
    if (f.state === 'never' || f.state === 'stale') {
      await raise(`feed_${f.provider}`, f.state === 'never' ? 'red' : 'amber',
        `${f.provider} feed is ${f.state}`,
        f.state === 'never'
          ? `${f.provider} has never delivered data to the ledger — it is not connected, not merely late.`
          : `${f.provider} last delivered ${Math.round((f.hours_since || 0) / 24)} day(s) ago. Expenses or revenue may be accumulating unrecorded.`,
        { hours_since: f.hours_since });
    }
  }
  if (close.in_prep_window && close.blockers.length) {
    await raise('close_readiness', 'amber',
      `Month close in ${close.days_to_month_end}d — ${close.blockers.length} blocker(s)`,
      close.blockers.join('; ') + '.',
      { ...close });
  }

  const resolved = await resolveFindings(db, openKeys, log);
  log.info(`Finance authority: ${verdict.level} · ${findings.length} finding(s) · ${resolved} resolved`);

  return {
    success: true,
    authority: verdict.level,
    authoritative: verdict.authoritative,
    findings,
    findings_open: openKeys.size,
    findings_resolved: resolved,
    reconciliation,
    freshness,
    close,
    outcome_contract: {
      result_state: 'succeeded',
      output_state: findings.length ? 'produced' : 'no_op',
      // The department's job is TRUE books. Anything less than authoritative
      // is an unmet outcome, however healthy the run looked.
      business_outcome_state: verdict.authoritative ? 'achieved' : 'not_achieved',
      reason_code: verdict.authoritative ? 'books_authoritative' : verdict.level,
      evidence: {
        variance: reconciliation.variance,
        provider_backed_rows: reconciliation.ledger?.providerBacked,
        total_rows: reconciliation.ledger?.rows,
        problems: verdict.problems,
      },
    },
  };
}

module.exports = run;
module.exports.upsertFinding = upsertFinding;
module.exports.closeReadiness = closeReadiness;
module.exports.VARIANCE_TOLERANCE_USD = VARIANCE_TOLERANCE_USD;
