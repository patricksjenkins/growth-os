'use strict';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const MACHINE_WORK_OWNERS = Object.freeze({
  review_high_score: 'scoring + growth-restart',
  review_no_contact: 'enrichment',
  facebook_dms: 'enrichment',
  recover_facebook_contacts: 'enrichment',
  recover_sequence_continuity: 'sequence-recovery',
  refill_queue: 'prospecting',
  approve_drafts: 'outreach',
});

function machineWorkFromSnapshot(snapshot = null) {
  const actions = Array.isArray(snapshot?.next_actions) ? snapshot.next_actions : [];
  return actions
    .filter((action) => MACHINE_WORK_OWNERS[action.id])
    .map((action) => ({
      id: action.id,
      owner: MACHINE_WORK_OWNERS[action.id],
      label: action.id === 'review_no_contact'
        ? `${numberOrNull(action.count) ?? 'Unverified'} prospects need contact recovery`
        : action.id === 'review_high_score'
          ? `${numberOrNull(action.count) ?? 'Unverified'} high-score records await bounded eligibility and contact work`
        : ['facebook_dms', 'recover_facebook_contacts'].includes(action.id)
          ? `${numberOrNull(action.count) ?? 'Unverified'} Facebook-only prospects need email recovery`
          : action.label,
      count: numberOrNull(action.count),
      state: 'agent_owned',
      link: action.link || '/admin/growth',
    }));
}

function nextCheckpoint(asOf, currentState) {
  if (currentState === 'paused') {
    return { label: 'Resume after draft verification', at: 'operator-controlled', owner: 'revenue-head' };
  }
  if (currentState === 'met') {
    return { label: 'Hourly reply monitoring', at: 'hourly', owner: 'reply-classification' };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(asOf));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minuteOfDay = (Number(values.hour) % 24) * 60 + Number(values.minute);
  const windows = [
    { minute: 9 * 60 + 20, label: '09:20 ET', owner: 'auto-outreach' },
    { minute: 12 * 60 + 20, label: '12:20 ET', owner: 'auto-outreach' },
    { minute: 15 * 60 + 20, label: '15:20 ET', owner: 'auto-outreach' },
    { minute: 17 * 60, label: '17:00 ET', owner: 'revenue-guardian' },
  ];
  const next = windows.find((window) => minuteOfDay < window.minute)
    || { label: '08:00 ET tomorrow', owner: 'revenue-guardian' };
  return { label: next.label, at: next.label, owner: next.owner };
}

function buildOperatingBrief({
  asOf = new Date().toISOString(),
  revenueOutcome = null,
  revenueDepartment = null,
  relationshipMoments = [],
  ownerDecisions = [],
  otherApprovals = [],
  failedJobs = [],
  evidenceWarnings = [],
  growthSnapshot = null,
  departmentCoverage = null,
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
      label: 'Safe policy-eligible sequence starts',
      period: day.et_date,
      actual: numberOrNull(day.sent),
      target: numberOrNull(revenueOutcome.target),
      state: day.met ? 'met' : 'missed',
      evidence: 'provider_and_gate_ledger',
    });
  } else {
    commitments.push({
      key: 'daily_first_touch', label: 'Safe policy-eligible sequence starts',
      actual: null, target: null, state: 'unknown', evidence: 'unavailable',
    });
  }
  commitments.push({
    key: 'conversation_to_demo',
    label: 'Warm conversations progressing to demo',
    actual: outcomes.demo_booked,
    target: null,
    state: outcomes.demo_booked === null ? 'unknown' : outcomes.demo_booked > 0 ? 'observed' : 'not_observed',
    evidence: departmentVerified ? 'growth_event_ledger' : 'unavailable',
  });

  const todaySent = numberOrNull(revenueOutcome?.today?.sent);
  const todayTarget = numberOrNull(revenueOutcome?.target);
  const expectedByNow = numberOrNull(revenueOutcome?.today?.expected_by_now);
  const authorizedRemaining = numberOrNull(revenueOutcome?.restart_cohort?.authorized_remaining);
  let currentState = 'unknown';
  if (todaySent !== null && todayTarget !== null) {
    if (revenueOutcome?.controls?.first_touch_paused === true) currentState = 'paused';
    else if (todaySent >= todayTarget) currentState = 'met';
    else if ((expectedByNow || 0) > todaySent) currentState = 'behind';
    else if ((expectedByNow || 0) === 0 && (authorizedRemaining || 0) > 0) currentState = 'scheduled';
    else currentState = 'in_progress';
  }
  const currentPlan = {
    plan_key: revenueOutcome?.restart_cohort?.plan_key || null,
    state: currentState,
    target_today: todayTarget,
    provider_accepted_today: todaySent,
    first_touch_today: numberOrNull(revenueOutcome?.today?.first_touch),
    restarted_today: numberOrNull(revenueOutcome?.today?.restarted),
    delivery_lifecycle: revenueOutcome?.today?.delivery_lifecycle || null,
    employee_evidence: revenueOutcome?.today?.employee_evidence || null,
    current_cohort_employee_evidence: revenueOutcome?.current_cohort?.employee_evidence || null,
    expected_by_now: expectedByNow,
    authorized_remaining: authorizedRemaining,
    dispatch_windows: ['09:20 ET', '12:20 ET', '15:20 ET'],
    next_checkpoint: nextCheckpoint(asOf, currentState),
    stop_condition: 'reply, suppression, bounce, complaint, customer match, or unverifiable identity',
    active_followup_sequences: numberOrNull(revenueOutcome?.sequence_continuity?.active),
    followup_recovery_remaining: numberOrNull(revenueOutcome?.sequence_continuity?.eligible_remaining),
    followup_recovered_today: numberOrNull(revenueOutcome?.sequence_continuity?.recovered_today),
    followup_recovery_daily_limit: numberOrNull(revenueOutcome?.sequence_continuity?.daily_limit),
    followup_recovery_remaining_today: numberOrNull(revenueOutcome?.sequence_continuity?.remaining_today),
    creative_version: revenueOutcome?.creative?.version || null,
    conversation_first_drafts: numberOrNull(revenueOutcome?.creative?.drafts),
    // The Growth snapshot's `email_ready` is an enrichment-stage bucket, not
    // drafts the sender can actually use. Revenue's funnel trace evaluates the
    // live draft/gate contract and is the only authoritative next-cohort count.
    next_cohort_email_ready: numberOrNull(revenueOutcome?.ready_to_send),
    controls: revenueOutcome?.controls || null,
  };

  // This is a cohort funnel, not a mixture of today's flow and unrelated
  // standing inventory. The previous brief placed `email_ready` stock (the
  // next cohort) immediately before the already-authorized current cohort,
  // which could display an impossible 21 -> 25 progression. Next-cohort stock
  // remains visible on current_plan; every card below describes the exact
  // current restart cohort and is therefore safe to read left-to-right.
  const cohort = revenueOutcome?.current_cohort || null;
  const cohortSize = numberOrNull(cohort?.size);
  const cohortAccepted = numberOrNull(cohort?.provider_accepted);
  const cohortDelivered = numberOrNull(cohort?.delivered);
  const cohortHumanReply = numberOrNull(cohort?.human_reply);
  const cohortWarmReply = numberOrNull(cohort?.warm_reply);
  const cohortOwnerAccepted = numberOrNull(cohort?.owner_accepted);
  const cohortDemoBooked = numberOrNull(cohort?.demo_booked);
  const cohortState = (value, prior, { scheduled = false } = {}) => {
    if (value === null) return 'unknown';
    if (value > 0) return cohortSize !== null && value >= cohortSize ? 'met' : 'observed';
    if (scheduled) return currentState;
    return (prior || 0) > 0 ? 'waiting' : 'not_started';
  };
  const pathToDemo = [
    {
      key: 'current_cohort', label: 'Current policy-eligible cohort', actual: cohortSize,
      target: todayTarget, owner: 'growth-restart', evidence: 'current_restart_cohort',
      state: cohortSize === null ? 'unknown' : cohortSize > 0 ? 'ready' : 'empty',
    },
    {
      key: 'provider_accepted', label: 'Provider accepted · cohort', actual: cohortAccepted,
      target: cohortSize, owner: 'auto-outreach', evidence: 'current_cohort_provider_and_gate_ledger',
      state: cohortState(cohortAccepted, cohortSize, { scheduled: true }),
    },
    {
      key: 'delivered', label: 'Delivered · cohort', actual: cohortDelivered,
      target: cohortAccepted > 0 ? cohortAccepted : null,
      owner: 'resend-webhook', evidence: 'current_cohort_signed_provider_events',
      state: cohortState(cohortDelivered, cohortAccepted),
    },
    {
      key: 'human_reply', label: 'Human replies · cohort', actual: cohortHumanReply,
      target: null, owner: 'reply-classification', evidence: 'current_cohort_growth_event_ledger',
      state: cohortState(cohortHumanReply, cohortDelivered),
    },
    {
      key: 'warm_reply', label: 'Warm replies · cohort', actual: cohortWarmReply,
      target: null, owner: 'owner-handoff', evidence: 'current_cohort_growth_event_ledger',
      state: cohortState(cohortWarmReply, cohortHumanReply),
    },
    {
      key: 'owner_accepted', label: 'Patrick accepted · cohort', actual: cohortOwnerAccepted,
      target: null, owner: 'owner-handoff', evidence: 'current_cohort_growth_event_ledger',
      state: cohortState(cohortOwnerAccepted, cohortWarmReply),
    },
    {
      key: 'demo_booked', label: 'Demos booked · cohort', actual: cohortDemoBooked,
      target: null, owner: cohortOwnerAccepted > 0 ? 'Patrick' : 'owner-handoff',
      evidence: 'current_cohort_growth_event_ledger',
      state: cohortState(cohortDemoBooked, cohortOwnerAccepted),
    },
  ];

  const agentOwnedWork = machineWorkFromSnapshot(growthSnapshot);
  const prependUniqueWork = (item) => {
    const existing = agentOwnedWork.findIndex((row) => row.id === item.id);
    if (existing >= 0) agentOwnedWork.splice(existing, 1);
    agentOwnedWork.unshift(item);
  };
  if (Number(revenueOutcome?.sequence_continuity?.eligible_remaining) > 0) {
    const recoveredToday = numberOrNull(revenueOutcome?.sequence_continuity?.recovered_today);
    const dailyLimit = numberOrNull(revenueOutcome?.sequence_continuity?.daily_limit);
    const progress = recoveredToday !== null && dailyLimit !== null
      ? `; ${recoveredToday}/${dailyLimit} safely admitted today`
      : '';
    prependUniqueWork({
      id: 'recover_sequence_continuity', owner: 'sequence-recovery',
      label: `Restore seven-touch continuity for ${revenueOutcome.sequence_continuity.eligible_remaining} provider-proven contacts${progress}`,
      count: revenueOutcome.sequence_continuity.eligible_remaining,
      state: 'agent_owned', link: '/admin/drip-campaign',
    });
  }
  if (authorizedRemaining > 0) {
    prependUniqueWork({
      id: 'dispatch_authorized_cohort', owner: 'auto-outreach',
      label: revenueOutcome?.controls?.first_touch_paused
        ? `Hold ${authorizedRemaining} authorized sequence starts until draft verification completes`
        : `Send the ${authorizedRemaining} authorized sequence starts through the provider gate`,
      count: authorizedRemaining, state: currentState, link: '/admin/growth',
    });
  }

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
  const todayEmployeeEvidence = revenueOutcome?.today?.employee_evidence;
  if (todaySent > 0 && todayEmployeeEvidence?.available === false) {
    risks.push({
      severity: 'critical',
      code: 'accepted_cohort_employee_evidence_unavailable',
      message: `${todaySent} sequence start(s) were provider accepted, but their employee-size evidence could not be read.`,
    });
  } else if (todaySent > 0 && (
    Number(todayEmployeeEvidence?.unknown || 0) > 0
    || Number(todayEmployeeEvidence?.outside_policy || 0) > 0
  )) {
    risks.push({
      severity: 'critical',
      code: 'accepted_cohort_employee_policy_anomaly',
      message: `${todayEmployeeEvidence.unknown || 0} accepted prospect(s) have unknown employee classification and ${todayEmployeeEvidence.outside_policy || 0} fall outside the sub-20 policy.`,
    });
  }
  if (revenueOutcome?.last_business_day && !revenueOutcome.last_business_day.met) {
    const day = revenueOutcome.last_business_day;
    risks.push({
      severity: 'critical',
      code: 'daily_sequence_start_missed',
      message: `The last completed outreach day missed ${day.sent}/${revenueOutcome.target}. `
        + `${authorizedRemaining ?? 'Unverified'} reviewed prospect(s) are currently authorized and waiting.`,
    });
  }
  if (Number(revenueOutcome?.sequence_continuity?.eligible_remaining) > 0) {
    risks.push({
      severity: Number(revenueOutcome?.sequence_continuity?.active) > 0 ? 'high' : 'critical',
      code: 'seven_touch_continuity_backlog',
      message: `${revenueOutcome.sequence_continuity.eligible_remaining} provider-proven contacts still need a current seven-touch enrollment; ${revenueOutcome.sequence_continuity.active || 0} are active.`,
    });
  }
  if (failedJobs.length) {
    const byAgent = failedJobs.reduce((counts, job) => {
      const agent = job.agent_name || 'unknown';
      counts[agent] = (counts[agent] || 0) + 1;
      return counts;
    }, {});
    const summary = Object.entries(byAgent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([agent, count]) => `${agent} ${count}`)
      .join(', ');
    risks.push({
      severity: 'high',
      code: 'recent_agent_failures',
      message: `${failedJobs.length} agent job(s) failed in the last 24 hours${summary ? ` (${summary})` : ''}.`,
    });
  }
  const employeeEvidenceProvider = growthSnapshot?.funnel?.provider_health?.apollo;
  if (['credential_rejected', 'scope_rejected', 'not_configured'].includes(employeeEvidenceProvider?.status)) {
    risks.push({
      severity: 'high',
      code: 'employee_evidence_provider_unavailable',
      message: employeeEvidenceProvider.status === 'credential_rejected'
        ? 'Apollo rejected the configured credential, so public research is the only active employee-size evidence path.'
        : employeeEvidenceProvider.status === 'scope_rejected'
          ? 'Apollo organization enrichment lacks the required API scope, so public research is the only active employee-size evidence path.'
          : 'Apollo organization enrichment is not configured, so public research is the only active employee-size evidence path.',
    });
  }
  for (const warning of evidenceWarnings) {
    risks.push({ severity: 'critical', code: warning, message: `Evidence unavailable: ${warning.replace(/_/g, ' ')}.` });
  }

  let headline;
  if (relationships.length) headline = `${relationships.length} prospect relationship moment(s) need Patrick`;
  else if (!departmentVerified) headline = 'Revenue outcome evidence is not trustworthy yet';
  else if ((outcomes.warm_reply || 0) > 0 || (outcomes.demo_booked || 0) > 0) {
    headline = `${outcomes.warm_reply || 0} warm repl${outcomes.warm_reply === 1 ? 'y' : 'ies'} and ${outcomes.demo_booked || 0} demo${outcomes.demo_booked === 1 ? '' : 's'} booked in 30 days`;
  } else if (todaySent > 0) {
    headline = `${todaySent}/${todayTarget ?? '—'} policy-eligible sequence starts accepted today `
      + `(${revenueOutcome?.today?.first_touch ?? '—'} first contacts, ${revenueOutcome?.today?.restarted ?? '—'} restarted); reply monitoring is active`;
  } else if (authorizedRemaining > 0) {
    headline = revenueOutcome?.controls?.first_touch_paused
      ? `${authorizedRemaining} authorized prospects are held for draft verification; no send can run while paused`
      : `${authorizedRemaining} authorized prospects are queued for ${currentPlan.next_checkpoint.label}`;
  } else if (Number(revenueOutcome?.sequence_continuity?.eligible_remaining) > 0) {
    headline = `${revenueOutcome.sequence_continuity.active || 0} current follow-up sequences active; ${revenueOutcome.sequence_continuity.eligible_remaining} provider-proven contacts await recovery`;
  } else headline = 'No warm reply or demo outcome has been proven in 30 days';

  const departmentHealth = departmentVerified
    ? (revenueOutcome?.last_business_day && !revenueOutcome.last_business_day.met
      ? 'at_risk'
      : revenueDepartment.health)
    : 'unknown';

  return {
    schema_version: 3,
    as_of: asOf,
    objective: 'Create qualified human conversations and move them to a demo-ready owner handoff.',
    headline,
    owner_interface: {
      decisions,
      other_approvals: otherApprovals.map((approval) => ({
        id: approval.id,
        type: approval.type || 'approval',
        title: approval.title || 'Approval required',
        count: numberOrNull(approval.count),
        link: approval.link || null,
      })),
      relationship_moments: relationships,
      commitments,
      material_risks: risks,
    },
    current_plan: currentPlan,
    path_to_demo: pathToDemo,
    agent_owned_work: agentOwnedWork,
    department_coverage: {
      total_heads: numberOrNull(departmentCoverage?.total_heads) ?? 7,
      live_operating_reports: numberOrNull(departmentCoverage?.live_operating_reports)
        ?? (departmentVerified ? 1 : 0),
      formally_accepted_reports: numberOrNull(departmentCoverage?.formally_accepted_reports) ?? 0,
      evidence_gated: numberOrNull(departmentCoverage?.evidence_gated)
        ?? Math.max(0, 7 - (departmentVerified ? 1 : 0)),
      departments: Array.isArray(departmentCoverage?.departments) ? departmentCoverage.departments : [],
    },
    outcomes_30d: outcomes,
    department_health: departmentHealth,
    evidence: {
      revenue_department_verified: departmentVerified,
      revenue_report_source: departmentVerified ? 'live_revenue_guardian_report' : 'unavailable',
      formal_acceptance: 'not_inferred',
      growth_snapshot_at: growthSnapshot?.snapshot_at || null,
      warnings: evidenceWarnings,
    },
  };
}

module.exports = { buildOperatingBrief, numberOrNull, machineWorkFromSnapshot, nextCheckpoint };
