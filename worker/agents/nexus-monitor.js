/**
 * Growth OS — Sales Tax Nexus Monitor Agent
 *
 * Section 10 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §10).
 *
 * Monthly agent. Computes per-state YTD revenue from FGA's clients and
 * raises an attention_queue alert when any state crosses 80% of its
 * economic-nexus threshold — the "register for a sales-tax permit"
 * action gate.
 *
 * Mirrors the read-only logic in api/routes/metrics.js#/nexus-status
 * but persists findings to the queue so they show up on the Action
 * Ribbon WITHOUT a user having to open the report.
 *
 * Schedule: 0 7 1 * * (1st of each month, 7am ET) —
 * defined in worker/scheduler/cron.js.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// Same canonical thresholds as the REST endpoint. Source of truth for both.
const NEXUS_THRESHOLDS = {
  AL: { taxable: false, threshold: 250_000 },
  AK: { taxable: false, threshold: 100_000 },
  AZ: { taxable: false, threshold: 100_000 },
  AR: { taxable: false, threshold: 100_000 },
  CA: { taxable: false, threshold: 500_000 },
  CO: { taxable: false, threshold: 100_000 },
  CT: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  DC: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  FL: { taxable: false, threshold: 100_000 },
  GA: { taxable: false, threshold: 100_000 },
  HI: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  IL: { taxable: false, threshold: 100_000, txn_alt: 200 },
  IN: { taxable: false, threshold: 100_000 },
  IA: { taxable: true,  threshold: 100_000 },
  KS: { taxable: false, threshold: 100_000 },
  KY: { taxable: false, threshold: 100_000, txn_alt: 200 },
  LA: { taxable: false, threshold: 100_000, txn_alt: 200 },
  MA: { taxable: true,  threshold: 100_000 },
  MD: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  MI: { taxable: false, threshold: 100_000, txn_alt: 200 },
  MN: { taxable: false, threshold: 100_000 },
  MS: { taxable: true,  threshold: 250_000 },
  MO: { taxable: false, threshold: 100_000 },
  NE: { taxable: false, threshold: 100_000, txn_alt: 200 },
  NV: { taxable: false, threshold: 100_000, txn_alt: 200 },
  NJ: { taxable: false, threshold: 100_000, txn_alt: 200 },
  NM: { taxable: true,  threshold: 100_000 },
  NY: { taxable: true,  threshold: 500_000, txn_alt: 100 },
  NC: { taxable: false, threshold: 100_000 },
  ND: { taxable: false, threshold: 100_000 },
  OH: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  OK: { taxable: false, threshold: 100_000 },
  PA: { taxable: true,  threshold: 100_000 },
  RI: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  SC: { taxable: true,  threshold: 100_000 },
  TN: { taxable: true,  threshold: 100_000 },
  TX: { taxable: true,  threshold: 500_000 },
  UT: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  VT: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  VA: { taxable: false, threshold: 100_000, txn_alt: 200 },
  WA: { taxable: true,  threshold: 100_000 },
  WV: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  WI: { taxable: false, threshold: 100_000 },
  WY: { taxable: true,  threshold: 100_000, txn_alt: 200 },
};

async function _perStateRevenue(tenantId, year) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;

  // Pull income with explicit customer state from metadata; fall back to
  // tenant's home state from tenant_config.
  const { data: incomes } = await db
    .from('finance_entries')
    .select('amount, metadata, date')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'income')
    .gte('date', start)
    .lte('date', end);

  const { data: cfg } = await db
    .from('tenant_config')
    .select('value')
    .eq('tenant_id', tenantId)
    .eq('key', 'tax_jurisdiction')
    .maybeSingle();

  const homeState = (cfg?.value || 'GA').toUpperCase();
  const byState = new Map();

  for (const r of incomes || []) {
    const explicit = r.metadata?.customer_state || r.metadata?.tax_jurisdiction;
    const state = (explicit || homeState).toUpperCase();
    if (!NEXUS_THRESHOLDS[state]) continue;
    if (!byState.has(state)) byState.set(state, { revenue: 0, txn_count: 0 });
    const s = byState.get(state);
    s.revenue += Number(r.amount) || 0;
    s.txn_count++;
  }

  return byState;
}

async function _activeRegistrations(tenantId) {
  const { data } = await db
    .from('sales_tax_registrations')
    .select('state')
    .eq('tenant_id', tenantId)
    .is('deactivated_at', null);
  return new Set((data || []).map(r => r.state.toUpperCase()));
}

async function _existingOpenNexusItem(tenantId, state) {
  const { data } = await db
    .from('attention_queue')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('type', 'nexus_alert')
    .is('resolved_at', null)
    .filter('payload->>state', 'eq', state)
    .maybeSingle();
  return data?.id || null;
}

async function run(tenant) {
  const log = createLogger('nexus-monitor', tenant.slug);
  const year = new Date().getUTCFullYear();
  log.info(`Nexus check for tax year ${year}`);

  const byState = await _perStateRevenue(tenant.id, year);
  const registered = await _activeRegistrations(tenant.id);

  let alerted = 0;
  let suppressed = 0;
  const summary = [];

  for (const [state, s] of byState) {
    const cfg = NEXUS_THRESHOLDS[state];
    if (!cfg.taxable) continue;  // skip non-SaaS-taxable states
    if (registered.has(state)) {
      suppressed++;
      continue;  // already registered — no new alert needed
    }

    const dollarPct = (s.revenue / cfg.threshold) * 100;
    const txnPct = cfg.txn_alt ? (s.txn_count / cfg.txn_alt) * 100 : 0;
    const highestPct = Math.max(dollarPct, txnPct);

    if (highestPct < 80) continue;  // only alert at 80%+

    // Don't dupe — if an open queue item already exists for this state, skip
    if (await _existingOpenNexusItem(tenant.id, state)) {
      suppressed++;
      continue;
    }

    const severity = highestPct >= 100 ? 'red' : 'amber';
    const verb = highestPct >= 100 ? 'CROSSED' : 'approaching';

    await db.from('attention_queue').insert({
      tenant_id: tenant.id,
      type: 'nexus_alert',
      severity,
      title: `${verb} sales-tax nexus in ${state}`,
      summary: `YTD revenue from ${state} clients is $${Math.round(s.revenue).toLocaleString()} (${highestPct.toFixed(0)}% of $${cfg.threshold.toLocaleString()} threshold). ${highestPct >= 100 ? 'Register for a sales-tax permit immediately.' : 'Plan registration within the next 30-60 days.'}`,
      entity_type: 'nexus_state',
      entity_id: null,
      payload: {
        state,
        revenue_ytd: Number(s.revenue.toFixed(2)),
        threshold: cfg.threshold,
        threshold_txn: cfg.txn_alt || null,
        txn_count: s.txn_count,
        dollar_pct: Number(dollarPct.toFixed(1)),
        txn_pct: Number(txnPct.toFixed(1)),
        recommended_provider: 'TaxJar (acquired by Stripe — direct Stripe Billing integration)',
      },
      quick_actions: [
        { label: 'Mark Registered', verb: 'POST', path: `/api/finance/sales-tax-registrations` },
        { label: 'Dismiss', verb: 'POST', path: null },
      ],
      produced_by: 'nexus-monitor',
    });
    alerted++;
    summary.push({ state, dollar_pct: Number(dollarPct.toFixed(1)), severity });
  }

  log.success(`Nexus check complete: ${alerted} new alert${alerted === 1 ? '' : 's'}, ${suppressed} suppressed`, { summary });
  return { success: true, alerted, suppressed, summary };
}

module.exports = run;
