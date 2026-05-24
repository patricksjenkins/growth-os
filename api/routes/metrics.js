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

    // Sum marketing spend (Marketing & Advertising category) over the window.
    // Strictly FGA's OWN marketing spend — A Kut Above's ad budget for tree
    // service customers is not FGA's CAC. Same scoping bug we hit in the
    // tax-estimate route — fix the cause, not the symptom.
    const FGA_TENANT_ID_CAC = '30566ed6-026a-45e1-9502-029e6219df31';
    const { data: mktExpenses } = await db
      .from('finance_entries')
      .select('amount, date')
      .eq('tenant_id', FGA_TENANT_ID_CAC)
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

// ============================================================================
// STRETCH ENHANCEMENT #3 — INVESTOR-READY SaaS METRICS PACK
// ----------------------------------------------------------------------------
// The 12-metric pack every VC asks for. Phase 3 covered MRR, churn, LTV/CAC,
// runway, time-to-value. This adds the remaining seven:
//   - Net New MRR (split into new / expansion / contraction / churn)
//   - Net Revenue Retention (NRR)
//   - Gross Revenue Retention (GRR)
//   - Magic Number
//   - Burn Multiple
//   - CAC Payback Period
//   - Quick Ratio
// ============================================================================

// Helper: get config map keyed by tenant_id
async function _tenantConfigMap(keys) {
  const { data } = await db
    .from('tenant_config')
    .select('tenant_id, key, value')
    .in('key', keys);
  const map = new Map();
  for (const c of data || []) {
    if (!map.has(c.tenant_id)) map.set(c.tenant_id, {});
    map.get(c.tenant_id)[c.key] = c.value;
  }
  return map;
}

// ============================================================================
// GET /api/metrics/net-new-mrr?months=12
// Breakdown of MRR delta per month into: new / expansion / contraction / churn.
// Series intended for a stacked-bar chart.
// ============================================================================
router.get('/net-new-mrr', async (req, res) => {
  try {
    const months = Math.min(Number(req.query.months) || 12, 36);
    const today = new Date();
    const points = [];

    // Pull all monthly snapshots in range to compute month-over-month deltas
    const earliest = new Date(today.getFullYear(), today.getMonth() - months, 1);
    const { data: snaps } = await db
      .from('tenant_metrics_snapshots')
      .select('tenant_id, snapshot_date, mrr, status')
      .gte('snapshot_date', earliest.toISOString().slice(0, 10))
      .order('snapshot_date', { ascending: true });

    // Bucket: tenant_id -> [{ month, mrr, status }]
    const byTenant = new Map();
    for (const s of snaps || []) {
      const m = s.snapshot_date.slice(0, 7);
      if (!byTenant.has(s.tenant_id)) byTenant.set(s.tenant_id, new Map());
      const tm = byTenant.get(s.tenant_id);
      // Keep last snapshot per month per tenant
      tm.set(m, { mrr: Number(s.mrr) || 0, status: s.status });
    }

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const prev = new Date(today.getFullYear(), today.getMonth() - i - 1, 1);
      const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

      let newMrr = 0, expansion = 0, contraction = 0, churn = 0;
      for (const [, tm] of byTenant) {
        const curr = tm.get(monthKey);
        const before = tm.get(prevKey);
        const currMrr = curr?.mrr || 0;
        const prevMrr = before?.mrr || 0;

        if (!before && curr && currMrr > 0) newMrr += currMrr;
        else if (before && (!curr || curr.status === 'churned')) churn += prevMrr;
        else if (currMrr > prevMrr) expansion += (currMrr - prevMrr);
        else if (currMrr < prevMrr) contraction += (prevMrr - currMrr);
      }

      points.push({
        month: monthKey,
        new_mrr: Number(newMrr.toFixed(2)),
        expansion: Number(expansion.toFixed(2)),
        contraction: -Number(contraction.toFixed(2)),
        churn: -Number(churn.toFixed(2)),
        net: Number((newMrr + expansion - contraction - churn).toFixed(2)),
      });
    }

    res.json({ success: true, points });
  } catch (err) {
    log.error(`/net-new-mrr failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/retention?window=trailing12
//
// Returns both NRR (Net Revenue Retention) and GRR (Gross Revenue Retention)
// over a trailing-12-month window.
//
//   NRR = (Starting MRR + Expansion - Contraction - Churn) / Starting MRR
//   GRR = (Starting MRR - Contraction - Churn) / Starting MRR
//
// VCs use NRR>110% as a sign of healthy net-expansion. GRR<80% is concerning.
// ============================================================================
router.get('/retention', async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    // Pull tenants that were active 12 months ago — they're the cohort
    const { data: startingSnaps } = await db
      .from('tenant_metrics_snapshots')
      .select('tenant_id, mrr, status')
      .lte('snapshot_date', cutoffStr)
      .order('snapshot_date', { ascending: false })
      .limit(500);

    const cohort = new Map();  // tenant_id -> starting_mrr
    for (const s of startingSnaps || []) {
      if (!cohort.has(s.tenant_id) && s.status === 'active' && Number(s.mrr) > 0) {
        cohort.set(s.tenant_id, Number(s.mrr));
      }
    }

    // Pull today's snapshots for the same cohort
    const { data: nowSnaps } = await db
      .from('tenant_metrics_snapshots')
      .select('tenant_id, mrr, status')
      .gte('snapshot_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
      .order('snapshot_date', { ascending: false });

    const nowByTenant = new Map();
    for (const s of nowSnaps || []) {
      if (!nowByTenant.has(s.tenant_id)) {
        nowByTenant.set(s.tenant_id, { mrr: Number(s.mrr) || 0, status: s.status });
      }
    }

    let startingMrr = 0, expansion = 0, contraction = 0, churn = 0;
    for (const [tid, startMrr] of cohort) {
      startingMrr += startMrr;
      const curr = nowByTenant.get(tid);
      if (!curr || curr.status === 'churned') {
        churn += startMrr;
      } else if (curr.mrr > startMrr) {
        expansion += (curr.mrr - startMrr);
      } else if (curr.mrr < startMrr) {
        contraction += (startMrr - curr.mrr);
      }
    }

    const nrr = startingMrr > 0 ? ((startingMrr + expansion - contraction - churn) / startingMrr) * 100 : null;
    const grr = startingMrr > 0 ? ((startingMrr - contraction - churn) / startingMrr) * 100 : null;

    res.json({
      success: true,
      window: 'trailing-12-months',
      cohort_size: cohort.size,
      starting_mrr: Number(startingMrr.toFixed(2)),
      expansion: Number(expansion.toFixed(2)),
      contraction: Number(contraction.toFixed(2)),
      churn: Number(churn.toFixed(2)),
      nrr_pct: nrr !== null ? Number(nrr.toFixed(1)) : null,
      grr_pct: grr !== null ? Number(grr.toFixed(1)) : null,
      confidence: cohort.size < 3 ? 'low — need 3+ tenants active 12 months ago' : 'medium',
    });
  } catch (err) {
    log.error(`/retention failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/magic-number
//
// Magic Number = (Net New ARR this quarter) / (S&M spend last quarter)
// A capital-efficiency measure. >1.0 means $1 of S&M generates $1+ of new
// recurring revenue — strong signal. <0.5 = the funnel is broken.
// ============================================================================
router.get('/magic-number', async (req, res) => {
  try {
    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const qEnd = new Date(qStart);
    qEnd.setMonth(qEnd.getMonth() + 3);
    const lastQStart = new Date(qStart);
    lastQStart.setMonth(lastQStart.getMonth() - 3);
    const lastQEnd = new Date(qStart);

    // Net new ARR this quarter = (MRR at quarter end - MRR at quarter start) * 12
    const { data: snapsThisQ } = await db
      .from('tenant_metrics_snapshots')
      .select('tenant_id, snapshot_date, mrr, status')
      .gte('snapshot_date', qStart.toISOString().slice(0, 10))
      .lt('snapshot_date', qEnd.toISOString().slice(0, 10))
      .eq('status', 'active');

    const totalAtStart = new Map(), totalAtEnd = new Map();
    for (const s of snapsThisQ || []) {
      const d = s.snapshot_date;
      const map = d === qStart.toISOString().slice(0, 10) ? totalAtStart : totalAtEnd;
      map.set(s.tenant_id, Number(s.mrr) || 0);
    }
    const startMrr = Array.from(totalAtStart.values()).reduce((a, b) => a + b, 0);
    const endMrr = Array.from(totalAtEnd.values()).reduce((a, b) => a + b, 0);
    const netNewArr = (endMrr - startMrr) * 12;

    // S&M spend last quarter — sum of "Marketing & Advertising" + "Legal & Professional" (sales contracting)
    const { data: smExpenses } = await db
      .from('finance_entries')
      .select('amount')
      .eq('entry_type', 'expense')
      .in('category', ['Marketing & Advertising', 'Legal & Professional'])
      .gte('date', lastQStart.toISOString().slice(0, 10))
      .lt('date', lastQEnd.toISOString().slice(0, 10));

    const totalSm = (smExpenses || []).reduce((a, e) => a + Number(e.amount), 0);
    const magicNumber = totalSm > 0 ? netNewArr / totalSm : null;

    res.json({
      success: true,
      net_new_arr: Number(netNewArr.toFixed(2)),
      sm_spend_last_quarter: Number(totalSm.toFixed(2)),
      magic_number: magicNumber !== null ? Number(magicNumber.toFixed(2)) : null,
      health: magicNumber === null ? 'insufficient_data'
        : magicNumber >= 1.0 ? 'strong'
        : magicNumber >= 0.5 ? 'moderate'
        : 'weak',
      quarter: `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`,
    });
  } catch (err) {
    log.error(`/magic-number failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/burn-multiple
//
// Burn Multiple = (Net burn) / (Net new ARR)
// David Sacks' canonical capital efficiency measure. <1.0 = great; >2.0 = bad.
// Net burn = expenses - income (i.e., monthly cash consumption).
// ============================================================================
router.get('/burn-multiple', async (req, res) => {
  try {
    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const qEnd = new Date(qStart);
    qEnd.setMonth(qEnd.getMonth() + 3);

    // Net burn this quarter
    const { data: txns } = await db
      .from('finance_entries')
      .select('entry_type, amount')
      .gte('date', qStart.toISOString().slice(0, 10))
      .lt('date', qEnd.toISOString().slice(0, 10));

    let income = 0, expense = 0;
    for (const t of txns || []) {
      if (t.entry_type === 'income') income += Number(t.amount);
      else if (t.entry_type === 'expense') expense += Number(t.amount);
    }
    const netBurn = expense - income;

    // Net new ARR this quarter (same calc as magic number)
    const { data: snaps } = await db
      .from('tenant_metrics_snapshots')
      .select('tenant_id, snapshot_date, mrr, status')
      .gte('snapshot_date', qStart.toISOString().slice(0, 10))
      .lt('snapshot_date', qEnd.toISOString().slice(0, 10))
      .eq('status', 'active');

    const start = new Map(), end = new Map();
    for (const s of snaps || []) {
      const isStart = s.snapshot_date === qStart.toISOString().slice(0, 10);
      const map = isStart ? start : end;
      map.set(s.tenant_id, Number(s.mrr) || 0);
    }
    const startMrr = Array.from(start.values()).reduce((a, b) => a + b, 0);
    const endMrr = Array.from(end.values()).reduce((a, b) => a + b, 0);
    const netNewArr = (endMrr - startMrr) * 12;

    const burnMultiple = netNewArr > 0 ? netBurn / netNewArr : (netBurn > 0 ? null : 0);

    res.json({
      success: true,
      net_burn_quarter: Number(netBurn.toFixed(2)),
      net_new_arr: Number(netNewArr.toFixed(2)),
      burn_multiple: burnMultiple !== null ? Number(burnMultiple.toFixed(2)) : null,
      health: burnMultiple === null ? 'insufficient_data'
        : burnMultiple <= 1.0 ? 'excellent'
        : burnMultiple <= 2.0 ? 'good'
        : burnMultiple <= 3.0 ? 'concerning'
        : 'bad',
    });
  } catch (err) {
    log.error(`/burn-multiple failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/cac-payback
//
// CAC Payback Period (months) = CAC / (ARPU * Gross Margin)
// How many months of subscription revenue does it take to pay back the
// cost of acquiring a customer? <12 months = healthy SaaS.
// ============================================================================
router.get('/cac-payback', async (req, res) => {
  try {
    // Pull the ltv-cac calc to reuse ARPU + CAC
    const windowDays = 90;
    const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString().slice(0, 10);

    const configs = await _tenantConfigMap(['monthly_rate', 'churned_at', 'first_paid_at']);
    let activeRates = [];
    let newCustomers = 0;
    for (const [, t] of configs) {
      const rate = Number(t.monthly_rate) || 0;
      if (!t.churned_at && rate > 0) activeRates.push(rate);
      if (t.first_paid_at && t.first_paid_at > cutoff) newCustomers++;
    }
    const arpu = activeRates.length ? activeRates.reduce((a, b) => a + b, 0) / activeRates.length : 0;

    const { data: mktExpenses } = await db
      .from('finance_entries')
      .select('amount')
      .eq('entry_type', 'expense')
      .eq('category', 'Marketing & Advertising')
      .gte('date', cutoff);

    const cac = newCustomers > 0
      ? (mktExpenses || []).reduce((a, e) => a + Number(e.amount), 0) / newCustomers
      : 0;

    const grossMargin = 0.85;
    const paybackMonths = (arpu * grossMargin) > 0 ? cac / (arpu * grossMargin) : null;

    res.json({
      success: true,
      arpu: Number(arpu.toFixed(2)),
      cac: Number(cac.toFixed(2)),
      gross_margin_assumed: grossMargin,
      cac_payback_months: paybackMonths !== null ? Number(paybackMonths.toFixed(1)) : null,
      health: paybackMonths === null ? 'insufficient_data'
        : paybackMonths < 12 ? 'healthy'
        : paybackMonths < 18 ? 'moderate'
        : 'long',
    });
  } catch (err) {
    log.error(`/cac-payback failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/metrics/quick-ratio
//
// Quick Ratio = (New MRR + Expansion MRR) / (Churned MRR + Contraction MRR)
// Indicator of growth efficiency. >4 = excellent growth quality.
// ============================================================================
router.get('/quick-ratio', async (req, res) => {
  try {
    // Use the same monthly delta logic as net-new-mrr, summed over last 3 months
    const months = 3;
    const today = new Date();
    const earliest = new Date(today.getFullYear(), today.getMonth() - months - 1, 1);

    const { data: snaps } = await db
      .from('tenant_metrics_snapshots')
      .select('tenant_id, snapshot_date, mrr, status')
      .gte('snapshot_date', earliest.toISOString().slice(0, 10))
      .order('snapshot_date', { ascending: true });

    const byTenant = new Map();
    for (const s of snaps || []) {
      const m = s.snapshot_date.slice(0, 7);
      if (!byTenant.has(s.tenant_id)) byTenant.set(s.tenant_id, new Map());
      byTenant.get(s.tenant_id).set(m, { mrr: Number(s.mrr) || 0, status: s.status });
    }

    let added = 0, lost = 0;
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const prev = new Date(today.getFullYear(), today.getMonth() - i - 1, 1);
      const pk = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

      for (const [, tm] of byTenant) {
        const c = tm.get(k);
        const b = tm.get(pk);
        const cm = c?.mrr || 0;
        const pm = b?.mrr || 0;
        if (!b && cm > 0) added += cm;
        else if (b && (!c || c.status === 'churned')) lost += pm;
        else if (cm > pm) added += (cm - pm);
        else if (cm < pm) lost += (pm - cm);
      }
    }

    const ratio = lost > 0 ? added / lost : (added > 0 ? null : 0);

    res.json({
      success: true,
      window: 'trailing-3-months',
      mrr_added: Number(added.toFixed(2)),
      mrr_lost: Number(lost.toFixed(2)),
      quick_ratio: ratio !== null ? Number(ratio.toFixed(2)) : null,
      health: ratio === null ? 'insufficient_data'
        : ratio >= 4 ? 'excellent'
        : ratio >= 2 ? 'good'
        : ratio >= 1 ? 'break_even'
        : 'shrinking',
    });
  } catch (err) {
    log.error(`/quick-ratio failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// STRETCH ENHANCEMENT #10 — COHORT RETENTION CURVES
// ----------------------------------------------------------------------------
// GET /api/metrics/cohort-retention
// Returns retention % per signup-cohort at each month-since-signup.
// Standard SaaS triangle table.
// ============================================================================
router.get('/cohort-retention', async (req, res) => {
  try {
    const configs = await _tenantConfigMap(['first_paid_at', 'churned_at']);

    // Each cohort = signup month. Rows = cohorts (YYYY-MM). Columns = months since signup.
    const cohorts = new Map();
    for (const [tid, t] of configs) {
      if (!t.first_paid_at) continue;
      const cohort = String(t.first_paid_at).slice(0, 7);
      if (!cohorts.has(cohort)) cohorts.set(cohort, []);
      cohorts.get(cohort).push({ tenantId: tid, paid: t.first_paid_at, churned: t.churned_at || null });
    }

    const triangle = [];
    for (const [cohort, tenants] of Array.from(cohorts.entries()).sort()) {
      const startSize = tenants.length;
      if (startSize === 0) continue;

      const cohortDate = new Date(cohort + '-01');
      const monthsSince = Math.max(0, Math.floor((Date.now() - cohortDate.getTime()) / (30 * 86400000)));
      const retention = [];

      for (let m = 0; m <= Math.min(monthsSince, 12); m++) {
        const checkDate = new Date(cohortDate);
        checkDate.setMonth(checkDate.getMonth() + m);
        const stillActive = tenants.filter(t => {
          if (!t.churned) return true;
          return new Date(t.churned).getTime() > checkDate.getTime();
        }).length;
        retention.push({
          month: m,
          retained: stillActive,
          pct: startSize > 0 ? Number(((stillActive / startSize) * 100).toFixed(1)) : 0,
        });
      }
      triangle.push({ cohort, starting_size: startSize, retention });
    }

    res.json({ success: true, cohorts: triangle });
  } catch (err) {
    log.error(`/cohort-retention failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// STRETCH ENHANCEMENT #4 — MODULE-LEVEL REVENUE ATTRIBUTION
// ----------------------------------------------------------------------------
// GET /api/metrics/module-attribution
// For each of the 15 modules: % of tenants with it active that retained
// past month 3, vs tenants without it. Identifies which modules drive retention.
// Note: requires tenant_modules table (already exists in onboarding code).
// ============================================================================
router.get('/module-attribution', async (req, res) => {
  try {
    const { data: tenantModules, error: tmErr } = await db
      .from('tenant_modules')
      .select('tenant_id, module_id, enabled');
    if (tmErr) throw tmErr;

    const configs = await _tenantConfigMap(['first_paid_at', 'churned_at']);

    // For each tenant, determine if they retained past 90 days (proxy for "stuck")
    const tenantRetention = new Map();
    for (const [tid, cfg] of configs) {
      if (!cfg.first_paid_at) continue;
      const paid = new Date(cfg.first_paid_at).getTime();
      const churned = cfg.churned_at ? new Date(cfg.churned_at).getTime() : null;
      const cutoff90 = paid + 90 * 86400000;
      // "Retained" if either still active OR churned after the 90-day mark
      const retained = !churned || churned > cutoff90;
      tenantRetention.set(tid, retained);
    }

    // Bucket by module
    const moduleStats = new Map();
    for (const tm of tenantModules || []) {
      if (!tm.enabled) continue;
      if (!tenantRetention.has(tm.tenant_id)) continue;
      const retained = tenantRetention.get(tm.tenant_id);
      if (!moduleStats.has(tm.module_id)) {
        moduleStats.set(tm.module_id, { with: 0, with_retained: 0 });
      }
      const s = moduleStats.get(tm.module_id);
      s.with++;
      if (retained) s.with_retained++;
    }

    // Compute baseline retention (all tenants)
    const allTenants = Array.from(tenantRetention.values());
    const baselineRetention = allTenants.length > 0
      ? allTenants.filter(Boolean).length / allTenants.length
      : 0;

    const attribution = Array.from(moduleStats.entries()).map(([moduleId, s]) => {
      const moduleRetention = s.with > 0 ? s.with_retained / s.with : 0;
      const lift = moduleRetention - baselineRetention;
      return {
        module_id: moduleId,
        tenants_with: s.with,
        retention_pct: Number((moduleRetention * 100).toFixed(1)),
        baseline_retention_pct: Number((baselineRetention * 100).toFixed(1)),
        lift_pct: Number((lift * 100).toFixed(1)),
        signal: s.with < 5 ? 'noisy' : Math.abs(lift) < 0.05 ? 'flat' : lift > 0 ? 'positive' : 'negative',
      };
    }).sort((a, b) => b.lift_pct - a.lift_pct);

    res.json({
      success: true,
      baseline_retention_90d_pct: Number((baselineRetention * 100).toFixed(1)),
      sample_size: allTenants.length,
      confidence: allTenants.length < 5 ? 'low — need 5+ tenants with 90d+ history' : 'medium',
      modules: attribution,
    });
  } catch (err) {
    log.error(`/module-attribution failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// STRETCH ENHANCEMENT #9 — ANONYMOUS BENCHMARKING
// ----------------------------------------------------------------------------
// GET /api/metrics/benchmarks?vertical=
// Returns FGA-wide aggregate stats (median, p25, p75) for the requesting
// tenant's vertical. K-anonymity threshold of 5 tenants — refuses to
// return data if fewer tenants in the bucket. No individual tenant leakage.
// ============================================================================
router.get('/benchmarks', async (req, res) => {
  try {
    // Get requesting tenant's vertical
    const { data: meCfg } = await db
      .from('tenant_config')
      .select('value')
      .eq('tenant_id', req.tenantId)
      .eq('key', 'vertical')
      .maybeSingle();
    const myVertical = (req.query.vertical && String(req.query.vertical))
      || (meCfg && meCfg.value)
      || null;

    if (!myVertical) {
      return res.json({ success: true, vertical: null, message: 'No vertical specified or set in tenant_config' });
    }

    // Fetch all tenants in this vertical
    const { data: peers } = await db
      .from('tenant_config')
      .select('tenant_id, value')
      .eq('key', 'vertical')
      .eq('value', myVertical);

    const peerIds = (peers || []).map(p => p.tenant_id);
    if (peerIds.length < 5) {
      return res.json({
        success: true,
        vertical: myVertical,
        peer_count: peerIds.length,
        message: 'Need 5+ peers in this vertical to release benchmarks (k-anonymity).',
        benchmarks: null,
      });
    }

    // Per-peer: leads this month
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const { data: leadCounts } = await db
      .from('leads')
      .select('tenant_id')
      .in('tenant_id', peerIds)
      .gte('created_at', monthStart);

    const byTenant = new Map();
    for (const l of leadCounts || []) {
      byTenant.set(l.tenant_id, (byTenant.get(l.tenant_id) || 0) + 1);
    }
    const counts = peerIds.map(id => byTenant.get(id) || 0).sort((a, b) => a - b);

    const percentile = (arr, p) => {
      if (!arr.length) return 0;
      const idx = Math.floor((arr.length - 1) * (p / 100));
      return arr[idx];
    };

    res.json({
      success: true,
      vertical: myVertical,
      peer_count: peerIds.length,
      metric: 'leads_this_month',
      benchmarks: {
        p25: percentile(counts, 25),
        median: percentile(counts, 50),
        p75: percentile(counts, 75),
        you: byTenant.get(req.tenantId) || 0,
      },
    });
  } catch (err) {
    log.error(`/benchmarks failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// STRETCH ENHANCEMENT #11 — WHAT-IF SCENARIO MODELING
// ----------------------------------------------------------------------------
// GET /api/metrics/what-if?new_tenants=&new_mrr_per=&churn_pct=&months=
// Pure stateless calculator — projects runway, MRR, and ARR over N months
// under the given assumptions. UI passes its slider values directly.
// ============================================================================
router.get('/what-if', async (req, res) => {
  try {
    const newTenantsPerMonth = Math.max(0, Number(req.query.new_tenants) || 0);
    const mrrPerNewTenant = Math.max(0, Number(req.query.new_mrr_per) || 249);
    const monthlyChurnPct = Math.max(0, Math.min(50, Number(req.query.churn_pct) || 2));
    const monthsAhead = Math.min(36, Math.max(1, Number(req.query.months) || 12));

    // Current MRR + cash balance
    const { data: latestSnap } = await db
      .from('tenant_metrics_snapshots')
      .select('mrr, metadata, snapshot_date, status')
      .eq('status', 'active')
      .order('snapshot_date', { ascending: false })
      .limit(50);

    let currentMrr = 0;
    let cashBalance = null;
    for (const s of latestSnap || []) {
      currentMrr += Number(s.mrr) || 0;
      if (cashBalance === null && s.metadata?.cash_balance != null) {
        cashBalance = Number(s.metadata.cash_balance);
      }
    }

    // 3-month avg burn
    const threeMo = new Date();
    threeMo.setMonth(threeMo.getMonth() - 3);
    const { data: expenses } = await db
      .from('finance_entries')
      .select('amount')
      .eq('entry_type', 'expense')
      .gte('date', threeMo.toISOString().slice(0, 10));
    const avgMonthlyBurn = (expenses || []).reduce((a, e) => a + Number(e.amount), 0) / 3;

    // Project
    const projection = [];
    let projMrr = currentMrr;
    let projCash = cashBalance;
    for (let m = 1; m <= monthsAhead; m++) {
      const newRevenue = newTenantsPerMonth * mrrPerNewTenant;
      const churnedRevenue = projMrr * (monthlyChurnPct / 100);
      projMrr = projMrr + newRevenue - churnedRevenue;
      if (projCash !== null) {
        projCash = projCash + projMrr - avgMonthlyBurn;
      }
      projection.push({
        month: m,
        mrr: Number(projMrr.toFixed(2)),
        arr: Number((projMrr * 12).toFixed(2)),
        cash: projCash !== null ? Number(projCash.toFixed(2)) : null,
      });
    }

    res.json({
      success: true,
      assumptions: { newTenantsPerMonth, mrrPerNewTenant, monthlyChurnPct, monthsAhead },
      starting_mrr: Number(currentMrr.toFixed(2)),
      starting_cash: cashBalance,
      avg_monthly_burn: Number(avgMonthlyBurn.toFixed(2)),
      projection,
    });
  } catch (err) {
    log.error(`/what-if failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// STRETCH ENHANCEMENT #2 — S-CORP ELECTION BREAK-EVEN ANALYZER
// ----------------------------------------------------------------------------
// GET /api/metrics/s-corp-analyzer?year=
//
// Compares current self-employment tax (Schedule C / 1040-SE) vs S-corp
// election (1120-S + W-2 reasonable salary + K-1 distribution).
// Reports whether the election would save $X this year and the break-even
// net-income threshold.
//
// Assumptions (Georgia / 2026 brackets, single filer):
//   - SE tax: 15.3% on first $168,600 of net SE income (12.4% SS + 2.9% Medicare)
//   - Above $168,600: 2.9% Medicare only (+ 0.9% additional Medicare over $200k)
//   - S-corp: pay yourself a "reasonable salary" subject to FICA (15.3%);
//     remaining net income flows through K-1, subject only to income tax.
//   - We assume reasonable salary = 40% of net (IRS doesn't define an exact rule
//     but 40-60% is a defensible midpoint for service-software businesses).
//   - Effective federal income tax rate assumed constant across both methods.
//
// Caveat surfaced in the response: ALWAYS verify with a CPA before electing.
// ============================================================================
router.get('/s-corp-analyzer', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    // YTD net income from the ledger
    const { data: rows, error } = await db
      .from('finance_entries')
      .select('entry_type, amount')
      .gte('date', startDate)
      .lte('date', endDate);
    if (error) throw error;

    let income = 0, expense = 0;
    for (const r of rows || []) {
      const amt = Number(r.amount) || 0;
      if (r.entry_type === 'income') income += amt;
      else if (r.entry_type === 'expense') expense += amt;
    }
    const netIncome = Math.max(0, income - expense);

    const SS_CAP = 168_600;
    const SE_TAX_FULL = 0.153;
    const MEDICARE_ONLY = 0.029;
    const REASONABLE_SALARY_PCT = 0.40;

    // Current (Schedule C) SE tax — applied to 92.35% of net SE income
    const seBase = netIncome * 0.9235;
    let currentSeTax = 0;
    if (seBase <= SS_CAP) {
      currentSeTax = seBase * SE_TAX_FULL;
    } else {
      currentSeTax = SS_CAP * SE_TAX_FULL + (seBase - SS_CAP) * MEDICARE_ONLY;
    }

    // S-corp method: pay W-2 reasonable salary (full FICA), K-1 distribution untaxed by SE
    const reasonableSalary = netIncome * REASONABLE_SALARY_PCT;
    let scorpFicaTax = 0;
    if (reasonableSalary <= SS_CAP) {
      scorpFicaTax = reasonableSalary * SE_TAX_FULL;
    } else {
      scorpFicaTax = SS_CAP * SE_TAX_FULL + (reasonableSalary - SS_CAP) * MEDICARE_ONLY;
    }

    const annualSavings = currentSeTax - scorpFicaTax;

    // S-corp election has hard costs: separate tax return ($800-1500 CPA), payroll service ($600/year)
    const ELECTION_COSTS = 1_400;
    const netSavings = annualSavings - ELECTION_COSTS;

    // Break-even: net income where SE tax savings cover the election overhead.
    // Approx: ELECTION_COSTS / (0.153 * 0.6 * 0.9235) ≈ break-even net income
    const breakEvenNet = ELECTION_COSTS / (SE_TAX_FULL * (1 - REASONABLE_SALARY_PCT) * 0.9235);

    res.json({
      success: true,
      year,
      ytd_net_income: Number(netIncome.toFixed(2)),
      assumptions: {
        reasonable_salary_pct: REASONABLE_SALARY_PCT,
        ss_cap: SS_CAP,
        election_overhead_per_year: ELECTION_COSTS,
      },
      current_se_tax: Number(currentSeTax.toFixed(2)),
      scorp_fica_tax: Number(scorpFicaTax.toFixed(2)),
      gross_annual_savings: Number(annualSavings.toFixed(2)),
      net_annual_savings: Number(netSavings.toFixed(2)),
      break_even_net_income: Number(breakEvenNet.toFixed(0)),
      recommendation: netIncome < breakEvenNet
        ? `Not yet — net income $${Math.round(netIncome).toLocaleString()} is below the $${Math.round(breakEvenNet).toLocaleString()} break-even.`
        : netSavings > 1000
          ? `Likely worth electing — estimated annual savings $${Math.round(netSavings).toLocaleString()}. Confirm with a CPA.`
          : `Borderline. Confirm with a CPA before electing.`,
      disclaimer: 'Estimate only. Tax rules vary by state and personal circumstances. Confirm with a licensed tax professional before electing.',
    });
  } catch (err) {
    log.error(`/s-corp-analyzer failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// SECTION 9.7 — TAX ESTIMATE WIDGET
// ----------------------------------------------------------------------------
// GET /api/metrics/tax-estimate?year=
//
// YTD federal + SE tax estimate. Pulls directly from finance_entries (cash
// basis) and applies 2026 single-filer brackets. Surfaces:
//   - YTD net income (income - expenses, excluding sales tax types)
//   - Federal income tax (estimated)
//   - SE tax (estimated)
//   - Total YTD liability
//   - Quarterly payments already made (from finance_entries with category='Taxes & Fees')
//   - Balance pending
// ============================================================================
router.get('/tax-estimate', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const todayStr = new Date().toISOString().slice(0, 10);

    // Tax estimate is for FGA's OWN tax liability (Patrick's pass-through
    // self-employment income). Client tenants like A Kut Above and WellMor
    // file their own taxes on their own revenue — their finance_entries
    // must NOT roll up into Patrick's estimate. Filter strictly to FGA.
    const FGA_TENANT_ID = '30566ed6-026a-45e1-9502-029e6219df31';
    const { data: rows, error } = await db
      .from('finance_entries')
      .select('entry_type, category, amount, date')
      .eq('tenant_id', FGA_TENANT_ID)
      .gte('date', startDate)
      .lte('date', todayStr);
    if (error) throw error;

    let income = 0, expense = 0, quarterlyPaid = 0;
    for (const r of rows || []) {
      const amt = Number(r.amount) || 0;
      // Sales tax pass-throughs are NOT income/expense for net-income purposes
      if (r.entry_type === 'sales_tax_collected' || r.entry_type === 'sales_tax_remitted') continue;
      // Owner equity flows (Patrick's $1000 seed money etc.) are capital
      // contributions, NOT taxable income or business expense
      if (r.entry_type === 'owner_contribution' || r.entry_type === 'owner_draw') continue;
      if (r.entry_type === 'income') income += amt;
      else if (r.entry_type === 'expense') {
        expense += amt;
        // Estimated quarterly tax payments hide as expenses with category 'Taxes & Fees'
        if (r.category === 'Taxes & Fees') quarterlyPaid += amt;
      }
    }

    const netIncome = Math.max(0, income - expense);

    // 2026 single-filer brackets (federal income tax, ordinary)
    const FEDERAL_BRACKETS = [
      { upTo: 11_600, rate: 0.10 },
      { upTo: 47_150, rate: 0.12 },
      { upTo: 100_525, rate: 0.22 },
      { upTo: 191_950, rate: 0.24 },
      { upTo: 243_725, rate: 0.32 },
      { upTo: 609_350, rate: 0.35 },
      { upTo: Infinity, rate: 0.37 },
    ];
    const STANDARD_DEDUCTION = 14_600;
    const taxable = Math.max(0, netIncome - STANDARD_DEDUCTION);

    let fedTax = 0, remaining = taxable, prevCap = 0;
    for (const b of FEDERAL_BRACKETS) {
      const slice = Math.max(0, Math.min(remaining, b.upTo - prevCap));
      fedTax += slice * b.rate;
      remaining -= slice;
      prevCap = b.upTo;
      if (remaining <= 0) break;
    }

    // SE tax
    const SS_CAP = 168_600;
    const seBase = netIncome * 0.9235;
    let seTax = 0;
    if (seBase <= SS_CAP) seTax = seBase * 0.153;
    else seTax = SS_CAP * 0.153 + (seBase - SS_CAP) * 0.029;

    // Half of SE tax is deductible against income tax — we ignore that simplification
    const totalLiability = fedTax + seTax;
    const balancePending = Math.max(0, totalLiability - quarterlyPaid);

    res.json({
      success: true,
      as_of: todayStr,
      year,
      ytd_income: Number(income.toFixed(2)),
      ytd_expenses: Number(expense.toFixed(2)),
      ytd_net_income: Number(netIncome.toFixed(2)),
      federal_income_tax_est: Number(fedTax.toFixed(2)),
      self_employment_tax_est: Number(seTax.toFixed(2)),
      total_ytd_liability_est: Number(totalLiability.toFixed(2)),
      quarterly_payments_made: Number(quarterlyPaid.toFixed(2)),
      balance_pending: Number(balancePending.toFixed(2)),
      disclaimer: 'Estimates only. Confirm with your CPA before filing or making payments.',
    });
  } catch (err) {
    log.error(`/tax-estimate failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// SECTION 10 — SALES TAX NEXUS MONITOR
// ----------------------------------------------------------------------------
// GET /api/metrics/nexus-status
//
// Per-state revenue YTD + per-state nexus thresholds. Flags any state
// where FGA has crossed 80% of the economic-nexus threshold so Patrick
// can register for that state's sales-tax permit before liability begins.
// ============================================================================
const NEXUS_THRESHOLDS = {
  // Map: state -> { taxable, threshold, txn_alt }
  // taxable: is SaaS taxable in this state
  // threshold: dollars
  // txn_alt: transaction count alternative (null = dollars only)
  AL: { taxable: false, threshold: 250_000 },
  AK: { taxable: false, threshold: 100_000 },
  AZ: { taxable: false, threshold: 100_000 },
  AR: { taxable: false, threshold: 100_000 },
  CA: { taxable: false, threshold: 500_000 },
  CO: { taxable: false, threshold: 100_000 },
  CT: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  DC: { taxable: true,  threshold: 100_000, txn_alt: 200 },
  FL: { taxable: false, threshold: 100_000 },
  GA: { taxable: false, threshold: 100_000 },  // home state — SaaS not taxable
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

router.get('/nexus-status', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getUTCFullYear();
    const startDate = `${year}-01-01`;
    const todayStr = new Date().toISOString().slice(0, 10);

    // Per-client revenue this year, joined to their tax_jurisdiction
    const { data: configs } = await db
      .from('tenant_config')
      .select('tenant_id, key, value')
      .in('key', ['tax_jurisdiction', 'state']);

    const tenantJurisdiction = new Map();
    for (const c of configs || []) {
      if (!tenantJurisdiction.has(c.tenant_id)) tenantJurisdiction.set(c.tenant_id, {});
      tenantJurisdiction.get(c.tenant_id)[c.key] = c.value;
    }

    // For FGA itself, revenue from clients in each state.
    // Source: invoice metadata + tenant client mapping. For simplicity, pull
    // income entries with a customer state hint in metadata, fall back to
    // the tenant's tax_jurisdiction.
    const { data: incomes } = await db
      .from('finance_entries')
      .select('amount, metadata, tenant_id, date')
      .eq('entry_type', 'income')
      .gte('date', startDate)
      .lte('date', todayStr);

    const byState = new Map();
    let untagged = 0;
    for (const r of incomes || []) {
      const meta = r.metadata || {};
      const state = (meta.customer_state || tenantJurisdiction.get(r.tenant_id)?.tax_jurisdiction || tenantJurisdiction.get(r.tenant_id)?.state || 'GA').toUpperCase();
      if (!NEXUS_THRESHOLDS[state]) {
        untagged++;
        continue;
      }
      if (!byState.has(state)) byState.set(state, { revenue: 0, txn_count: 0 });
      const s = byState.get(state);
      s.revenue += Number(r.amount) || 0;
      s.txn_count++;
    }

    const states = Array.from(byState.entries()).map(([state, s]) => {
      const config = NEXUS_THRESHOLDS[state];
      const dollarPct = (s.revenue / config.threshold) * 100;
      const txnPct = config.txn_alt ? (s.txn_count / config.txn_alt) * 100 : 0;
      const highestPct = Math.max(dollarPct, txnPct);
      let status = 'safe';
      if (highestPct >= 100) status = 'crossed';
      else if (highestPct >= 80) status = 'warning';
      else if (highestPct >= 50) status = 'monitoring';

      return {
        state,
        saas_taxable: config.taxable,
        revenue_ytd: Number(s.revenue.toFixed(2)),
        threshold: config.threshold,
        threshold_txn: config.txn_alt || null,
        txn_count: s.txn_count,
        dollar_pct: Number(dollarPct.toFixed(1)),
        txn_pct: Number(txnPct.toFixed(1)),
        status,
        action_required: config.taxable && status !== 'safe',
      };
    }).sort((a, b) => Math.max(b.dollar_pct, b.txn_pct) - Math.max(a.dollar_pct, a.txn_pct));

    res.json({
      success: true,
      year,
      untagged_income_count: untagged,
      states,
      attention_count: states.filter(s => s.action_required).length,
    });
  } catch (err) {
    log.error(`/nexus-status failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
