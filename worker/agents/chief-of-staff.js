/**
 * Growth OS — Chief of Staff Agent
 * Provides operational briefings, action items, pipeline stats,
 * and daily digests for tenant owners.
 *
 * Multi-tenant: all queries scoped by tenant_id.
 * Uses Growth OS tables: content_drafts (not content_queue), leads (not clients).
 */

const { createLogger } = require('../../core/logger');
const { getConfig, FGA_TENANT_ID } = require('../../core/config');
const { db } = require('../../db/client');
const { buildOperatingBrief } = require('../../core/executive/operating-brief');
const { isSyntheticGrowthLead } = require('../../core/growth/production-evidence');
const { recoveryBacklogCount, recoveryBudgetProgress } = require('../../core/growth/orchestrator');
const { CREATIVE_VERSION } = require('../../core/growth/message-experiment');

const CANONICAL_DEPARTMENTS = Object.freeze([
  'reliability_security_agent_ops',
  'revenue_sales',
  'onboarding_implementation',
  'client_success_support',
  'finance_data_governance',
  'marketing_brand',
  'product_engineering',
]);

function requireEvidenceRead(receipt, name) {
  if (!receipt || receipt.error) {
    const detail = receipt?.error?.message || 'unavailable';
    throw new Error(`${name}_read_failed:${detail}`);
  }
  return receipt.data;
}

function acceptedCurrentCohortStarts(candidates = [], sequences = []) {
  const sequenceById = new Map((sequences || []).map((row) => [row.id, row]));
  const acceptedByLead = new Map();
  for (const candidate of candidates || []) {
    const sequence = sequenceById.get(candidate.first_touch_sequence_id);
    if (!sequence || sequence.lead_id !== candidate.lead_id) continue;
    if (!['sent', 'sending'].includes(sequence.sequence_status)) continue;
    if (!sequence.metadata?.delivered?.provider_id) continue;
    if (!acceptedByLead.has(candidate.lead_id)) {
      acceptedByLead.set(candidate.lead_id, {
        lead_id: candidate.lead_id,
        sequence_id: candidate.first_touch_sequence_id,
      });
    }
  }
  return [...acceptedByLead.values()];
}

function summarizeCurrentCohort(candidates = [], sequences = [], events = []) {
  const cutoffByLead = new Map();
  for (const candidate of candidates || []) {
    if (!candidate?.lead_id) continue;
    const existing = cutoffByLead.get(candidate.lead_id);
    if (!existing || new Date(candidate.authorized_at || 0) < new Date(existing)) {
      cutoffByLead.set(candidate.lead_id, candidate.authorized_at || null);
    }
  }
  const cohortLeadIds = new Set(cutoffByLead.keys());
  const accepted = new Set(acceptedCurrentCohortStarts(candidates, sequences)
    .map((row) => row.lead_id));

  const stages = {
    delivered: new Set(), human_reply: new Set(), warm_reply: new Set(),
    owner_accepted: new Set(), demo_booked: new Set(),
  };
  for (const event of events || []) {
    if (!cohortLeadIds.has(event.lead_id)) continue;
    const cutoff = cutoffByLead.get(event.lead_id);
    if (cutoff && event.occurred_at && new Date(event.occurred_at) < new Date(cutoff)) continue;
    if (event.stage === 'delivered') stages.delivered.add(event.lead_id);
    if (event.stage === 'human_reply') stages.human_reply.add(event.lead_id);
    if (event.stage === 'warm') {
      stages.human_reply.add(event.lead_id);
      stages.warm_reply.add(event.lead_id);
    }
    if (event.stage === 'owner_accepted') stages.owner_accepted.add(event.lead_id);
    if (event.event_type === 'demo_booked') stages.demo_booked.add(event.lead_id);
  }

  return {
    size: cohortLeadIds.size,
    provider_accepted: accepted.size,
    delivered: stages.delivered.size,
    human_reply: stages.human_reply.size,
    warm_reply: stages.warm_reply.size,
    owner_accepted: stages.owner_accepted.size,
    demo_booked: stages.demo_booked.size,
  };
}

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
    FGA_TENANT_ID, countQualifiedSequenceStarts, lastCompletedBusinessDay, etParts,
    expectedByNow, readEmployeeEvidenceForStarts,
  } = require('../../core/revenue/daily-outcome');
  const { PLAN_KEY } = require('../../core/growth/seven-touch-plan');
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

    const { data: restartBatch, error: restartBatchError } = await db
      .from('growth_restart_batches').select('id, created_at')
      .eq('tenant_id', tenantId).eq('status', 'completed')
      .eq('sequence_plan_key', PLAN_KEY)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (restartBatchError) throw restartBatchError;
    const batchId = restartBatch?.id || '__no_current_restart_batch__';

    const [
      closed, today, trace, handoffs, cohortCandidates,
      activeSequences, recoveryJob, sendConfig, creativeDrafts,
    ] = await Promise.all([
      countQualifiedSequenceStarts(db, { date: lastDay, tenantId }),
      countQualifiedSequenceStarts(db, { date: now, tenantId }),
      // Wrap rejection as a required evidence receipt. A failed funnel read
      // must invalidate the Revenue section; it cannot become an empty,
      // apparently anomaly-free funnel in Patrick's brief.
      traceFunnel(db, { date: now, tenantId })
        .then((data) => ({ data, error: null }), (error) => ({ data: null, error })),
      db.from('ops_incidents').select('issue_type, agent_name, verification_result')
        .eq('tenant_id', tenantId).like('issue_type', 'revenue_%')
        .in('status', ['open', 'remediating', 'awaiting_approval']).limit(20),
      db.from('growth_restart_candidates')
        .select('lead_id, first_touch_sequence_id, authorized_at, first_touch_sent_at')
        .eq('tenant_id', tenantId).eq('batch_id', batchId).eq('decision', 'eligible')
        .not('authorized_at', 'is', null).limit(100),
      db.from('drip_enrollments').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).in('status', ['active', 'paused', 'review']),
      db.from('agent_jobs').select('status, result, completed_at')
        .eq('tenant_id', tenantId).eq('agent_name', 'sequence-recovery')
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('tenant_config').select('key, value')
        .eq('tenant_id', tenantId)
        .in('key', ['autonomous_outreach_enabled', 'autosend_paused', 'drip_sends_paused']),
      db.from('outreach_sequences').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('sequence_status', 'draft')
        .contains('metadata', { creative_version: CREATIVE_VERSION }),
    ]);
    const verifiedTrace = requireEvidenceRead(trace, 'revenue_funnel');
    const verifiedHandoffs = requireEvidenceRead(handoffs, 'revenue_handoffs') || [];
    if (cohortCandidates.error) throw cohortCandidates.error;
    if (activeSequences.error) throw activeSequences.error;
    if (recoveryJob.error) throw recoveryJob.error;
    if (sendConfig.error) throw sendConfig.error;
    if (creativeDrafts.error) throw creativeDrafts.error;
    const candidates = cohortCandidates.data || [];
    const sequenceIds = [...new Set(candidates.map((row) => row.first_touch_sequence_id).filter(Boolean))];
    const leadIds = [...new Set(candidates.map((row) => row.lead_id).filter(Boolean))];
    const [cohortSequences, cohortEvents] = await Promise.all([
      sequenceIds.length
        ? db.from('outreach_sequences').select('id, lead_id, sequence_status, metadata')
          .eq('tenant_id', tenantId).in('id', sequenceIds).limit(100)
        : Promise.resolve({ data: [], error: null }),
      leadIds.length && restartBatch?.created_at
        ? db.from('growth_events').select('lead_id, event_type, stage, occurred_at')
          .eq('tenant_id', tenantId).in('lead_id', leadIds)
          .gte('occurred_at', restartBatch.created_at).order('occurred_at', { ascending: true }).limit(1000)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (cohortSequences.error) throw cohortSequences.error;
    if (cohortEvents.error) throw cohortEvents.error;
    const currentAcceptedStarts = acceptedCurrentCohortStarts(candidates, cohortSequences.data || []);
    const currentCohort = summarizeCurrentCohort(candidates, cohortSequences.data || [], cohortEvents.data || []);
    const { readDeliveryLifecycle } = require('../../core/revenue/delivery-lifecycle');
    const [todayDeliveryLifecycle, todayEmployeeEvidence, currentCohortEmployeeEvidence] = await Promise.all([
      readDeliveryLifecycle(db, {
        starts: today.prospects,
        tenantId,
      }),
      readEmployeeEvidenceForStarts(db, {
        starts: today.prospects,
        tenantId,
      }),
      readEmployeeEvidenceForStarts(db, {
        starts: currentAcceptedStarts,
        tenantId,
      }),
    ]);
    currentCohort.employee_evidence = currentCohortEmployeeEvidence;
    const authorizedRemainingCount = candidates.filter((row) => !row.first_touch_sent_at).length;
    const recoveryResult = recoveryJob.data?.status === 'completed' ? recoveryJob.data.result || {} : null;
    const recoveryBacklog = recoveryBacklogCount(recoveryResult);
    const recoveryProgress = recoveryBudgetProgress(recoveryResult);
    const controls = Object.fromEntries((sendConfig.data || []).map((row) => [row.key, String(row.value)]));

    return {
      target,
      target_source: targetSource,
      last_business_day: {
        et_date: closed.etDate, sent: closed.count,
        first_touch: closed.firstTouchCount, restarted: closed.restartCount,
        met: closed.count >= target,
      },
      today: {
        et_date: etParts(now).date,
        sent: today.count,
        first_touch: today.firstTouchCount,
        restarted: today.restartCount,
        expected_by_now: expectedByNow(target, now),
        delivery_lifecycle: todayDeliveryLifecycle,
        employee_evidence: todayEmployeeEvidence,
      },
      restart_cohort: {
        plan_key: PLAN_KEY,
        authorized_remaining: authorizedRemainingCount,
        provider_accepted: currentCohort.provider_accepted,
      },
      current_cohort: currentCohort,
      sequence_continuity: {
        active: activeSequences.count || 0,
        eligible_remaining: recoveryBacklog,
        last_recovery_at: recoveryJob.data?.completed_at || null,
        recovered_today: recoveryProgress.recovered_today,
        daily_limit: recoveryProgress.daily_limit,
        remaining_today: recoveryProgress.remaining_today,
      },
      ready_to_send: verifiedTrace.inventory?.sendReady ?? null,
      open_reliability_handoffs: verifiedHandoffs,
      funnel_anomalies: verifiedTrace.anomalies || [],
      controls: {
        autonomous_outreach_enabled: controls.autonomous_outreach_enabled === 'true',
        first_touch_paused: controls.autosend_paused === 'true',
        followups_paused: controls.drip_sends_paused === 'true',
      },
      creative: {
        version: CREATIVE_VERSION,
        drafts: creativeDrafts.count || 0,
      },
    };
  } catch {
    // Never let reporting failure take the whole briefing down; the absence of
    // the section is itself visible in the digest.
    return null;
  }
}

async function getDepartmentCoverage(tenantId) {
  const { data, error } = await db.from('department_reports')
    .select('department, report_state, outcome_health, updated_at')
    .eq('tenant_id', tenantId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) return { available: false, departments: [] };
  const latest = new Map();
  for (const row of data || []) {
    if (CANONICAL_DEPARTMENTS.includes(row.department) && !latest.has(row.department)) {
      latest.set(row.department, row);
    }
  }
  return {
    available: true,
    departments: CANONICAL_DEPARTMENTS.map((department) => {
      const report = latest.get(department);
      return {
        department,
        report_state: report?.report_state || 'missing',
        outcome_health: report?.outcome_health || 'unknown',
        updated_at: report?.updated_at || null,
        source: report ? 'formal_department_report' : 'evidence_period_gated',
      };
    }),
  };
}

function summarizeDepartmentCoverage(coverage, revenueDepartment) {
  const departments = Array.isArray(coverage?.departments)
    ? coverage.departments.map((row) => ({ ...row })) : [];
  const revenueVerified = Boolean(
    revenueDepartment?.schema_version >= 2
    && revenueDepartment?.health
    && revenueDepartment.health !== 'unknown',
  );
  if (revenueVerified) {
    const existing = departments.find((row) => row.department === 'revenue_sales');
    if (existing && existing.report_state !== 'accepted') {
      existing.report_state = 'operational';
      existing.outcome_health = revenueDepartment.health;
      existing.source = 'live_revenue_guardian_report';
      existing.updated_at = revenueDepartment.persisted_at || existing.updated_at || null;
    } else if (!existing) {
      departments.push({
        department: 'revenue_sales', report_state: 'operational',
        outcome_health: revenueDepartment.health, updated_at: revenueDepartment.persisted_at || null,
        source: 'live_revenue_guardian_report',
      });
    }
  }
  const formallyAccepted = departments.filter((row) => row.report_state === 'accepted').length;
  const live = new Set(departments
    .filter((row) => ['accepted', 'operational'].includes(row.report_state))
    .map((row) => row.department)).size;
  return {
    total_heads: CANONICAL_DEPARTMENTS.length,
    live_operating_reports: live,
    formally_accepted_reports: formallyAccepted,
    evidence_gated: Math.max(0, CANONICAL_DEPARTMENTS.length - live),
    departments,
  };
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
    .select('id, email, lead_source, metadata, status, priority_tier, lifecycle_stage, outreach_ready')
    .eq('tenant_id', tenantId);

  if (error) return { available: false, total: null, outreach_ready: null, by_lifecycle: {}, by_status: {} };

  const leads = (data || []).filter((lead) => !isSyntheticGrowthLead(lead));
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
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('agent_jobs')
    .select('agent_name, status, payload, created_at, completed_at, error')
    .eq('tenant_id', tenantId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(250);

  const rows = error ? [] : data || [];
  rows.available = !error;
  return rows;
}

function excludeQuarantinedIntakeFailures(jobs, leads) {
  const quarantined = new Set((leads || [])
    .filter((lead) => lead.metadata?.intake_safety?.contact_allowed === false)
    .map((lead) => lead.id));
  return (jobs || []).filter((job) => {
    // A paused draft-refresh job explicitly reconciled after a deployment is
    // retained as failed execution history, but the replacement cohort owns
    // the next action. It must not continue posing as owner work.
    if (job.error === 'deployment_interrupted_during_paused_draft_refresh') return false;
    const leadId = job.payload?.lead_id;
    return !leadId || !quarantined.has(leadId);
  });
}

function executionAttemptKey(job = {}) {
  const payload = job.payload || {};
  const scope = payload.lead_id
    ? `lead:${payload.lead_id}`
    : payload.task
      ? `task:${payload.task}`
      : payload.action
        ? `action:${payload.action}`
        : 'agent';
  return `${job.agent_name || 'unknown'}:${scope}`;
}

function excludeRecoveredExecutionFailures(jobs = []) {
  const latestSuccess = new Map();
  for (const job of jobs) {
    if (job.status !== 'completed') continue;
    const observedAt = Date.parse(job.completed_at || job.created_at || '');
    if (!Number.isFinite(observedAt)) continue;
    const key = executionAttemptKey(job);
    latestSuccess.set(key, Math.max(latestSuccess.get(key) || 0, observedAt));
  }
  return jobs.filter((job) => {
    if (job.status !== 'failed') return false;
    const failedAt = Date.parse(job.completed_at || job.created_at || '');
    const recoveredAt = latestSuccess.get(executionAttemptKey(job)) || 0;
    return !Number.isFinite(failedAt) || recoveredAt <= failedAt;
  });
}

async function getActionableRecentFailures(tenantId, failedJobs) {
  const leadIds = [...new Set((failedJobs || []).map((job) => job.payload?.lead_id).filter(Boolean))];
  if (!leadIds.length) return { available: true, rows: failedJobs || [] };
  const { data, error } = await db.from('leads')
    .select('id, metadata')
    .eq('tenant_id', tenantId)
    .in('id', leadIds)
    .limit(250);
  if (error) return { available: false, rows: failedJobs || [] };
  return { available: true, rows: excludeQuarantinedIntakeFailures(failedJobs, data || []) };
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

async function getGrowthEngineSnapshot(tenantId) {
  const { data, error } = await db.from('growth_engine_snapshots')
    .select('funnel, next_actions, alerts, snapshot_at')
    .eq('tenant_id', tenantId)
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { available: false, snapshot: null, warning: 'growth_snapshot_read_failed' };
  if (!data) return { available: false, snapshot: null, warning: 'growth_snapshot_missing' };
  return { available: true, snapshot: data, warning: null };
}

async function getRelationshipMoments(tenantId) {
  const { data, error } = await db.from('leads')
    .select('id, company_name, name, email, lead_source, metadata, status, lifecycle_stage, next_best_action, lead_score, updated_at')
    .eq('tenant_id', tenantId)
    .or('status.in.(replied,interested,demo_booked),lifecycle_stage.in.(interested,sales_call,demo_booked)')
    .order('updated_at', { ascending: false })
    .limit(25);
  if (error) return { available: false, rows: [], warning: 'relationship_moments_read_failed' };
  const rows = (data || []).filter((row) => !isSyntheticGrowthLead(row)).filter((row) => (
    ['replied', 'interested', 'demo_booked'].includes(row.status)
    || ['interested', 'sales_call', 'demo_booked'].includes(row.lifecycle_stage)
  ));
  return { available: true, rows };
}

function ownerDecisionTitle(row = {}) {
  const agent = row.agent_name || 'System';
  const impact = row.business_impact || row.approval_reason || row.issue_type || 'Owner decision required';
  return `${agent}: ${impact}`;
}

async function getOwnerDecisions(tenantId) {
  const { data, error } = await db.from('ops_incidents')
    .select('id, agent_name, issue_type, severity, business_impact, approval_reason, status, detected_at')
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
      title: ownerDecisionTitle(row),
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
    growthSnapshot,
    departmentCoverage,
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
    getGrowthEngineSnapshot(tenantId),
    getDepartmentCoverage(tenantId),
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
      message: `${sent}/${revenueOutcome.target} qualified prospect sequences started on `
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
      message: `${revenueOutcome.open_reliability_handoffs.length} Revenue-to-Reliability handoff(s) `
        + 'remain open and require evidence-based closure',
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

  // `outreach_ready` is autonomous system inventory, not work for Patrick.
  // The old brief put hundreds of ready records in his action queue even
  // though the Growth Engine owns them. Current-plan and department evidence
  // report that inventory without manufacturing an owner task.

  const interestedCount = leadStats.by_status?.interested || 0;
  if (interestedCount > 0) {
    actionItems.push({
      priority: 'high',
      type: 'follow_up',
      message: `${interestedCount} interested lead(s) need follow-up`,
      count: interestedCount
    });
  }

  // Check the bounded 24-hour window, excluding failures whose exact lead is
  // now proven to be quarantined automated intake. History stays visible in
  // recent_jobs; it simply stops posing as an unresolved business risk.
  const failureCandidates = tenantId === FGA_TENANT_ID
    ? excludeRecoveredExecutionFailures(recentJobs)
    : recentJobs.filter(job => job.status === 'failed');
  const actionableFailures = await getActionableRecentFailures(
    tenantId,
    failureCandidates,
  );
  const recentFailures = actionableFailures.rows;
  if (recentFailures.length > 0) {
    const byAgent = recentFailures.reduce((counts, job) => {
      const agent = job.agent_name || 'unknown';
      counts[agent] = (counts[agent] || 0) + 1;
      return counts;
    }, {});
    const summary = Object.entries(byAgent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([agent, count]) => `${agent} ${count}`)
      .join(', ');
    actionItems.push({
      priority: 'high',
      type: 'system',
      message: `${recentFailures.length} agent job(s) failed in 24h${summary ? ` — ${summary}` : ''}`,
      count: recentFailures.length
    });
  }

  const evidenceWarnings = [
    !relationshipMoments.available ? relationshipMoments.warning : null,
    !ownerDecisions.available ? ownerDecisions.warning : null,
    !revenueOutcome ? 'revenue_outcome_read_failed' : null,
    revenueDepartment?.health === 'unknown'
      ? (revenueDepartment.reasons?.[0] || 'revenue_department_report_unavailable')
      : null,
    pendingApprovals.available === false ? 'content_approval_read_failed' : null,
    approvedPending.available === false ? 'approved_content_read_failed' : null,
    recentPosts.available === false ? 'recent_posts_read_failed' : null,
    contentStats.available === false ? 'content_stats_read_failed' : null,
    leadStats.available === false ? 'lead_pipeline_read_failed' : null,
    recentActivity.available === false ? 'agent_activity_read_failed' : null,
    recentJobs.available === false ? 'agent_job_read_failed' : null,
    !actionableFailures.available ? 'agent_failure_scope_read_failed' : null,
    !growthSnapshot.available ? growthSnapshot.warning : null,
    !departmentCoverage.available ? 'department_coverage_read_failed' : null,
  ].filter(Boolean);
  const decisions = [...ownerDecisions.rows];
  const otherApprovals = [];
  if (pendingApprovals.length > 0) {
    otherApprovals.push({
      id: 'content-approvals',
      type: 'content_approval',
      title: `${pendingApprovals.length} content draft(s) require approval`,
      count: pendingApprovals.length,
      link: '/admin/content',
    });
  }
  const operatingBrief = buildOperatingBrief({
    revenueOutcome,
    revenueDepartment,
    relationshipMoments: relationshipMoments.rows,
    ownerDecisions: decisions,
    otherApprovals,
    failedJobs: recentFailures,
    evidenceWarnings,
    growthSnapshot: growthSnapshot.snapshot,
    departmentCoverage: summarizeDepartmentCoverage(departmentCoverage, revenueDepartment),
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
    departments: {
      revenue_sales: revenueDepartment,
      coverage: operatingBrief.department_coverage,
    },
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
    now.toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric',
    }),
    '',
    operating.headline,
    `Objective: ${operating.objective}`,
    '',
  ];

  lines.push('TODAY\'S SALES OUTCOME');
  const plan = operating.current_plan || {};
  lines.push(`  ${display(plan.provider_accepted_today)}/${display(plan.target_today)} provider-accepted sequence starts · ${String(plan.state || 'unknown').toUpperCase()}`);
  if (plan.delivery_lifecycle?.available) {
    const lifecycle = plan.delivery_lifecycle;
    lines.push(`  Delivery evidence: ${display(lifecycle.delivered)} delivered · ${display(lifecycle.delayed)} delayed · ${display(lifecycle.suppressed)} suppressed · ${display(lifecycle.bounced)} bounced · ${display(lifecycle.complained)} complained · ${display(lifecycle.failed)} failed · ${display(lifecycle.unknown)} unknown`);
  } else if (Number(plan.provider_accepted_today) > 0) {
    lines.push('  Delivery evidence: UNAVAILABLE — provider acceptance must not be treated as delivery.');
  }
  if (plan.first_touch_today !== null || plan.restarted_today !== null) {
    lines.push(`  Mix: ${display(plan.first_touch_today)} first contacts · ${display(plan.restarted_today)} reviewed restarts`);
  }
  if (Number(plan.provider_accepted_today) > 0) {
    const employee = plan.employee_evidence;
    if (employee?.available) {
      lines.push(`  Employee-size evidence: ${display(employee.source_confirmed)} source-confirmed · ${display(employee.estimated)} explicitly estimated · ${display(employee.sweet_spot_1_9)} in 1–9 · ${display(employee.accepted_10_19)} in 10–19 · ${display(employee.outside_policy)} outside policy`);
    } else {
      lines.push('  Employee-size evidence: UNAVAILABLE — accepted sends must not be described as source-confirmed.');
    }
  }
  if (plan.creative_version) {
    lines.push(`  ${display(plan.conversation_first_drafts)} verified reply-first draft(s) · ${plan.creative_version}`);
  }
  if (plan.followup_recovery_daily_limit !== null && plan.followup_recovery_daily_limit !== undefined) {
    lines.push(`  Seven-touch recovery: ${display(plan.followup_recovered_today)}/${display(plan.followup_recovery_daily_limit)} safely admitted today · ${display(plan.followup_recovery_remaining)} remain`);
  }
  const planCheckpoint = plan.next_checkpoint;
  lines.push(planCheckpoint
    ? `  Next: ${planCheckpoint.label} · owned by ${planCheckpoint.owner}`
    : '  Next: unverified — Revenue evidence could not name a checkpoint.');
  lines.push('');

  lines.push('PATH TO A DEMO');
  for (const stage of operating.path_to_demo || []) {
    const score = stage.target == null ? display(stage.actual) : `${display(stage.actual)}/${display(stage.target)}`;
    lines.push(`  ${stage.label}: ${score} · ${String(stage.state).toUpperCase()} · ${stage.owner}`);
  }
  lines.push('');

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

  lines.push('AUTONOMOUS WORK NOW');
  const agentWork = Array.isArray(operating.agent_owned_work) ? operating.agent_owned_work : [];
  for (const work of agentWork.slice(0, 5)) {
    lines.push(`  [${String(work.owner).toUpperCase()}] ${work.label}`);
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

  if (owner.other_approvals?.length) {
    lines.push('OTHER APPROVALS · NOT BLOCKING THE DEMO PATH');
    for (const approval of owner.other_approvals.slice(0, 10)) {
      lines.push(`  ${approval.title}`);
    }
    lines.push('');
  }

  const department = briefing.departments?.revenue_sales;
  lines.push('DEPARTMENT ACCOUNTABILITY');
  lines.push(`  Revenue & Sales: ${String(operating.department_health).toUpperCase()} · ${department?.plan_key || 'plan unverified'}`);
  lines.push(`  Evidence: ${operating.evidence.revenue_department_verified ? 'verified department report' : 'NOT VERIFIED'}`);
  const coverage = operating.department_coverage;
  lines.push(`  Coverage: ${display(coverage?.live_operating_reports)}/${display(coverage?.total_heads)} live · ${display(coverage?.formally_accepted_reports)} formally accepted · ${display(coverage?.evidence_gated)} evidence-gated`);

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
  getGrowthEngineSnapshot,
  getDepartmentCoverage,
  summarizeDepartmentCoverage,
  acceptedCurrentCohortStarts,
  summarizeCurrentCohort,
  requireEvidenceRead,
  ownerDecisionTitle,
  excludeQuarantinedIntakeFailures,
  executionAttemptKey,
  excludeRecoveredExecutionFailures,
};
