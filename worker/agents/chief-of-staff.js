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
const { buildOperatingBrief } = require('../../core/executive/operating-brief');

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
    // Same config the guardian and API read. The first version called
    // resolveTenant(tenantId) — the signature is (supabase, tenantId), so it
    // ALWAYS threw, the catch swallowed it, and this reported 25 forever.
    // readDailyTarget is the one shared, tested read.
    const { readDailyTarget } = require('../../core/revenue/daily-outcome');
    const { target, source: targetSource } = await readDailyTarget(db);

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
      target_source: targetSource,
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

  const rows = error ? [] : data || [];
  rows.available = !error;
  return rows;
}

async function getApprovedPending(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('id, platform, body, status, updated_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'approved')
    .order('updated_at', { ascending: false });

  const rows = error ? [] : data || [];
  rows.available = !error;
  return rows;
}

async function getRecentPosts(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('id, platform, body, status, updated_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'posted')
    .order('updated_at', { ascending: false })
    .limit(10);

  const rows = error ? [] : data || [];
  rows.available = !error;
  return rows;
}

async function getLeadStats(tenantId) {
  const { data, error } = await db
    .from('leads')
    .select('status, priority_tier, lifecycle_stage, outreach_ready')
    .eq('tenant_id', tenantId);

  if (error) return { available: false, total: null, outreach_ready: null, by_lifecycle: {}, by_status: {} };

  const leads = data || [];
  return {
    available: true,
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

  if (error) return { available: false, drafts: null, approved: null, posted: null, rejected: null, total: null };

  const items = data || [];
  return {
    available: true,
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

  const rows = error ? [] : data || [];
  rows.available = !error;
  return rows;
}

async function getRecentJobs(tenantId) {
  const { data, error } = await db
    .from('agent_jobs')
    .select('agent_name, status, created_at, completed_at, error')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(10);

  const rows = error ? [] : data || [];
  rows.available = !error;
  return rows;
}

async function getRevenueDepartmentReport(tenantId) {
  const { data, error } = await db.from('activity_log')
    .select('id, metadata, created_at')
    .eq('tenant_id', tenantId)
    .eq('agent', 'revenue-guardian')
    .eq('action', 'revenue_department_report')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return {
    health: 'unknown', reasons: ['department_report_read_failed'],
    contains_contact_data: false,
  };
  return data ? { ...data.metadata, report_receipt_id: data.id, persisted_at: data.created_at } : {
    health: 'unknown', reasons: ['department_report_missing'],
    contains_contact_data: false,
  };
}

async function getRelationshipMoments(tenantId) {
  const { data, error } = await db.from('leads')
    .select('id, company_name, name, status, lifecycle_stage, next_best_action, lead_score, updated_at')
    .eq('tenant_id', tenantId)
    .or('status.in.(replied,interested,demo_booked),lifecycle_stage.in.(interested,sales_call,demo_booked)')
    .order('updated_at', { ascending: false })
    .limit(25);
  if (error) return { available: false, rows: [], warning: 'relationship_moments_read_failed' };
  const rows = (data || []).filter((row) => (
    ['replied', 'interested', 'demo_booked'].includes(row.status)
    || ['interested', 'sales_call', 'demo_booked'].includes(row.lifecycle_stage)
  ));
  return { available: true, rows };
}

async function getOwnerDecisions(tenantId) {
  const { data, error } = await db.from('ops_incidents')
    .select('id, issue_type, severity, business_impact, approval_reason, status, detected_at')
    .eq('tenant_id', tenantId)
    .eq('requires_owner_approval', true)
    .in('status', ['awaiting_approval', 'escalated'])
    .order('detected_at', { ascending: false })
    .limit(20);
  if (error) return { available: false, rows: [], warning: 'owner_decisions_read_failed' };
  return {
    available: true,
    rows: (data || []).map((row) => ({
      ...row,
      type: row.issue_type,
      title: row.business_impact || row.approval_reason || row.issue_type,
    })),
  };
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
    revenueOutcome,
    revenueDepartment,
    relationshipMoments,
    ownerDecisions,
  ] = await Promise.all([
    getPendingApprovals(tenantId),
    getApprovedPending(tenantId),
    getRecentPosts(tenantId),
    getLeadStats(tenantId),
    getContentStats(tenantId),
    getRecentActivity(tenantId),
    getRecentJobs(tenantId),
    getRevenueOutcome(tenantId),
    getRevenueDepartmentReport(tenantId),
    getRelationshipMoments(tenantId),
    getOwnerDecisions(tenantId),
  ]);

  const actionItems = [];

  // Patrick's scarce attention belongs to live prospect relationships first.
  // System throughput and internal queues follow after those moments.
  if (relationshipMoments.rows.length > 0) {
    actionItems.push({
      priority: 'critical',
      type: 'relationship_moment',
      message: `${relationshipMoments.rows.length} warm/replied/demo prospect(s) need a human relationship moment`,
      count: relationshipMoments.rows.length,
    });
  }

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
  if (revenueDepartment && ['unhealthy', 'unknown'].includes(revenueDepartment.health)) {
    actionItems.push({
      priority: 'critical',
      type: 'revenue_department_health',
      message: `Revenue & Sales department is ${revenueDepartment.health}: `
        + (revenueDepartment.reasons || []).join(', '),
      count: (revenueDepartment.reasons || []).length,
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

  const evidenceWarnings = [
    !relationshipMoments.available ? relationshipMoments.warning : null,
    !ownerDecisions.available ? ownerDecisions.warning : null,
    !revenueOutcome ? 'revenue_outcome_read_failed' : null,
    pendingApprovals.available === false ? 'content_approval_read_failed' : null,
    leadStats.available === false ? 'lead_pipeline_read_failed' : null,
    recentJobs.available === false ? 'agent_job_read_failed' : null,
  ].filter(Boolean);
  const decisions = [...ownerDecisions.rows];
  if (pendingApprovals.length > 0) {
    decisions.push({
      id: 'content-approvals',
      type: 'content_approval',
      title: `${pendingApprovals.length} content draft(s) require approval`,
      severity: 'high',
    });
  }
  const operatingBrief = buildOperatingBrief({
    revenueOutcome,
    revenueDepartment,
    relationshipMoments: relationshipMoments.rows,
    ownerDecisions: decisions,
    failedJobs: recentFailures,
    evidenceWarnings,
  });

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
    revenue_outcome: revenueOutcome,
    departments: { revenue_sales: revenueDepartment },
    operating_brief: operatingBrief,
  };
}

// ============================================================================
// DIGEST FORMATTER
// ============================================================================

function formatDigest(briefing, businessName) {
  const now = new Date();
  const operating = briefing.operating_brief;
  const owner = operating.owner_interface;
  const display = (value) => value === null || value === undefined ? 'unverified' : String(value);
  const lines = [
    `${businessName} — Chief of Staff Brief`,
    now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    '',
    operating.headline,
    `Objective: ${operating.objective}`,
    '',
  ];

  lines.push('NEEDS PATRICK');
  if (!owner.relationship_moments.length && !owner.decisions.length) {
    lines.push('  Nothing currently requires your judgment or relationship touch.');
  } else {
    for (const moment of owner.relationship_moments.slice(0, 10)) {
      lines.push(`  [RELATIONSHIP] ${moment.company} · ${moment.stage} · ${moment.next_action}`);
    }
    for (const decision of owner.decisions.slice(0, 10)) {
      lines.push(`  [DECISION] ${decision.title}`);
    }
  }
  lines.push('');

  lines.push('OUTCOMES · LAST 30 DAYS');
  const outcomes = operating.outcomes_30d;
  lines.push(`  Delivered: ${display(outcomes.delivered)} · Human replies: ${display(outcomes.human_reply)} · Warm replies: ${display(outcomes.warm_reply)}`);
  lines.push(`  Owner accepted: ${display(outcomes.owner_accepted)} · Demos booked: ${display(outcomes.demo_booked)} · Demos held: ${display(outcomes.demo_held)}`);
  lines.push(`  Proposals: ${display(outcomes.proposal)} · Won: ${display(outcomes.won)}`);
  lines.push('');

  lines.push('COMPANY COMMITMENTS');
  for (const commitment of owner.commitments) {
    const score = commitment.target == null
      ? display(commitment.actual)
      : `${display(commitment.actual)}/${display(commitment.target)}`;
    lines.push(`  ${commitment.label}: ${score} · ${String(commitment.state).toUpperCase()} · ${commitment.evidence}`);
  }
  lines.push('');

  lines.push('MATERIAL RISKS');
  if (!owner.material_risks.length) {
    lines.push('  No material risk is currently proven.');
  } else {
    for (const risk of owner.material_risks) {
      lines.push(`  [${String(risk.severity).toUpperCase()}] ${risk.message}`);
    }
  }
  lines.push('');

  const department = briefing.departments?.revenue_sales;
  lines.push('DEPARTMENT ACCOUNTABILITY');
  lines.push(`  Revenue & Sales: ${String(operating.department_health).toUpperCase()} · ${department?.plan_key || 'plan unverified'}`);
  lines.push(`  Evidence: ${operating.evidence.revenue_department_verified ? 'verified department report' : 'NOT VERIFIED'}`);

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
      recent_posts: briefing.recent_posts.slice(0, 5),
      operating_brief: briefing.operating_brief,
    };
    log.success('Dashboard data generated');
    return { success: true, type: 'dashboard', dashboard };
  }

  // Default: full briefing
  log.success('Briefing generated', { actions: briefing.action_items.length });
  return { success: true, type: 'briefing', briefing };
}

module.exports = run;
module.exports._internal = {
  buildBriefing,
  formatDigest,
  getRelationshipMoments,
  getOwnerDecisions,
};
