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
const { getServiceClient, fetchAllRows } = require('../../db/client');
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
const {
  planDepartmentReportCommand,
} = require('../../core/executive/chief-of-staff-planner');
const {
  listReportContractDefinitions,
  reportContractDefinition,
} = require('../../core/departments/report-contracts');
const { etParts, etDayRangeIso } = require('../../core/revenue/daily-outcome');
const { isSyntheticGrowthLead } = require('../../core/growth/production-evidence');

const STATUS_STAGE = Object.freeze({
  contacted: 1,
  replied: 2,
  interested: 2,
  appointment_booked: 3,
  demo_booked: 3,
  appointment_held: 4,
  demo_held: 4,
  proposal_sent: 5,
  quoted: 5,
  trial_active: 5,
  won: 6,
  closed_won: 6,
});
const LIFECYCLE_STAGE = Object.freeze({
  scored: 1,
  qualified: 1,
  sequenced: 1,
  replied: 2,
  engaged: 2,
  interested: 2,
  sales_call: 2,
  appointment_booked: 3,
  demo_booked: 3,
  appointment_held: 4,
  demo_held: 4,
  proposal_sent: 5,
  quoted: 5,
  trial_active: 5,
  won: 6,
  closed_won: 6,
});
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

function completedEtDay(now = new Date()) {
  const currentEtDate = etParts(now).date;
  const prior = new Date(`${currentEtDate}T12:00:00.000Z`);
  prior.setUTCDate(prior.getUTCDate() - 1);
  const dayKey = prior.toISOString().slice(0, 10);
  const { startIso, endIso } = etDayRangeIso(dayKey);
  return {
    startIso,
    endIso,
    startDate: dayKey,
    endDate: dayKey,
    dayKey,
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
    report_id: plan.reportId,
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

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function revenueStage(lead = {}) {
  return Math.max(
    STATUS_STAGE[String(lead.status || '').toLowerCase()] || 0,
    LIFECYCLE_STAGE[String(lead.lifecycle_stage || '').toLowerCase()] || 0,
  );
}

/**
 * The formal Revenue Head schema requires a monotonic funnel. Build it from
 * one exact, cumulative lead cohort so downstream stages can never be compared
 * with an unrelated "leads created yesterday" denominator. Lost/disqualified
 * rows are deliberately excluded from closedLost: the legacy lead record does
 * not prove that a proposal preceded the loss.
 */
function buildCumulativeRevenueMetrics(leads = []) {
  const rows = Array.isArray(leads) ? leads : [];
  const reached = threshold => rows.filter(lead => revenueStage(lead) >= threshold);
  const won = reached(6);
  const cycleDays = won.map((lead) => {
    const start = Date.parse(lead.date_of_inquiry || lead.created_at || '');
    const end = Date.parse(lead.updated_at || '');
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? (end - start) / 86_400_000
      : null;
  }).filter(Number.isFinite);
  const averageSalesCycleDays = cycleDays.length
    ? Number((cycleDays.reduce((sum, value) => sum + value, 0) / cycleDays.length).toFixed(3))
    : 0;
  return {
    leadsCreated: rows.length,
    qualifiedLeads: reached(1).length,
    appointmentsBooked: reached(3).length,
    appointmentsHeld: reached(4).length,
    proposalsSent: reached(5).length,
    closedWon: won.length,
    closedLost: 0,
    openPipelineMinor: reached(1)
      .filter(lead => revenueStage(lead) < 6)
      .reduce((sum, lead) => sum + cents(lead.estimate_amount), 0),
    bookedRevenueMinor: won.reduce(
      (sum, lead) => sum + cents(lead.final_revenue),
      0,
    ),
    averageSalesCycleDays,
  };
}

const PROSPECT_SOURCES = new Set([
  'prospecting_agent', 'targeted_campaign_agent', 'manual',
]);

/**
 * Build a strict, cumulative funnel from append-only Growth evidence.
 * A later status never implies an earlier milestone: a win only counts in the
 * formal funnel when the same lead has explicit qualification, booking, held,
 * proposal and won evidence. This deliberately leaves legacy wins unproven.
 */
function buildCanonicalRevenueMetrics({ leads = [], events = [] } = {}) {
  const prospects = leads.filter((lead) => (
    PROSPECT_SOURCES.has(String(lead.lead_source || ''))
    && !isSyntheticGrowthLead(lead)
  ));
  const prospectIds = new Set(prospects.map(lead => lead.id));
  const byLead = new Map();
  for (const event of events) {
    if (!prospectIds.has(event.lead_id)) continue;
    if (!byLead.has(event.lead_id)) byLead.set(event.lead_id, []);
    byLead.get(event.lead_id).push(event);
  }
  const hasStage = (leadId, stage) => (byLead.get(leadId) || []).some(
    event => event.stage === stage,
  );
  const hasEvent = (leadId, type) => (byLead.get(leadId) || []).some(
    event => event.event_type === type,
  );

  const qualified = prospects.filter(lead => hasStage(lead.id, 'qualified'));
  const appointmentsBooked = qualified.filter(lead => hasEvent(lead.id, 'demo_booked'));
  const appointmentsHeld = appointmentsBooked.filter(lead => hasStage(lead.id, 'demo_held'));
  const proposalsSent = appointmentsHeld.filter(lead => hasStage(lead.id, 'proposal'));
  const closedWon = proposalsSent.filter(lead => hasStage(lead.id, 'won'));
  const closedLost = proposalsSent.filter(lead => hasEvent(lead.id, 'closed_lost_owner_verified'));
  const wonIds = new Set(closedWon.map(lead => lead.id));
  const cycleDays = closedWon.map((lead) => {
    const start = Date.parse(lead.date_of_inquiry || lead.created_at || '');
    const wonEvent = (byLead.get(lead.id) || [])
      .filter(event => event.stage === 'won')
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))[0];
    const end = Date.parse(wonEvent?.occurred_at || '');
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? (end - start) / 86_400_000
      : null;
  }).filter(Number.isFinite);

  return {
    leadsCreated: prospects.length,
    qualifiedLeads: qualified.length,
    appointmentsBooked: appointmentsBooked.length,
    appointmentsHeld: appointmentsHeld.length,
    proposalsSent: proposalsSent.length,
    closedWon: closedWon.length,
    closedLost: closedLost.length,
    openPipelineMinor: qualified
      .filter(lead => !wonIds.has(lead.id))
      .reduce((sum, lead) => sum + cents(lead.estimate_amount), 0),
    bookedRevenueMinor: closedWon.reduce(
      (sum, lead) => sum + cents(lead.final_revenue),
      0,
    ),
    averageSalesCycleDays: cycleDays.length
      ? Number((cycleDays.reduce((sum, value) => sum + value, 0) / cycleDays.length).toFixed(3))
      : 0,
  };
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

  const { data: existingReport, error: existingReportError } = await db
    .from('revenue_head_reports')
    .select(
      'id, funnel_health, business_effect_state, leads_created, ' +
      'qualified_leads, appointments_booked, appointments_held, ' +
      'proposals_sent, closed_won, source_system'
    )
    .eq('tenant_id', tenant.id)
    .eq('idempotency_key', `revenue-report-${period.dayKey}`)
    .maybeSingle();
  if (existingReportError) throw existingReportError;
  if (existingReport?.id) {
    return {
      report_id: existingReport.id,
      outcome: 'replay',
      funnel_health: existingReport.funnel_health,
      business_effect_state: existingReport.business_effect_state,
      evidence_scope: existingReport.source_system === 'growth_os_canonical'
        ? 'canonical_growth_event_snapshot'
        : 'legacy_cumulative_lead_snapshot',
      leads_created: existingReport.leads_created,
      qualified_leads: existingReport.qualified_leads,
      appointments_booked: existingReport.appointments_booked,
      appointments_held: existingReport.appointments_held,
      proposals_sent: existingReport.proposals_sent,
      closed_won: existingReport.closed_won,
    };
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
  const { data: existingCharter, error: existingCharterError } = await db.from('revenue_head_charters')
    .select('id, version')
    .eq('tenant_id', tenant.id)
    .eq('idempotency_key', 'fga-revenue-charter-v1')
    .maybeSingle();
  if (existingCharterError) throw existingCharterError;

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
  /*
   * TWO SHAPES REACH THIS LINE, AND ONLY ONE WAS BEING READ.
   *
   * The RPC returns a wrapper — { charter: { id, ... } }. The existing-charter
   * short-circuit added directly above returns the ROW — { id, version }. This
   * read was `charterResult?.charter?.id`, which is undefined for the row, so
   * the agent threw `revenue_charter_identity_missing` on every run after the
   * very first one.
   *
   * The charter was registered 2026-07-24. The short-circuit landed 2026-07-29
   * in the commit that was fixing the PREVIOUS version of this same daily
   * failure (0a63bf6). From that day the agent failed every single run for 12
   * days, escalated to Patrick each morning, over a charter that has existed
   * and been correct the whole time. A fix that does not run the code it fixes
   * is a guess.
   */
  const charterId = charterResult?.charter?.id || charterResult?.id || null;
  if (!charterId) throw new Error('revenue_charter_identity_missing');

  const [leadRows, eventRows] = await Promise.all([
    fetchAllRows((from, to) => db.from('leads')
      .select(
        'id, email, lead_source, metadata, estimate_amount, final_revenue, ' +
        'date_of_inquiry, created_at'
      )
      .eq('tenant_id', tenant.id)
      .lt('created_at', period.endIso)
      .order('id', { ascending: true })
      .range(from, to), { cap: 10000 }),
    fetchAllRows((from, to) => db.from('growth_events')
      .select('id, lead_id, event_type, stage, occurred_at')
      .eq('tenant_id', tenant.id)
      .lt('occurred_at', period.endIso)
      .order('id', { ascending: true })
      .range(from, to), { cap: 100000 }),
  ]);
  if (leadRows.error || leadRows.truncated) {
    throw leadRows.error || new Error('revenue_lead_inventory_exceeded_safe_bound');
  }
  if (eventRows.error || eventRows.truncated) {
    throw eventRows.error || new Error('revenue_growth_events_exceeded_safe_bound');
  }
  const metrics = buildCanonicalRevenueMetrics({
    leads: leadRows.data,
    events: eventRows.data,
  });
  const evidence = {
    schema_version: 1,
    sources: [
      {
        source_type: 'prospect_inventory',
        source_id: `prospects-cumulative:${period.dayKey}`,
        evidence_digest: sha256(stableJson({
          prospects: metrics.leadsCreated,
          qualified: metrics.qualifiedLeads,
        })),
        observed_at: period.observedAt || new Date().toISOString(),
      },
      {
        source_type: 'canonical_growth_events',
        source_id: `growth-events-cumulative:${period.dayKey}`,
        evidence_digest: sha256(stableJson({
          events: eventRows.data.length,
          appointments_booked: metrics.appointmentsBooked,
          appointments_held: metrics.appointmentsHeld,
          proposals_sent: metrics.proposalsSent,
          closed_won: metrics.closedWon,
          closed_lost: metrics.closedLost,
        })),
        observed_at: period.observedAt || new Date().toISOString(),
      },
    ],
  };
  const reportId = deterministicUuid(`revenue:${tenant.id}:${period.dayKey}`);
  const reportPlan = planRevenueReportAcceptance({
    tenantId: tenant.id,
    charterId,
    reportId,
    periodStart: period.startDate,
    periodEnd: period.endDate,
    sourceSystem: 'growth_os_canonical',
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
    report_id: reportId,
    outcome: reportResult?.outcome || 'unknown',
    funnel_health: reportResult?.report?.funnel_health || 'unverified',
    business_effect_state:
      reportResult?.report?.business_effect_state || 'unverified',
    evidence_scope: 'canonical_growth_event_snapshot',
    leads_created: metrics.leadsCreated,
    qualified_leads: metrics.qualifiedLeads,
    appointments_booked: metrics.appointmentsBooked,
    appointments_held: metrics.appointmentsHeld,
    proposals_sent: metrics.proposalsSent,
    closed_won: metrics.closedWon,
  };
}

async function ensureCanonicalReportContracts(db, tenant, observedAt) {
  const { data: existing, error } = await db
    .from('department_report_contracts')
    .select('id, department, contract_version, schema_digest, acceptance_state, revision')
    .eq('tenant_id', tenant.id);
  if (error) throw error;
  const byDepartment = new Map((existing || []).map(row => [row.department, row]));
  const outcomes = [];
  for (const definition of listReportContractDefinitions()) {
    const expectedId = definition.contractIdForTenant(tenant.id);
    const current = byDepartment.get(definition.department);
    if (current) {
      if (current.id !== expectedId
          || current.contract_version !== definition.contractVersion
          || current.schema_digest !== definition.schemaDigest) {
        throw new Error(`department_report_contract_drift:${definition.department}`);
      }
      outcomes.push({
        department: definition.department,
        state: current.acceptance_state,
        outcome: 'existing',
      });
      continue;
    }
    const plan = planDepartmentReportCommand({
      command: 'register_contract',
      tenantId: tenant.id,
      department: definition.department,
      contractId: expectedId,
      contractVersion: definition.contractVersion,
      schemaDigest: definition.schemaDigest,
      expectedRevision: 0,
      idempotencyKey: `department-contract-${definition.department}-v1`,
      actorType: 'agent',
      actorId: 'supervised-executive-foundation',
      authorityTier: 'department_head',
      evidence: {
        source_type: 'canonical_contract_definition',
        source_id: `department-contract:${definition.department}:v1`,
        observed_at: observedAt,
      },
      featureGateEnabled: true,
    });
    const { data, error: rpcError } = await db.rpc(plan.rpc, plan.args);
    if (rpcError) throw rpcError;
    outcomes.push({
      department: definition.department,
      state: data?.state || 'draft',
      outcome: data?.outcome || 'unknown',
    });
  }
  return outcomes;
}

function canonicalHealth(department, source) {
  if (department === 'reliability_security_agent_ops') {
    return ({
      healthy: 'healthy', degraded: 'at_risk', critical: 'unhealthy',
      failed: 'unhealthy', unproven: 'unknown', unknown: 'unknown',
    })[source.outcome_health_state] || 'unknown';
  }
  return ({
    healthy: 'healthy', at_risk: 'at_risk', critical: 'unhealthy',
    unverified: 'unknown',
  })[source.funnel_health] || 'unknown';
}

function canonicalSummary(department, source) {
  if (department === 'reliability_security_agent_ops') {
    return {
      schema_version: 1,
      execution_health: source.execution_health_state,
      outcome_health: source.outcome_health_state,
      outcome_verified: source.outcome_verified === true,
      kpi_results: Array.isArray(source.kpi_results) ? source.kpi_results : [],
    };
  }
  return {
    schema_version: 1,
    funnel_health: source.funnel_health,
    business_effect_state: source.business_effect_state,
    leads_created: source.leads_created,
    qualified_leads: source.qualified_leads,
    appointments_booked: source.appointments_booked,
    appointments_held: source.appointments_held,
    proposals_sent: source.proposals_sent,
    closed_won: source.closed_won,
  };
}

async function submitCanonicalDepartmentReport(db, tenant, period, departmentKey, sourceReportId) {
  const definition = reportContractDefinition(departmentKey);
  const contractId = definition.contractIdForTenant(tenant.id);
  const { data: contract, error: contractError } = await db
    .from('department_report_contracts')
    .select('id, contract_version, schema_digest, acceptance_state')
    .eq('tenant_id', tenant.id)
    .eq('id', contractId)
    .maybeSingle();
  if (contractError) throw contractError;
  if (!contract || contract.acceptance_state !== 'accepted') {
    return { outcome: 'gated', reason: 'owner_contract_acceptance_required' };
  }

  const sourceTable = departmentKey === 'reliability'
    ? 'reliability_head_reports' : 'revenue_head_reports';
  const sourceFields = departmentKey === 'reliability'
    ? 'id, period_start, period_end, outcome_health_state, execution_health_state, outcome_verified, kpi_results, evidence_digest, evidence_observed_at, accepted_at'
    : 'id, period_start, period_end, funnel_health, business_effect_state, leads_created, qualified_leads, appointments_booked, appointments_held, proposals_sent, closed_won, evidence_digest, accepted_at';
  const { data: source, error: sourceError } = await db
    .from(sourceTable)
    .select(sourceFields)
    .eq('tenant_id', tenant.id)
    .eq('id', sourceReportId)
    .single();
  if (sourceError) throw sourceError;

  const reportId = deterministicUuid(
    `department-report:${tenant.id}:${definition.department}:${period.dayKey}`,
  );
  const { data: existing, error: existingError } = await db
    .from('department_reports')
    .select('id, report_state')
    .eq('tenant_id', tenant.id)
    .eq('id', reportId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return { outcome: 'existing', state: existing.report_state, report_id: existing.id };

  const plan = planDepartmentReportCommand({
    command: 'submit_report',
    tenantId: tenant.id,
    department: definition.department,
    contractId,
    contractVersion: contract.contract_version,
    schemaDigest: contract.schema_digest,
    reportId,
    sourceDepartmentReportId: source.id,
    reportingPeriodStart: period.startDate,
    reportingPeriodEnd: period.endDate,
    reportDigest: source.evidence_digest,
    outcomeHealth: canonicalHealth(definition.department, source),
    structuredSummary: canonicalSummary(definition.department, source),
    expectedRevision: 0,
    idempotencyKey: `department-report-${definition.department}-${period.dayKey}`,
    actorType: 'agent',
    actorId: `${departmentKey}-department-head`,
    authorityTier: 'department_head',
    evidence: {
      source_type: 'accepted_department_report',
      source_id: `${sourceTable}:${source.id}`,
      observed_at: source.evidence_observed_at || source.accepted_at || period.observedAt,
    },
    featureGateEnabled: true,
  });
  const { data, error: rpcError } = await db.rpc(plan.rpc, plan.args);
  if (rpcError) throw rpcError;
  return {
    outcome: data?.outcome || 'unknown',
    state: data?.state || 'submitted',
    report_id: reportId,
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
  const runAt = payload.now ? new Date(payload.now) : new Date();
  const period = {
    ...completedEtDay(runAt),
    observedAt: runAt.toISOString(),
  };
  const reportContracts = await ensureCanonicalReportContracts(
    db, tenant, period.observedAt,
  );
  const reliability = await createReliabilityReport(db, tenant, period);
  const revenue = await createRevenueReport(db, tenant, period);
  const canonicalReports = {
    reliability: reliability.report_id
      ? await submitCanonicalDepartmentReport(
        db, tenant, period, 'reliability', reliability.report_id,
      )
      : { outcome: 'gated', reason: reliability.reason || 'source_report_missing' },
    revenue: revenue.report_id
      ? await submitCanonicalDepartmentReport(
        db, tenant, period, 'revenue', revenue.report_id,
      )
      : { outcome: 'gated', reason: revenue.reason || 'source_report_missing' },
  };
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
    report_contracts: reportContracts,
    reliability,
    revenue,
    canonical_reports: canonicalReports,
  };
}

module.exports = run;
module.exports._internal = {
  completedEtDay,
  deterministicUuid,
  reliabilityRpcArgs,
  buildCumulativeRevenueMetrics,
  buildCanonicalRevenueMetrics,
  revenueStage,
  sha256,
  canonicalHealth,
  canonicalSummary,
};
