/**
 * Growth OS — Growth & Ops Metrics Routes
 *
 * Phase 3 Step 2 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §3 Phase 3).
 *
 * Separate from /api/finance — these endpoints are LIVE-COMPUTED metrics
 * (MRR, churn, CAC, LTV, runway, automation health, time-to-value).
 *
 * Why a separate prefix:
 *   - finance is the immutable ledger (period locks apply)
 *   - metrics is the founder's dashboard view (recomputes each request)
 *
 * Tenant-scoped via the existing authMiddleware + tenantMiddleware
 * mounted ahead of /api in server.js.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const log = createLogger('metrics-routes');

// ============================================================================
// Helpers
// ============================================================================

function ymd(d) { return new Date(d).toISOString().slice(0, 10); }
function startOfMonth(year, month) { return `${year}-${String(month).padStart(2, '0')}-01`; }
function endOfMonth(year, month) {
  const d = new Date(year, month, 0);  // day 0 of next month = last day of this month
  return ymd(d);
}

// ============================================================================
// GET /api/metrics/mrr-trend?months=12
//
// Returns the MRR snapshot for each of the last N months. Built off
// tenant_metrics_snapshots (populated daily by cron). If no snapshots
// exist yet, falls back to "current MRR repeated" so the chart isn't blank.
// ============================================================================
router.get('/mrr-trend', async (req, res) => {
  try {
    const months = Math.min(Number(req.query.months) || 12, 60);
    const today = new Date();
    const points = [];

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const monthEnd = endOfMonth(d.getFullYear(), d.getMonth() + 1);

      const { data: snap } = await db
        .from('tenant_metrics_snapshots')
        .select('mrr, status')
        .lte('snapshot_date', monthEnd)
        .order('snapshot_date', { ascending: false })
        .limit(50);  // hard cap — coalesce across tenants

      const mrrAtMonthEnd = (snap || [])
        .filter(s => s.status === 'active')
        .reduce((acc, s) => acc + Number(s.mrr || 0), 0);

      points.push({ month: monthLabel, mrr: mrrAtMonthEnd });
    }

    res.json({ success: true, points });
  } catch (err) {
    log.error(`/mrr-trend failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/churn?window=90
//
// Computes logo churn (% of tenants churned in the window / starting tenants)
// and revenue churn (lost MRR / starting MRR). Window defaults to 90 days.
// ============================================================================
router.get('/churn', async (req, res) => {
  try {
    const windowDays = Math.min(Math.max(Number(req.query.window) || 90, 7), 365);
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    // Active tenants at start of window vs end of window
    const { data: configs } = await db
      .from('tenant_config')
      .select('tenant_id, key, value')
      .in('key', ['churned_at', 'first_paid_at', 'monthly_rate', 'tier']);

    // Reshape into per-tenant maps
    const tenants = new Map();
    for (const c of configs || []) {
      if (!tenants.has(c.tenant_id)) tenants.set(c.tenant_id, {});
      tenants.get(c.tenant_id)[c.key] = c.value;
    }

    let startingTenants = 0;
    let churnedInWindow = 0;
    let startingMrr = 0;
    let churnedMrr = 0;

    for (const [, t] of tenants) {
      const paid = t.first_paid_at;
      const churned = t.churned_at;
      const rate = Number(t.monthly_rate) || 0;
      const wasActiveAtStart = paid && paid <= cutoff && (!churned || churned > cutoff);
      const churnedDuringWindow = churned && churned > cutoff;

      if (wasActiveAtStart) {
        startingTenants++;
        startingMrr += rate;
        if (churnedDuringWindow) {
          churnedInWindow++;
          churnedMrr += rate;
        }
      }
    }

    const logoChurnPct = startingTenants > 0 ? (churnedInWindow / startingTenants) * 100 : 0;
    const revenueChurnPct = startingMrr > 0 ? (churnedMrr / startingMrr) * 100 : 0;

    res.json({
      success: true,
      window_days: windowDays,
      starting_tenants: startingTenants,
      churned_tenants: churnedInWindow,
      logo_churn_pct: Number(logoChurnPct.toFixed(2)),
      starting_mrr: startingMrr,
      churned_mrr: churnedMrr,
      revenue_churn_pct: Number(revenueChurnPct.toFixed(2)),
    });
  } catch (err) {
    log.error(`/churn failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/ltv-cac
//
// LTV  = ARPU * gross_margin / monthly_churn_rate
// CAC  = total marketing/sales spend / new customers in same window
//
// For FGA in launch phase, marketing spend is bootstrap-tiny; this is
// best-effort. Returns a clearly-labeled "early" indicator until we
// hit 3+ paying tenants.
// ============================================================================
router.get('/ltv-cac', async (req, res) => {
  try {
    const windowDays = 90;
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    // Average monthly rate among active tenants → ARPU proxy
    const { data: configs } = await db
      .from('tenant_config')
      .select('tenant_id, key, value')
      .in('key', ['monthly_rate', 'churned_at', 'first_paid_at']);

    const tenants = new Map();
    for (const c of configs || []) {
      if (!tenants.has(c.tenant_id)) tenants.set(c.tenant_id, {});
      tenants.get(c.tenant_id)[c.key] = c.value;
    }

    let activeRates = [];
    let newCustomers = 0;
    for (const [, t] of tenants) {
      const rate = Number(t.monthly_rate) || 0;
      if (!t.churned_at && rate > 0) activeRates.push(rate);
      if (t.first_paid_at && t.first_paid_at > cutoff) newCustomers++;
    }

    const arpu = activeRates.length ? activeRates.reduce((a, b) => a + b, 0) / activeRates.length : 0;

    // Sum marketing spend (Marketing & Advertising category) over the window
    const { data: mktExpenses } = await db
      .from('finance_entries')
      .select('amount, date')
      .eq('entry_type', 'expense')
      .eq('category', 'Marketing & Advertising')
      .gte('date', cutoff.slice(0, 10));

    const totalMktSpend = (mktExpenses || []).reduce((acc, e) => acc + Number(e.amount), 0);

    // Stub assumptions for launch — flagged clearly
    const grossMargin = 0.85;     // platform infra is the main COGS
    const monthlyChurnRate = 0.02; // 2% / month is a healthy SMB SaaS baseline
    const ltv = arpu * grossMargin / monthlyChurnRate;
    const cac = newCustomers > 0 ? totalMktSpend / newCustomers : 0;
    const ratio = cac > 0 ? ltv / cac : null;

    res.json({
      success: true,
      arpu: Number(arpu.toFixed(2)),
      gross_margin_assumed: grossMargin,
      monthly_churn_rate_assumed: monthlyChurnRate,
      ltv: Number(ltv.toFixed(2)),
      cac: Number(cac.toFixed(2)),
      ltv_cac_ratio: ratio !== null ? Number(ratio.toFixed(2)) : null,
      new_customers_in_window: newCustomers,
      marketing_spend_in_window: totalMktSpend,
      window_days: windowDays,
      confidence: activeRates.length < 3 ? 'low — need 3+ paying tenants for meaningful signal' : 'medium',
    });
  } catch (err) {
    log.error(`/ltv-cac failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/runway
//
// Runway = cash balance / 3-month rolling average expenses.
// Cash balance: stored in latest tenant_metrics_snapshots row with key
// 'cash_balance' (populated by Mercury cron — Phase 4, currently null).
// Until that's live, return runway = null with a clear flag.
// ============================================================================
router.get('/runway', async (req, res) => {
  try {
    // Trailing 3-month average expenses
    const today = new Date();
    const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());

    const { data: expenses } = await db
      .from('finance_entries')
      .select('amount, date')
      .eq('entry_type', 'expense')
      .gte('date', ymd(threeMonthsAgo));

    const totalExp3mo = (expenses || []).reduce((acc, e) => acc + Number(e.amount), 0);
    const avgMonthlyBurn = totalExp3mo / 3;

    // Cash balance — pull latest snapshot with metadata.cash_balance
    const { data: latestSnap } = await db
      .from('tenant_metrics_snapshots')
      .select('metadata, snapshot_date')
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    const cashBalance = latestSnap?.metadata?.cash_balance ?? null;

    const runwayMonths = (cashBalance !== null && avgMonthlyBurn > 0)
      ? cashBalance / avgMonthlyBurn
      : null;

    res.json({
      success: true,
      cash_balance: cashBalance,
      avg_monthly_burn_3mo: Number(avgMonthlyBurn.toFixed(2)),
      runway_months: runwayMonths !== null ? Number(runwayMonths.toFixed(1)) : null,
      data_source: cashBalance !== null ? `snapshot_${latestSnap?.snapshot_date}` : 'cash_balance not yet wired (Phase 4 — Mercury feed)',
    });
  } catch (err) {
    log.error(`/runway failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/automation-health
//
// Surfaces what's already in agent_activity_log. For each agent active in
// the last 30 days: success rate, avg duration, last run, status pill.
// Tap-in (?agent=name) returns the most recent 50 runs.
// ============================================================================
router.get('/automation-health', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    if (req.query.agent) {
      // Drill-down: most recent runs for a specific agent
      const { data, error } = await db
        .from('agent_activity_log')
        .select('id, action, status, records_affected, duration_ms, error, created_at, details')
        .eq('agent_name', String(req.query.agent))
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return res.json({ success: true, agent: req.query.agent, runs: data || [] });
    }

    // Aggregate per-agent stats over 30 days
    const { data: rows, error } = await db
      .from('agent_activity_log')
      .select('agent_name, status, duration_ms, created_at')
      .gte('created_at', thirtyDaysAgo);
    if (error) throw error;

    const byAgent = new Map();
    for (const r of rows || []) {
      if (!byAgent.has(r.agent_name)) {
        byAgent.set(r.agent_name, {
          agent: r.agent_name,
          total_runs: 0,
          successes: 0,
          failures: 0,
          duration_sum_ms: 0,
          duration_count: 0,
          last_run_at: null,
        });
      }
      const a = byAgent.get(r.agent_name);
      a.total_runs++;
      if (r.status === 'success') a.successes++;
      else if (r.status === 'error' || r.status === 'failure') a.failures++;
      if (r.duration_ms != null) {
        a.duration_sum_ms += Number(r.duration_ms);
        a.duration_count++;
      }
      if (!a.last_run_at || r.created_at > a.last_run_at) a.last_run_at = r.created_at;
    }

    const agents = Array.from(byAgent.values()).map(a => {
      const successRate = a.total_runs > 0 ? (a.successes / a.total_runs) * 100 : 0;
      const avgDurationMs = a.duration_count > 0 ? a.duration_sum_ms / a.duration_count : null;
      // Green = ≥95% success in 30d, Amber = 80-95%, Red = <80%
      const status = successRate >= 95 ? 'green' : successRate >= 80 ? 'amber' : 'red';
      return {
        agent: a.agent,
        total_runs: a.total_runs,
        successes: a.successes,
        failures: a.failures,
        success_rate_pct: Number(successRate.toFixed(1)),
        avg_duration_ms: avgDurationMs !== null ? Math.round(avgDurationMs) : null,
        last_run_at: a.last_run_at,
        status,
      };
    }).sort((a, b) => b.total_runs - a.total_runs);

    res.json({ success: true, agents });
  } catch (err) {
    log.error(`/automation-health failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/time-to-value
//
// For each tenant who's reached "active" status, compute the elapsed
// time from signup (first_paid_at) to going live (status='active' in
// tenant_metrics_snapshots, or proxy from tenant_config). Median + p90.
// ============================================================================
router.get('/time-to-value', async (req, res) => {
  try {
    const { data: configs } = await db
      .from('tenant_config')
      .select('tenant_id, key, value')
      .in('key', ['first_paid_at', 'activated_at']);

    const tenants = new Map();
    for (const c of configs || []) {
      if (!tenants.has(c.tenant_id)) tenants.set(c.tenant_id, {});
      tenants.get(c.tenant_id)[c.key] = c.value;
    }

    const ttvHours = [];
    for (const [, t] of tenants) {
      if (t.first_paid_at && t.activated_at) {
        const diffMs = new Date(t.activated_at).getTime() - new Date(t.first_paid_at).getTime();
        if (diffMs > 0) ttvHours.push(diffMs / (1000 * 60 * 60));
      }
    }

    ttvHours.sort((a, b) => a - b);
    const median = ttvHours.length ? ttvHours[Math.floor(ttvHours.length / 2)] : null;
    const p90 = ttvHours.length ? ttvHours[Math.floor(ttvHours.length * 0.9)] : null;

    res.json({
      success: true,
      cohort_size: ttvHours.length,
      median_hours: median !== null ? Number(median.toFixed(1)) : null,
      p90_hours: p90 !== null ? Number(p90.toFixed(1)) : null,
      target_hours: 168, // 7 days per onboarding SLA
    });
  } catch (err) {
    log.error(`/time-to-value failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
