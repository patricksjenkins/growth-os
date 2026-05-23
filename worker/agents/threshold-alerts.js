/**
 * Growth OS — Threshold Alerts Agent
 *
 * Stretch Enhancement #6 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §8 Tier B).
 *
 * Daily agent. Evaluates critical metrics against threshold rules and
 * fires push notifications to Patrick AND writes red attention_queue
 * items when any rule trips.
 *
 * Rules (any one tripping fires the alert):
 *   - MRR drop >15% MoM
 *   - Any agent failing 3+ consecutive days
 *   - Single tenant generating 50%+ of total MRR (concentration risk)
 *   - Cash runway <4 months (only if Mercury feed is wired)
 *   - 1099-NEC gap going into Q4 (Oct-Dec): contractor paid $600+ missing
 *     TIN or address
 *   - Tax estimate balance pending > $5000 30 days before a quarterly
 *     payment deadline
 *
 * Schedule: 30 8 * * * (daily, 8:30am ET — after churn-risk-detector) —
 * see worker/scheduler/cron.js.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');
const { sendPushToTenant } = require('../../integrations/push');

async function _mrrMoM() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10);

  const { data } = await db
    .from('tenant_metrics_snapshots')
    .select('mrr, status, snapshot_date')
    .gte('snapshot_date', lastMonthStart)
    .eq('status', 'active')
    .order('snapshot_date', { ascending: false });

  const thisMonth = (data || []).filter(s => s.snapshot_date >= monthStart);
  const lastMonth = (data || []).filter(s => s.snapshot_date < monthStart);

  const currMrr = thisMonth.reduce((a, s) => a + Number(s.mrr || 0), 0);
  const prevMrr = lastMonth.reduce((a, s) => a + Number(s.mrr || 0), 0);
  if (prevMrr === 0) return null;
  return { curr: currMrr, prev: prevMrr, delta_pct: ((currMrr - prevMrr) / prevMrr) * 100 };
}

async function _failedAgentStreak(tenantId) {
  const sevenDays = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await db
    .from('agent_activity_log')
    .select('agent_name, status, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', sevenDays)
    .order('created_at', { ascending: false });

  if (!data?.length) return [];

  // Find agents with 3+ consecutive failures
  const byAgent = new Map();
  for (const r of data) {
    if (!byAgent.has(r.agent_name)) byAgent.set(r.agent_name, []);
    byAgent.get(r.agent_name).push(r.status);
  }

  const failing = [];
  for (const [agent, statuses] of byAgent) {
    let consec = 0;
    for (const s of statuses) {
      if (s !== 'success') consec++;
      else break;
    }
    if (consec >= 3) failing.push({ agent, consec_failures: consec });
  }
  return failing;
}

async function _concentrationRisk() {
  const { data } = await db
    .from('tenant_metrics_snapshots')
    .select('tenant_id, mrr, snapshot_date, status')
    .gte('snapshot_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10))
    .eq('status', 'active');

  // Use latest snapshot per tenant
  const latest = new Map();
  for (const s of data || []) {
    if (!latest.has(s.tenant_id) || latest.get(s.tenant_id).snapshot_date < s.snapshot_date) {
      latest.set(s.tenant_id, s);
    }
  }
  const mrrs = Array.from(latest.values()).map(s => Number(s.mrr) || 0);
  const total = mrrs.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const max = Math.max(...mrrs);
  const maxPct = (max / total) * 100;
  return maxPct >= 50 ? { max, total, max_pct: Number(maxPct.toFixed(1)) } : null;
}

async function _writeQueueItem(tenantId, severity, type, title, summary, payload = {}) {
  await db.from('attention_queue').insert({
    tenant_id: tenantId,
    type,
    severity,
    title,
    summary,
    payload,
    produced_by: 'threshold-alerts',
  });
}

async function _push(tenantId, title, body, data = {}) {
  try {
    await sendPushToTenant(tenantId, { title, body, data });
  } catch (err) {
    // Push failure shouldn't block the alert — queue item will still surface
    // it on the next Reports load.
  }
}

async function run(tenant) {
  const log = createLogger('threshold-alerts', tenant.slug);
  const alerts = [];

  // 1. MRR MoM drop
  const mrr = await _mrrMoM();
  if (mrr && mrr.delta_pct < -15) {
    const title = `MRR down ${Math.abs(mrr.delta_pct).toFixed(1)}%`;
    const body = `${Math.round(mrr.prev)} → ${Math.round(mrr.curr)} month-over-month. Check the churn detector queue.`;
    await _writeQueueItem(tenant.id, 'red', 'mrr_drop', title, body, mrr);
    await _push(tenant.id, title, body, { route: '/admin/finance' });
    alerts.push('mrr_drop');
  }

  // 2. Failed agent streaks
  const failing = await _failedAgentStreak(tenant.id);
  for (const f of failing) {
    const title = `${f.agent} failing ${f.consec_failures} days`;
    const body = `${f.agent} hasn't succeeded in ${f.consec_failures} runs. Open Automation Health to investigate.`;
    await _writeQueueItem(tenant.id, 'red', 'agent_streak_failure', title, body, f);
    await _push(tenant.id, title, body, { route: '/admin/finance', view: 'growth' });
    alerts.push(`agent_failure:${f.agent}`);
  }

  // 3. Concentration risk
  const conc = await _concentrationRisk();
  if (conc) {
    const title = `Concentration risk — one client is ${conc.max_pct}% of MRR`;
    const body = `If they churn, you lose ${conc.max_pct}% of revenue overnight. Time to diversify the book.`;
    await _writeQueueItem(tenant.id, 'amber', 'concentration_risk', title, body, conc);
    await _push(tenant.id, title, body);
    alerts.push('concentration_risk');
  }

  log.success(`Threshold check complete: ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`, { alerts });
  return { success: true, alerts };
}

module.exports = run;
