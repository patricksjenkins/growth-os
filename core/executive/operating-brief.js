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
    expected_by_now: expectedByNow,
    authorized_remaining: authorizedRemaining,
    dispatch_windows: ['09:20 ET', '12:20 ET', '15:20 ET'],
    next_checkpoint: nextCheckpoint(asOf, currentState),
    stop_condition: 'reply, suppression, bounce, complaint, customer match, or unverifiable identity',
    active_followup_sequences: numberOrNull(revenueOutcome?.sequence_continuity?.active),
    followup_recovery_remaining: numberOrNull(revenueOutcome?.sequence_continuity?.eligible_remaining),
    creative_version: revenueOutcome?.creative?.version || null,
    conversation_first_drafts: numberOrNull(revenueOutcome?.creative?.drafts),
    controls: revenueOutcome?.controls || null,
  };

  const emailReadyInventory = numberOrNull(growthSnapshot?.funnel?.email_ready);
  const pathToDemo = [
    {
      key: 'email_ready_inventory', label: 'New email-ready prospects', actual: emailReadyInventory,
      target: null, owner: 'enrichment + scoring', evidence: 'full_fga_pipeline_inventory',
      state: emailReadyInventory === null ? 'unknown' : emailReadyInventory > 0 ? 'ready' : 'empty',
    },
    {
      key: 'authorized_first_touch', label: 'Authorized first touch',
      actual: authorizedRemaining === null ? null : authorizedRemaining + (todaySent || 0),
      target: todayTarget, owner: 'growth-restart', evidence: 'restart_authorization_ledger',
      state: authorizedRemaining === null ? 'unknown' : authorizedRemaining > 0 ? 'ready' : todaySent > 0 ? 'observed' : 'blocked',
    },
    {
      key: 'provider_accepted', label: 'Accepted today', actual: todaySent,
      target: todayTarget, owner: 'auto-outreach', evidence: 'provider_and_gate_ledger',
      state: todaySent === null ? 'unknown' : todaySent >= (todayTarget || Infinity) ? 'met' : todaySent > 0 ? 'active' : currentState,
    },
    {
      key: 'seven_touch_active', label: 'Seven-touch follow-up active',
      actual: numberOrNull(revenueOutcome?.sequence_continuity?.active),
      target: null, owner: 'sequence-recovery + drip-campaign', evidence: 'current_plan_enrollment_ledger',
      state: revenueOutcome?.sequence_continuity?.active == null
        ? 'unknown'
        : revenueOutcome.sequence_continuity.active > 0 ? 'active' : 'blocked',
    },
    {
      key: 'human_reply', label: 'Human replies · 30d', actual: outcomes.human_reply,
      target: null, owner: 'reply-classification', evidence: departmentVerified ? 'growth_event_ledger' : 'unavailable',
      state: outcomes.human_reply === null ? 'unknown' : outcomes.human_reply > 0 ? 'observed' : (outcomes.delivered || 0) > 0 ? 'needs_improvement' : 'waiting',
    },
    {
      key: 'warm_reply', label: 'Warm replies · 30d', actual: outcomes.warm_reply,
      target: null, owner: 'owner-handoff', evidence: departmentVerified ? 'growth_event_ledger' : 'unavailable',
      state: outcomes.warm_reply === null ? 'unknown' : outcomes.warm_reply > 0 ? 'observed' : 'waiting',
    },
    {
      key: 'demo_booked', label: 'Demos booked · 30d', actual: outcomes.demo_booked,
      target: null, owner: outcomes.warm_reply > 0 ? 'Patrick' : 'owner-handoff',
      evidence: departmentVerified ? 'growth_event_ledger' : 'unavailable',
      state: outcomes.demo_booked === null ? 'unknown' : outcomes.demo_booked > 0 ? 'observed' : 'waiting',
    },
  ];

  const agentOwnedWork = machineWorkFromSnapshot(growthSnapshot);
  const prependUniqueWork = (item) => {
    const existing = agentOwnedWork.findIndex((row) => row.id === item.id);
    if (existing >= 0) agentOwnedWork.splice(existing, 1);
    agentOwnedWork.unshift(item);
  };
  if (authorizedRemaining > 0) {
    prependUniqueWork({
      id: 'dispatch_authorized_cohort', owner: 'auto-outreach',
      label: revenueOutcome?.controls?.first_touch_paused
        ? `Hold ${authorizedRemaining} authorized first touches until draft verification completes`
        : `Send the ${authorizedRemaining} authorized first touches through the provider gate`,
      count: authorizedRemaining, state: currentState, link: '/admin/growth',
    });
  }
  if (Number(revenueOutcome?.sequence_continuity?.eligible_remaining) > 0) {
    prependUniqueWork({
      id: 'recover_sequence_continuity', owner: 'sequence-recovery',
      label: `Restore seven-touch continuity for ${revenueOutcome.sequence_continuity.eligible_remaining} provider-proven contacts`,
      count: revenueOutcome.sequence_continuity.eligible_remaining,
      state: 'agent_owned', link: '/admin/drip-campaign',
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
  if (revenueOutcome?.last_business_day && !revenueOutcome.last_business_day.met) {
    const day = revenueOutcome.last_business_day;
    risks.push({
      severity: 'critical',
      code: 'daily_first_touch_missed',
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
  for (const warning of evidenceWarnings) {
    risks.push({ severity: 'critical', code: warning, message: `Evidence unavailable: ${warning.replace(/_/g, ' ')}.` });
  }

  let headline;
  if (relationships.length) headline = `${relationships.length} prospect relationship moment(s) need Patrick`;
  else if (!departmentVerified) headline = 'Revenue outcome evidence is not trustworthy yet';
  else if ((outcomes.warm_reply || 0) > 0 || (outcomes.demo_booked || 0) > 0) {
    headline = `${outcomes.warm_reply || 0} warm repl${outcomes.warm_reply === 1 ? 'y' : 'ies'} and ${outcomes.demo_booked || 0} demo${outcomes.demo_booked === 1 ? '' : 's'} booked in 30 days`;
  } else if (todaySent > 0) {
    headline = `${todaySent}/${todayTarget ?? '—'} first touches accepted today; reply monitoring is active`;
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
