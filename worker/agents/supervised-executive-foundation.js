/**
 * FGA supervised executive foundation.
 *
 * Produces one completed-day Reliability report and one evidence-conservative
 * Revenue report. It is exact-cohort, FGA-only, idempotent by UTC day, and has
 * no provider, customer-contact, publishing, financial, or production-change
 * capability. Revenue is intentionally reported as unverified until the
 * canonical funnel contains outcome evidence.
 */

'use strict';

const crypto = require('node:crypto');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const { isPlatformTenant } = require('../../core/tenant-email-identity');
const {
  planReliabilityHeadReport,
  stableJson,
} = require('../../core/departments/reliability-head-planner');
const {
  planRevenueCharterRegistration,
  planRevenueReportAcceptance,
} = require('../../core/revenue/department-head-planner');

const QUALIFIED_STATUSES = new Set([
  'qualified', 'appointment_booked', 'appointment_held',
  'proposal_sent', 'won', 'lost', 'closed_won', 'closed_lost',
]);
const OWNER_ROLES = [
  'owner', 'platform_owner', 'founder', 'admin',
  'client_owner', 'tenant_owner',
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deterministicUuid(value) {
  const bytes = Buffer.from(sha256(value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function completedUtcDay(now = new Date()) {
  const end = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const start = new Date(end.getTime() - 86_400_000);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    startDate: start.toISOString().slice(0, 10),
    endDate: start.toISOString().slice(0, 10),
    dayKey: start.toISOString().slice(0, 10),
  };
}

async function exactCount(query, label) {
  const { count, error } = await query;
  if (error) throw new Error(`${label}_count_failed:${error.code || 'unknown'}`);
  return Number(count || 0);
}

function reliabilityRpcArgs(plan) {
  return {
    p_tenant_id: plan.tenantId,
    p_report_id: plan.reportId,
    p_report_type: plan.reportType,
    p_period_start: plan.periodStart,
    p_period_end: plan.periodEnd,
    p_execution_health_state: plan.executionHealthState,
    p_outcome_health_state: plan.outcomeHealthState,
    p_outcome_verified: plan.outcomeVerified,
    p_kpi_results: plan.kpiResults,
    p_report_body: plan.reportBody,
    p_evidence: plan.evidence,
    p_idempotency_key: plan.idempotencyKey,
    p_request_fingerprint: plan.requestFingerprint,
    p_actor_type: plan.actorType,
    p_actor_id: plan.actorId,
    p_authority_tier: plan.authorityTier,
    p_expected_control_revision: plan.expectedControlRevision,
    p_feature_gate_enabled: true,
  };
}

async function createReliabilityReport(db, tenant, period) {
  const { data: control, error: controlError } = await db
    .from('reliability_head_controls')
    .select(
      'revision, enabled, execution_mode, kill_switch_engaged, ' +
      'department_head_id'
    )
    .eq('tenant_id', tenant.id)
    .single();
  if (controlError) throw controlError;
  if (!control.enabled || control.kill_switch_engaged) {
    return { skipped: true, reason: 'reliability_control_inactive' };
  }

  const [jobs, failedJobs, outcomes, achievedOutcomes] = await Promise.all([
    exactCount(
      db.from('agent_jobs').select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .gte('created_at', period.startIso)
        .lt('created_at', period.endIso),
      'agent_jobs',
    ),
    exactCount(
      db.from('agent_jobs').select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('status', 'failed')
        .gte('created_at', period.startIso)
        .lt('created_at', period.endIso),
      'failed_agent_jobs',
    ),
    exactCount(
      db.from('agent_job_outcomes').select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .gte('observed_at', period.startIso)
        .lt('observed_at', period.endIso),
      'agent_job_outcomes',
    ),
    exactCount(
      db.from('agent_job_outcomes').select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id)
        .eq('business_outcome_state', 'achieved')
        .gte('observed_at', period.startIso)
        .lt('observed_at', period.endIso),
      'achieved_agent_outcomes',
    ),
  ]);

  const reportBody = {
    schema_version: 1,
    period: period.dayKey,
    execution: { jobs, failed_jobs: failedJobs },
    outcomes: { recorded: outcomes, achieved: achievedOutcomes },
    customer_outreach_permitted: false,
  };
  const evidence = {
    source_type: 'production_aggregate',
    source_id: `agent-operations:${period.dayKey}`,
    observed_at: period.endIso,
  };
  const kpiResults = [
    {
      kpi_key: 'agent_business_outcome_rate',
      verification_state: outcomes > 0 ? 'unverified' : 'unknown',
      value_bps: outcomes > 0
        ? Math.floor(achievedOutcomes * 10000 / outcomes)
        : null,
      evidence_ref: `agent_job_outcomes:${period.dayKey}`,
    },
    {
      kpi_key: 'audit_evidence_completeness',
      verification_state: jobs > 0 && outcomes === jobs ? 'verified' : 'unverified',
      value_bps: jobs > 0 ? Math.floor(outcomes * 10000 / jobs) : null,
      evidence_ref: `agent_jobs:${period.dayKey}`,
    },
  ];
  const fingerprintInput = {
    tenant_id: tenant.id,
    report_body: reportBody,
    evidence,
    kpi_results: kpiResults,
  };
  const plan = planReliabilityHeadReport({
    tenantId: tenant.id,
    reportId: deterministicUuid(`reliability:${tenant.id}:${period.dayKey}`),
    reportType: 'agent_operations',
    periodStart: period.startIso,
    periodEnd: period.endIso,
    executionHealthState: failedJobs > 0 ? 'degraded' : 'healthy',
    outcomeHealthState: outcomes > 0 ? 'degraded' : 'unproven',
    outcomeVerified: false,
    kpiResults,
    reportBody,
    evidence,
    actorType: 'agent',
    actorId: control.department_head_id,
    authorityTier: 'department_head',
    expectedControlRevision: Number(control.revision),
    featureGateEnabled: true,
    idempotencyKey: `reliability-agent-operations-${period.dayKey}`,
    requestFingerprint: sha256(stableJson(fingerprintInput)),
  });
  const { data, error } = await db.rpc(
    'reliability_head_report_rpc',
    reliabilityRpcArgs(plan),
  );
  if (error) throw error;
  return {
    outcome: data?.outcome || 'unknown',
    execution_health: plan.executionHealthState,
    outcome_health: plan.outcomeHealthState,
    jobs,
    outcomes,
  };
}

async function ownerIdForTenant(db, tenantId) {
  const { data, error } = await db
    .from('tenant_users')
    .select('user_id, role')
    .eq('tenant_id', tenantId)
    .in('role', OWNER_ROLES)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data?.user_id) throw new Error('revenue_owner_membership_missing');
  return data.user_id;
}

async function createRevenueReport(db, tenant, period) {
  const { data: control, error: controlError } = await db
    .from('revenue_head_controls')
    .select('enabled, execution_mode, kill_switch_engaged')
    .eq('tenant_id', tenant.id)
    .single();
  if (controlError) throw controlError;
  if (!control.enabled || control.kill_switch_engaged) {
    return { skipped: true, reason: 'revenue_control_inactive' };
  }

  const ownerId = await ownerIdForTenant(db, tenant.id);

  /*
   * REGISTER THE CHARTER ONCE, NOT EVERY RUN.
   *
   * The charter is an immutable declaration under a fixed idempotency key
   * ('fga-revenue-charter-v1'), but its evidence carried
   * `observed_at: period.endIso` — a value that MOVES every run. The RPC
   * compares the stored evidence against the submitted evidence and raises
   * 23505 revenue_head_charter_idempotency_conflict when they differ, so the
   * first run registered it (2026-07-24 22:06) and every run since failed by
   * construction. Four consecutive failures, escalated to the owner daily,
   * for a charter that was already correctly registered.
   *
   * Idempotency here means "safe to retry with the SAME payload", not "call
   * daily with fresh evidence". If the charter for this key already exists,
   * there is nothing to do. (2026-07-29.)
   */
  const { data: existingCharter } = await db.from('revenue_head_charters')
    .select('id, version')
    .eq('tenant_id', tenant.id)
    .eq('idempotency_key', 'fga-revenue-charter-v1')
    .maybeSingle();

  const charterEvidence = {
    schema_version: 1,
    sources: [{
      source_type: 'owner_activation',
      source_id: 'fga-revenue-charter-v1',
      evidence_digest: sha256('fga-revenue-charter-v1'),
      observed_at: period.endIso,
    }],
  };
  const charterPlan = planRevenueCharterRegistration({
    tenantId: tenant.id,
    version: 1,
    mission: 'Own evidence-backed revenue health, surface material exceptions, and coordinate accountable follow-through without customer outreach.',
    targets: {
      qualificationRateBps: 5000,
      appointmentRateBps: 6000,
      heldRateBps: 8000,
      proposalRateBps: 7000,
      winRateBps: 3000,
      maxSalesCycleDays: 30,
    },
    actorId: ownerId,
    evidence: charterEvidence,
    idempotencyKey: 'fga-revenue-charter-v1',
  });
  let charterResult = existingCharter || null;
  if (!existingCharter) {
    const { data, error: charterError } = await db.rpc(
      charterPlan.rpc,
      { ...charterPlan.args, p_feature_gate_enabled: true },
    );
    if (charterError) throw charterError;
    charterResult = data;
    log.info('Revenue head charter registered (first run for this tenant)');
  }
  const charterId = charterResult?.charter?.id;
  if (!charterId) throw new Error('revenue_charter_identity_missing');

  const { data: leads, error: leadsError } = await db
    .from('leads')
    .select('status')
    .eq('tenant_id', tenant.id)
    .gte('created_at', period.startIso)
    .lt('created_at', period.endIso)
    .limit(10000);
  if (leadsError) throw leadsError;
  const leadsCreated = leads?.length || 0;
  const qualifiedLeads = (leads || []).filter(
    lead => QUALIFIED_STATUSES.has(String(lead.status || '').toLowerCase()),
  ).length;
  const metrics = {
    leadsCreated,
    qualifiedLeads,
    appointmentsBooked: 0,
    appointmentsHeld: 0,
    proposalsSent: 0,
    closedWon: 0,
    closedLost: 0,
    openPipelineMinor: 0,
    bookedRevenueMinor: 0,
    averageSalesCycleDays: 0,
  };
  const evidence = {
    schema_version: 1,
    sources: [{
      source_type: 'lead_status_aggregate',
      source_id: `leads:${period.dayKey}`,
      evidence_digest: sha256(stableJson(metrics)),
      observed_at: period.endIso,
    }],
  };
  const reportPlan = planRevenueReportAcceptance({
    tenantId: tenant.id,
    charterId,
    reportId: deterministicUuid(`revenue:${tenant.id}:${period.dayKey}`),
    periodStart: period.startDate,
    periodEnd: period.endDate,
    sourceSystem: 'growth_os',
    sourceReportId: `revenue-day:${period.dayKey}`,
    metrics,
    currency: 'USD',
    evidence,
    idempotencyKey: `revenue-report-${period.dayKey}`,
  });
  const { data: reportResult, error: reportError } = await db.rpc(
    reportPlan.rpc,
    { ...reportPlan.args, p_feature_gate_enabled: true },
  );
  if (reportError) throw reportError;
  return {
    outcome: reportResult?.outcome || 'unknown',
    funnel_health: reportResult?.report?.funnel_health || 'unverified',
    business_effect_state:
      reportResult?.report?.business_effect_state || 'unverified',
    leads_created: leadsCreated,
    qualified_leads: qualifiedLeads,
  };
}

async function run(tenant, payload = {}) {
  const log = createLogger('supervised-executive-foundation', tenant?.slug);
  if (!isPlatformTenant(tenant)) {
    return { success: true, skipped: true, reason: 'not_platform_tenant' };
  }
  if (
    !flags.departmentHeads()
    || !flags.departmentHeadWrites()
    || !tenantInCohort(
      tenant.id,
      'FGA_OS_DEPARTMENT_HEAD_WRITE_TENANT_ALLOWLIST',
    )
  ) {
    return { success: true, skipped: true, reason: 'write_cohort_inactive' };
  }

  const db = payload.db || getServiceClient();
  const period = completedUtcDay(
    payload.now ? new Date(payload.now) : new Date(),
  );
  const reliability = await createReliabilityReport(db, tenant, period);
  const revenue = await createRevenueReport(db, tenant, period);
  log.info('Supervised executive foundation reports complete', {
    period: period.dayKey,
    reliability: reliability.outcome,
    revenue: revenue.outcome,
  });
  return {
    success: true,
    execution_mode: 'supervised_read_only',
    customer_outreach_permitted: false,
    period: period.dayKey,
    reliability,
    revenue,
  };
}

module.exports = run;
module.exports._internal = {
  completedUtcDay,
  deterministicUuid,
  reliabilityRpcArgs,
  sha256,
};
