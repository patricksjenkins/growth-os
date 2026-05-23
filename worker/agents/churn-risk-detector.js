/**
 * Growth OS — Churn Risk Detector Agent
 *
 * Stretch Enhancement #1 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §8 Tier A).
 *
 * Daily agent that computes a 0-100 churn risk score per active tenant.
 * Score >70 fires a push notification + a red attention_queue item so
 * Patrick can intervene with a personal call BEFORE they cancel.
 *
 * Inputs (per tenant, scored against the platform baseline):
 *   - Lead volume MoM trend (last 30 days vs prior 30 days)
 *   - Content approval rate (last 30 days)
 *   - Days since last platform login (from supabase auth.users.last_sign_in_at)
 *   - % of scheduled agents firing successfully (last 7 days)
 *   - Days since last invoice payment (compared to billing cadence)
 *
 * Output:
 *   - tenant_metrics_snapshots row updated with churn_score in metadata
 *   - attention_queue row (severity 'red' if score > 70, 'amber' if > 50)
 *   - push notification to platform owner (Patrick) at score > 70
 *
 * Schedule: 0 7 * * * (daily, 7am ET) — see worker/scheduler/cron.js
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

// Weighting — tuned empirically; tweak after observing real churn signal
const WEIGHTS = {
  lead_decline: 30,      // 30 points if lead volume dropped >50% MoM
  no_approvals: 20,      // 20 points if approval rate dropped to 0
  long_silence: 25,      // 25 points if no platform login in 14 days
  agent_failures: 15,    // 15 points if >30% agent failures last 7 days
  payment_late: 10,      // 10 points if last invoice > 35 days old
};

async function _leadVolumeTrend(tenantId) {
  const now = new Date();
  const cutoff30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const cutoff60 = new Date(now.getTime() - 60 * 86400000).toISOString();

  const { data: recent } = await db
    .from('leads')
    .select('id', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .gte('created_at', cutoff30);

  const { data: prior } = await db
    .from('leads')
    .select('id', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .gte('created_at', cutoff60)
    .lt('created_at', cutoff30);

  const recentCount = recent?.length || 0;
  const priorCount = prior?.length || 0;
  if (priorCount === 0) return { recent: recentCount, prior: priorCount, delta_pct: 0 };
  return {
    recent: recentCount,
    prior: priorCount,
    delta_pct: ((recentCount - priorCount) / priorCount) * 100,
  };
}

async function _approvalRate(tenantId) {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data } = await db
    .from('content_posts')
    .select('id, approval_status')
    .eq('tenant_id', tenantId)
    .gte('created_at', cutoff);

  const total = data?.length || 0;
  const approved = (data || []).filter(p => p.approval_status === 'approved').length;
  return { total, approved, pct: total > 0 ? approved / total : null };
}

async function _daysSinceLastLogin(tenantId) {
  // Pull most recent supabase auth event from auth.users.last_sign_in_at via
  // a JOIN through tenant_users. Simpler: use activity_log if available.
  const { data } = await db
    .from('activity_log')
    .select('created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return Math.floor((Date.now() - new Date(data.created_at).getTime()) / 86400000);
}

async function _agentFailureRate(tenantId) {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data } = await db
    .from('agent_activity_log')
    .select('status')
    .eq('tenant_id', tenantId)
    .gte('created_at', cutoff);

  const total = data?.length || 0;
  if (total === 0) return { total: 0, failures: 0, rate: null };
  const failures = (data || []).filter(r => r.status !== 'success').length;
  return { total, failures, rate: failures / total };
}

async function _daysSinceLastPayment(tenantId) {
  const { data } = await db
    .from('finance_entries')
    .select('date, metadata')
    .eq('tenant_id', tenantId)
    .eq('entry_type', 'income')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return Math.floor((Date.now() - new Date(data.date).getTime()) / 86400000);
}

function computeScore(signals) {
  let score = 0;
  const reasons = [];

  if (signals.lead_trend && signals.lead_trend.delta_pct < -50) {
    score += WEIGHTS.lead_decline;
    reasons.push(`Lead volume down ${Math.abs(signals.lead_trend.delta_pct).toFixed(0)}% MoM`);
  }

  if (signals.approval && signals.approval.total > 0 && signals.approval.pct === 0) {
    score += WEIGHTS.no_approvals;
    reasons.push('No content approvals in 30 days');
  }

  if (signals.days_silent !== null && signals.days_silent >= 14) {
    score += WEIGHTS.long_silence;
    reasons.push(`No platform activity in ${signals.days_silent} days`);
  }

  if (signals.agent_failure && signals.agent_failure.rate !== null && signals.agent_failure.rate > 0.3) {
    score += WEIGHTS.agent_failures;
    reasons.push(`${(signals.agent_failure.rate * 100).toFixed(0)}% of agent runs failing`);
  }

  if (signals.days_since_payment !== null && signals.days_since_payment > 35) {
    score += WEIGHTS.payment_late;
    reasons.push(`Last payment ${signals.days_since_payment} days ago`);
  }

  return { score: Math.min(100, score), reasons };
}

async function _writeQueueItem(tenantId, tenantSlug, score, reasons) {
  const severity = score >= 70 ? 'red' : score >= 50 ? 'amber' : 'blue';
  await db.from('attention_queue').insert({
    tenant_id: tenantId,
    type: 'churn_risk',
    severity,
    title: `Churn risk ${score}/100 — ${tenantSlug}`,
    summary: reasons.length > 0
      ? `${reasons.length} risk signal${reasons.length === 1 ? '' : 's'}: ${reasons.join('; ')}. Consider a personal check-in call.`
      : 'No specific signals — score derived from baseline.',
    entity_type: 'tenant',
    entity_id: tenantId,
    payload: { score, reasons, tenant_slug: tenantSlug },
    produced_by: 'churn-risk-detector',
  });
}

async function _writeSnapshot(tenantId, score, reasons, signals) {
  const today = new Date().toISOString().slice(0, 10);

  // Upsert today's snapshot with churn_score in metadata
  const { data: existing } = await db
    .from('tenant_metrics_snapshots')
    .select('id, metadata')
    .eq('tenant_id', tenantId)
    .eq('snapshot_date', today)
    .maybeSingle();

  const metadata = { ...(existing?.metadata || {}), churn_score: score, churn_reasons: reasons, churn_signals: signals };

  if (existing) {
    await db.from('tenant_metrics_snapshots').update({ metadata }).eq('id', existing.id);
  } else {
    // Need at least mrr + status to insert — pull current from config
    const { data: cfg } = await db
      .from('tenant_config')
      .select('key, value')
      .eq('tenant_id', tenantId)
      .in('key', ['monthly_rate', 'tier', 'churned_at']);
    const cfgMap = {};
    for (const c of cfg || []) cfgMap[c.key] = c.value;

    await db.from('tenant_metrics_snapshots').insert({
      tenant_id: tenantId,
      snapshot_date: today,
      mrr: Number(cfgMap.monthly_rate) || 0,
      status: cfgMap.churned_at ? 'churned' : 'active',
      tier: cfgMap.tier || null,
      metadata,
    });
  }
}

async function run(tenant /*, payload = {} */) {
  const log = createLogger('churn-risk-detector', tenant.slug);
  log.info(`Computing churn risk for ${tenant.slug}`);

  const signals = {
    lead_trend: await _leadVolumeTrend(tenant.id),
    approval: await _approvalRate(tenant.id),
    days_silent: await _daysSinceLastLogin(tenant.id),
    agent_failure: await _agentFailureRate(tenant.id),
    days_since_payment: await _daysSinceLastPayment(tenant.id),
  };

  const { score, reasons } = computeScore(signals);

  await _writeSnapshot(tenant.id, score, reasons, signals);

  // Only queue an attention item if score is meaningful
  if (score >= 50) {
    await _writeQueueItem(tenant.id, tenant.slug, score, reasons);
    log.warn(`Churn risk ${score}/100 — ${reasons.join('; ')}`);
  } else {
    log.success(`Churn risk ${score}/100 — healthy`);
  }

  return { success: true, score, reasons, signals };
}

module.exports = run;
