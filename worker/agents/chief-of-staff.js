/**
 * Growth OS — Chief of Staff Agent
 * Provides operational briefings, action items, pipeline stats,
 * and daily digests for tenant owners.
 *
 * Multi-tenant: all queries scoped by tenant_id.
 * Uses Growth OS tables: content_drafts (not content_queue), leads (not clients).
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

// ============================================================================
// DATA FETCHERS (tenant-scoped)
// ============================================================================

/**
 * The revenue invariant, as the Chief of Staff reports it.
 *
 * Codex review 2026-07-25: this agent contained no revenue invariant,
 * incident, or remediation integration at all — the invariant had been wired
 * into the platform digest instead, which is a different agent. A chief of
 * staff whose report omits whether the company's one daily commitment was met
 * is not reporting on the business.
 *
 * Reports the LAST COMPLETED business day, not today. The briefing is built in
 * the morning, when today's count is legitimately zero and says nothing.
 *
 * FGA-internal only: client tenants have no such invariant and get null.
 */
async function getRevenueOutcome(tenantId) {
  const {
    FGA_TENANT_ID, DEFAULTS, countFirstTouchSends, lastCompletedBusinessDay, etParts,
  } = require('../../core/revenue/daily-outcome');
  if (tenantId !== FGA_TENANT_ID) return null;
  try {
    const { traceFunnel } = require('../../core/revenue/funnel-trace');
    const now = new Date();
    const lastDay = lastCompletedBusinessDay(now);
    const target = DEFAULTS.dailyTarget;

    const [closed, today, trace, handoffs] = await Promise.all([
      countFirstTouchSends(db, { date: lastDay, tenantId }),
      countFirstTouchSends(db, { date: now, tenantId }),
      // Two-arg .then rather than .catch: the no-builder-catch guard reads
      // `db`-shaped calls conservatively, and keeping it strict is worth more
      // than the nicer syntax here.
      traceFunnel(db, { date: now, tenantId }).then((t) => t, () => ({ inventory: {}, anomalies: [] })),
      db.from('ops_incidents').select('issue_type, agent_name, verification_result')
        .eq('tenant_id', tenantId).like('issue_type', 'revenue_%')
        .in('status', ['open', 'remediating', 'awaiting_approval']).limit(20)
        .then((r) => r.data || [], () => []),
    ]);

    return {
      target,
      last_business_day: { et_date: closed.etDate, sent: closed.count, met: closed.count >= target },
      today: { et_date: etParts(now).date, sent: today.count },
      ready_to_send: trace.inventory?.sendReady ?? null,
      open_reliability_handoffs: handoffs,
      funnel_anomalies: trace.anomalies || [],
    };
  } catch {
    // Never let reporting failure take the whole briefing down; the absence of
    // the section is itself visible in the digest.
    return null;
  }
}

async function getPendingApprovals(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('id, platform, body, status, created_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'draft')
    .order('created_at', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getApprovedPending(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('id, platform, body, status, updated_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'approved')
    .order('updated_at', { ascending: false });

  if (error) return [];
  return data || [];
}

async function getRecentPosts(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('id, platform, body, status, updated_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'posted')
    .order('updated_at', { ascending: false })
    .limit(10);

  if (error) return [];
  return data || [];
}

async function getLeadStats(tenantId) {
  const { data, error } = await db
    .from('leads')
    .select('status, priority_tier, lifecycle_stage, outreach_ready')
    .eq('tenant_id', tenantId);

  if (error) return { total: 0 };

  const leads = data || [];
  return {
    total: leads.length,
    tier_a: leads.filter(r => r.priority_tier === 'A').length,
    tier_b: leads.filter(r => r.priority_tier === 'B').length,
    tier_c: leads.filter(r => r.priority_tier === 'C').length,
    outreach_ready: leads.filter(r => r.outreach_ready).length,
    by_lifecycle: leads.reduce((acc, r) => {
      const stage = r.lifecycle_stage || 'unknown';
      acc[stage] = (acc[stage] || 0) + 1;
      return acc;
    }, {}),
    by_status: leads.reduce((acc, r) => {
      const status = r.status || 'unknown';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {})
  };
}

async function getContentStats(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('status')
    .eq('tenant_id', tenantId);

  if (error) return {};

  const items = data || [];
  return {
    drafts: items.filter(r => r.status === 'draft').length,
    approved: items.filter(r => r.status === 'approved').length,
    posted: items.filter(r => r.status === 'posted').length,
    rejected: items.filter(r => r.status === 'rejected').length,
    total: items.length
  };
}

async function getRecentActivity(tenantId) {
  const { data, error } = await db
    .from('agent_activity_log')
    .select('agent_name, action, status, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return [];
  return data || [];
}

async function getRecentJobs(tenantId) {
  const { data, error } = await db
    .from('agent_jobs')
    .select('agent_name, status, created_at, completed_at, error')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return [];
  return data || [];
}

// ============================================================================
// BRIEFING BUILDER
// ============================================================================

async function buildBriefing(tenantId) {
  const [
    pendingApprovals,
    approvedPending,
    recentPosts,
    leadStats,
    contentStats,
    recentActivity,
    recentJobs,
    revenueOutcome
  ] = await Promise.all([
    getPendingApprovals(tenantId),
    getApprovedPending(tenantId),
    getRecentPosts(tenantId),
    getLeadStats(tenantId),
    getContentStats(tenantId),
    getRecentActivity(tenantId),
    getRecentJobs(tenantId),
    getRevenueOutcome(tenantId)
  ]);

  const actionItems = [];

  // The daily revenue commitment leads the action list when it was missed.
  // Nothing else in this briefing outranks "we sent no sales email yesterday".
  if (revenueOutcome && !revenueOutcome.last_business_day.met) {
    const { sent } = revenueOutcome.last_business_day;
    actionItems.push({
      priority: 'critical',
      type: 'revenue_outcome_missed',
      message: `${sent}/${revenueOutcome.target} first-touch emails sent on `
        + `${revenueOutcome.last_business_day.et_date}`
        + (revenueOutcome.ready_to_send
          ? ` — ${revenueOutcome.ready_to_send} draft(s) were ready to send`
          : ''),
      count: revenueOutcome.target - sent
    });
  }
  if (revenueOutcome && revenueOutcome.open_reliability_handoffs.length > 0) {
    actionItems.push({
      priority: 'critical',
      type: 'revenue_reliability_handoff',
      message: `${revenueOutcome.open_reliability_handoffs.length} open reliability handoff(s) `
        + 'blocking outbound sales',
      count: revenueOutcome.open_reliability_handoffs.length
    });
  }

  if (pendingApprovals.length > 0) {
    actionItems.push({
      priority: 'high',
      type: 'approval',
      message: `${pendingApprovals.length} post(s) waiting for approval`,
      count: pendingApprovals.length
    });
  }

  if (approvedPending.length > 0) {
    actionItems.push({
      priority: 'medium',
      type: 'publish',
      message: `${approvedPending.length} approved post(s) ready to publish`,
      count: approvedPending.length
    });
  }

  if (leadStats.outreach_ready > 0) {
    actionItems.push({
      priority: 'high',
      type: 'outreach',
      message: `${leadStats.outreach_ready} lead(s) ready for outreach`,
      count: leadStats.outreach_ready
    });
  }

  const interestedCount = leadStats.by_status?.interested || 0;
  if (interestedCount > 0) {
    actionItems.push({
      priority: 'high',
      type: 'follow_up',
      message: `${interestedCount} interested lead(s) need follow-up`,
      count: interestedCount
    });
  }

  // Check for failed jobs in last 24h
  const recentFailures = recentJobs.filter(j => j.status === 'failed');
  if (recentFailures.length > 0) {
    actionItems.push({
      priority: 'medium',
      type: 'system',
      message: `${recentFailures.length} agent job(s) failed recently`,
      count: recentFailures.length
    });
  }

  return {
    timestamp: new Date().toISOString(),
    action_items: actionItems,
    pending_approvals: pendingApprovals,
    approved_pending: approvedPending,
    recent_posts: recentPosts,
    stats: {
      content: contentStats,
      leads: leadStats
    },
    recent_activity: recentActivity,
    recent_jobs: recentJobs,
    revenue_outcome: revenueOutcome
  };
}

// ============================================================================
// DIGEST FORMATTER
// ============================================================================

function formatDigest(briefing, businessName) {
  const s = briefing.stats;
  const now = new Date();
  const lines = [
    `${businessName} Daily Digest — ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`,
    ''
  ];

  // The daily revenue commitment, first — before content, before anything.
  // Reported for the last COMPLETED business day, because a digest built in
  // the morning knows nothing about today yet.
  const rev = briefing.revenue_outcome;
  if (rev) {
    const d = rev.last_business_day;
    lines.push('DAILY REVENUE OUTCOME:');
    lines.push(`  ${d.et_date}: ${d.sent}/${rev.target} first-touch emails — ${d.met ? 'MET' : 'MISSED'}`);
    if (!d.met && rev.ready_to_send != null) {
      lines.push(`  ${rev.ready_to_send} draft(s) were ready to send, so supply was not the cause.`);
    }
    if (rev.open_reliability_handoffs.length) {
      lines.push(`  ${rev.open_reliability_handoffs.length} open reliability handoff(s):`);
      for (const h of rev.open_reliability_handoffs) {
        lines.push(`    - ${h.agent_name}: ${h.issue_type} (${h.verification_result || 'pending'})`);
      }
    }
    if (rev.funnel_anomalies.length) {
      lines.push(`  Funnel evidence is inconsistent (${rev.funnel_anomalies.length} anomaly) — treat counts with care.`);
    }
    lines.push(`  Today so far: ${rev.today.sent}/${rev.target}`);
    lines.push('');
  }

  // Action items
  if (briefing.action_items.length > 0) {
    lines.push('ACTION ITEMS:');
    for (const item of briefing.action_items) {
      const icon = item.priority === 'critical' ? '[!!]' : item.priority === 'high' ? '[!]' : '[-]';
      lines.push(`  ${icon} ${item.message}`);
    }
    lines.push('');
  } else {
    lines.push('No urgent action items today.', '');
  }

  // Content queue
  lines.push('CONTENT QUEUE:');
  lines.push(`  Drafts pending: ${s.content.drafts || 0}`);
  lines.push(`  Approved (ready): ${s.content.approved || 0}`);
  lines.push(`  Posted: ${s.content.posted || 0}`);
  lines.push(`  Rejected: ${s.content.rejected || 0}`);
  lines.push('');

  // Lead pipeline
  lines.push('LEAD PIPELINE:');
  lines.push(`  Total: ${s.leads.total} | Tier A: ${s.leads.tier_a} | Tier B: ${s.leads.tier_b} | Tier C: ${s.leads.tier_c}`);
  lines.push(`  Outreach Ready: ${s.leads.outreach_ready}`);
  if (s.leads.by_lifecycle) {
    const stages = Object.entries(s.leads.by_lifecycle).map(([k, v]) => `${k}: ${v}`).join(', ');
    lines.push(`  Lifecycle: ${stages}`);
  }
  lines.push('');

  // Recent activity
  if (briefing.recent_activity.length > 0) {
    lines.push('RECENT AGENT ACTIVITY (last 5):');
    for (const a of briefing.recent_activity.slice(0, 5)) {
      const time = new Date(a.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      lines.push(`  ${time} — ${a.agent_name}: ${a.action} (${a.status})`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// MAIN AGENT
// ============================================================================

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { type: 'briefing' | 'digest' | 'dashboard' }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('chief-of-staff', tenant.slug);
  const type = payload.type || 'briefing';

  log.info(`Building ${type}`);

  const briefing = await buildBriefing(tenant.id);

  if (type === 'digest') {
    const businessName = getConfig(tenant, 'business_name', tenant.name || 'Your Business');
    const digest = formatDigest(briefing, businessName);
    log.success('Digest generated');
    return { success: true, type: 'digest', digest, briefing };
  }

  if (type === 'dashboard') {
    const dashboard = {
      pending_count: briefing.pending_approvals.length,
      approved_count: briefing.stats.content.approved || 0,
      posted_count: briefing.stats.content.posted || 0,
      total_leads: briefing.stats.leads.total,
      tier_a_leads: briefing.stats.leads.tier_a,
      outreach_ready: briefing.stats.leads.outreach_ready,
      action_items: briefing.action_items,
      pending_approvals: briefing.pending_approvals.slice(0, 5),
      recent_posts: briefing.recent_posts.slice(0, 5)
    };
    log.success('Dashboard data generated');
    return { success: true, type: 'dashboard', dashboard };
  }

  // Default: full briefing
  log.success('Briefing generated', { actions: briefing.action_items.length });
  return { success: true, type: 'briefing', briefing };
}

module.exports = run;
