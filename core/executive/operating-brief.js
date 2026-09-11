'use strict';

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildOperatingBrief({
  asOf = new Date().toISOString(),
  revenueOutcome = null,
  revenueDepartment = null,
  relationshipMoments = [],
  ownerDecisions = [],
  failedJobs = [],
  evidenceWarnings = [],
} = {}) {
  const departmentVerified = Boolean(
    revenueDepartment
    && revenueDepartment.schema_version >= 2
    && revenueDepartment.health
    && revenueDepartment.health !== 'unknown',
  );
  const rawOutcomes = departmentVerified ? revenueDepartment.outcomes_30d || {} : {};
  const outcomes = Object.fromEntries([
    'provider_accepted', 'delivered', 'human_reply', 'warm_reply',
    'owner_accepted', 'demo_booked', 'demo_held', 'proposal', 'won',
  ].map((key) => [key, departmentVerified ? numberOrNull(rawOutcomes[key]) : null]));

  const relationships = relationshipMoments.map((row) => ({
    lead_id: row.id,
    company: row.company_name || row.name || 'Prospect',
    stage: row.status || row.lifecycle_stage || 'reply',
    next_action: row.next_best_action || 'owner_follow_up',
    priority: row.status === 'demo_booked' ? 'critical' : 'high',
    updated_at: row.updated_at || null,
  }));

  const decisions = ownerDecisions.map((row) => ({
    id: row.id,
    type: row.type || row.issue_type || 'decision_required',
    title: row.title || row.business_impact || 'Owner decision required',
    severity: row.severity || 'high',
    due_at: row.due_at || null,
  }));

  const commitments = [];
  if (revenueOutcome?.last_business_day) {
    const day = revenueOutcome.last_business_day;
    commitments.push({
      key: 'daily_first_touch',
      label: 'Safe first-touch outreach',
      period: day.et_date,
      actual: numberOrNull(day.sent),
      target: numberOrNull(revenueOutcome.target),
      state: day.met ? 'met' : 'missed',
      evidence: 'provider_and_gate_ledger',
    });
  } else {
    commitments.push({
      key: 'daily_first_touch', label: 'Safe first-touch outreach',
      actual: null, target: null, state: 'unknown', evidence: 'unavailable',
    });
  }
  commitments.push({
    key: 'conversation_to_demo',
    label: 'Warm conversations progressing to demo',
    actual: outcomes.demo_booked,
    target: null,
    state: outcomes.demo_booked === null ? 'unknown' : 'observed',
    evidence: departmentVerified ? 'growth_event_ledger' : 'unavailable',
  });

  const todaySent = numberOrNull(revenueOutcome?.today?.sent);
  const todayTarget = numberOrNull(revenueOutcome?.target);
  const expectedByNow = numberOrNull(revenueOutcome?.today?.expected_by_now);
  const authorizedRemaining = numberOrNull(revenueOutcome?.restart_cohort?.authorized_remaining);
  let currentState = 'unknown';
  if (todaySent !== null && todayTarget !== null) {
    if (todaySent >= todayTarget) currentState = 'met';
    else if ((expectedByNow || 0) > todaySent) currentState = 'behind';
    else if ((expectedByNow || 0) === 0 && (authorizedRemaining || 0) > 0) currentState = 'scheduled';
    else currentState = 'in_progress';
  }
  const currentPlan = {
    plan_key: revenueOutcome?.restart_cohort?.plan_key || null,
    state: currentState,
    target_today: todayTarget,
    provider_accepted_today: todaySent,
    expected_by_now: expectedByNow,
    authorized_remaining: authorizedRemaining,
    next_dispatch_window: currentState === 'met' ? null : '09:20 / 12:20 / 15:20 ET',
    stop_condition: 'reply, suppression, bounce, complaint, customer match, or unverifiable identity',
  };

  const risks = [];
  if (!departmentVerified) {
    risks.push({ severity: 'critical', code: 'revenue_department_unverified', message: 'Revenue & Sales outcome report is unavailable or unverified.' });
  } else if (revenueDepartment.health !== 'healthy') {
    risks.push({
      severity: revenueDepartment.health === 'unhealthy' ? 'critical' : 'high',
      code: 'revenue_department_health',
      message: `Revenue & Sales is ${revenueDepartment.health}: ${(revenueDepartment.reasons || []).join(', ') || 'reason unavailable'}.`,
    });
  }
  if (revenueOutcome?.funnel_anomalies?.length) {
    risks.push({ severity: 'critical', code: 'funnel_evidence_inconsistent', message: `${revenueOutcome.funnel_anomalies.length} revenue funnel evidence anomaly(s) require Reliability review.` });
  }
  if (revenueOutcome?.open_reliability_handoffs?.length) {
    risks.push({ severity: 'critical', code: 'open_reliability_handoffs', message: `${revenueOutcome.open_reliability_handoffs.length} Revenue-to-Reliability handoff(s) remain open.` });
  }
  if (revenueOutcome?.last_business_day && !revenueOutcome.last_business_day.met) {
    const day = revenueOutcome.last_business_day;
    risks.push({
      severity: 'critical',
      code: 'daily_first_touch_missed',
      message: `The last completed outreach day missed ${day.sent}/${revenueOutcome.target}. `
        + `${authorizedRemaining ?? 'Unverified'} reviewed prospect(s) are currently authorized and waiting.`,
    });
  }
  if (failedJobs.length) {
    risks.push({ severity: 'high', code: 'recent_agent_failures', message: `${failedJobs.length} recent agent job(s) failed.` });
  }
  for (const warning of evidenceWarnings) {
    risks.push({ severity: 'critical', code: warning, message: `Evidence unavailable: ${warning.replace(/_/g, ' ')}.` });
  }

  let headline;
  if (relationships.length) headline = `${relationships.length} prospect relationship moment(s) need Patrick`;
  else if (!departmentVerified) headline = 'Revenue outcome evidence is not trustworthy yet';
  else if ((outcomes.warm_reply || 0) > 0 || (outcomes.demo_booked || 0) > 0) {
    headline = `${outcomes.warm_reply || 0} warm repl${outcomes.warm_reply === 1 ? 'y' : 'ies'} and ${outcomes.demo_booked || 0} demo${outcomes.demo_booked === 1 ? '' : 's'} booked in 30 days`;
  } else headline = 'No warm reply or demo outcome has been proven in 30 days';

  const departmentHealth = departmentVerified
    ? (revenueOutcome?.last_business_day && !revenueOutcome.last_business_day.met
      ? 'at_risk'
      : revenueDepartment.health)
    : 'unknown';

  return {
    schema_version: 2,
    as_of: asOf,
    objective: 'Create qualified human conversations and move them to a demo-ready owner handoff.',
    headline,
    owner_interface: {
      decisions,
      relationship_moments: relationships,
      commitments,
      material_risks: risks,
    },
    current_plan: currentPlan,
    outcomes_30d: outcomes,
    department_health: departmentHealth,
    evidence: {
      revenue_department_verified: departmentVerified,
      warnings: evidenceWarnings,
    },
  };
}

module.exports = { buildOperatingBrief, numberOrNull };
