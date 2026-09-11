/**
 * Growth Engine — prospecting orchestrator (rules-based, no LLM, no sends).
 *
 * Builds the funnel snapshot + Next Best Actions + stall alerts that make the
 * separate prospecting agents read as one connected machine. It COORDINATES and
 * REPORTS — it never sends, never calls a paid API, and never remediates (that
 * stays with operations-guardian). The Command Center reads the persisted
 * snapshot so pages load cheaply.
 *
 * Deep-link targets use the EXACT Pipeline queue keys (see Pipeline.tsx
 * matchesQueue) so every Next Best Action opens the matching, already-built
 * filtered queue — nothing here is a disconnected page.
 */

const { getConfig, FGA_TENANT_ID } = require('../config');
const { fetchAllRows } = require('../../db/client');
const { isSyntheticGrowthLead } = require('./production-evidence');
const { listReviewableDrafts } = require('./review-queue');

// Tunables (env-overridable) for stall detection.
const ENRICHMENT_BACKLOG = Number(process.env.GROWTH_ENRICHMENT_BACKLOG || 30);
const DRAFTS_WAITING = Number(process.env.GROWTH_DRAFTS_WAITING || 15);
const HIGH_SCORE = 70;
const CLOSED_OR_DEAD = new Set(['won', 'lost', 'rejected', 'disqualified', 'no_response']);

const PROSPECTING_AGENTS = [
  'prospecting', 'enrichment', 'scoring', 'outreach',
  'targeted-campaign', 'facebook-prospecting', 'sequence-recovery', 'drip-campaign', 'reply-classification',
];

/**
 * A normal recovery run reports `deferred` after enrolling its bounded cohort.
 * A dry run writes nothing, so every eligible row still awaits recovery and
 * `eligible` is the truthful backlog. Keeping this distinction here prevents
 * an evidence-only run from making the Chief of Staff understate machine work.
 */
function recoveryBacklogCount(result) {
  if (!result || typeof result !== 'object') return null;
  const raw = result.dry_run === true ? result.eligible : result.deferred;
  const count = Number(raw);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function isoDaysAgo(n) { return new Date(Date.now() - n * 86400_000).toISOString(); }

function contactBucket(lead = {}) {
  const enrichment = String(lead.enrichment_status || '');
  const lifecycle = String(lead.lifecycle_stage || '');
  if (enrichment === 'enriched_fb_only' || lifecycle === 'fb_only') return 'fb_only';
  if (enrichment === 'enriched_phone_only' || lifecycle === 'phone_only') return 'phone_only';
  if (enrichment === 'enriched_no_contact' || lifecycle === 'unqualified') return 'dead_end';
  return 'pending';
}

function activeLead(lead = {}) {
  return !CLOSED_OR_DEAD.has(String(lead.status || ''));
}

/**
 * One pure definition for every lead-backed Growth card and deep link. It
 * mirrors the browser Pipeline predicates, but runs over the complete
 * tenant-scoped inventory rather than the browser's bounded payload.
 */
function computeLeadFunnel(rows = [], now = Date.now()) {
  const since7d = now - 7 * 86400_000;
  const leads = rows.filter((lead) => !isSyntheticGrowthLead(lead));
  const count = predicate => leads.reduce((total, lead) => total + (predicate(lead) ? 1 : 0), 0);
  const isNew = lead => lead.status === 'new_lead';
  return {
    new_this_week: count(lead => {
      const created = Date.parse(lead.created_at || '');
      return Number.isFinite(created) && created >= since7d;
    }),
    enriched: count(lead => lead.lifecycle_stage === 'enriched'),
    scored: count(lead => lead.lifecycle_stage === 'scored'),
    sequenced: count(lead => lead.lifecycle_stage === 'sequenced'),
    fb_only: count(lead => isNew(lead) && contactBucket(lead) === 'fb_only'),
    unqualified: count(lead => lead.lifecycle_stage === 'unqualified'),
    email_ready: count(lead => isNew(lead)
      && lead.lead_source === 'prospecting_agent'
      && Boolean(lead.email)
      && lead.lifecycle_stage === 'enriched'),
    phone_only: count(lead => isNew(lead) && contactBucket(lead) === 'phone_only'),
    no_contact: count(lead => isNew(lead) && contactBucket(lead) === 'dead_end'),
    replies: count(lead => lead.status === 'replied'),
    replies_7d: count(lead => {
      const updated = Date.parse(lead.updated_at || '');
      return lead.status === 'replied' && Number.isFinite(updated) && updated >= since7d;
    }),
    interested: count(lead => lead.status === 'interested'),
    demos_booked: count(lead => lead.status === 'demo_booked'),
    proposals_sent: count(lead => lead.status === 'quoted'),
    closed_won: count(lead => lead.status === 'won'),
    contacted: count(lead => lead.status === 'contacted'),
    high_score: count(lead => Number(lead.lead_score) >= HIGH_SCORE && activeLead(lead)),
  };
}

/** Monday (UTC) of the current week as YYYY-MM-DD — the focus week key. */
function currentWeekStart() {
  const d = new Date();
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? 6 : day - 1); // back to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

/** Evidence count — a failed read is unknown, never a fabricated zero. */
async function countOf(db, table, build) {
  const q = build(db.from(table).select('id', { count: 'exact', head: true }));
  const { count, error } = await q;
  if (error) throw new Error(`${table} count unavailable: ${error.message}`);
  return count || 0;
}

/**
 * Relationship metrics must never count test fixtures or quarantined intake.
 * Query the small replied/interested state directly so the dashboard, owner
 * queue, and Chief of Staff all use the same business-evidence boundary.
 */
async function countAuthenticLeadState(db, tenantId, status, updatedSince = null) {
  let query = db.from('leads')
    .select('id, email, lead_source, metadata')
    .eq('tenant_id', tenantId).eq('status', status)
    .order('id', { ascending: true }).limit(3001);
  if (updatedSince) query = query.gte('updated_at', updatedSince);
  const { data, error } = await query;
  if (error) throw new Error(`authentic ${status} count unavailable: ${error.message}`);
  if ((data || []).length > 3000) throw new Error(`authentic ${status} count exceeded safe query bound`);
  return (data || []).filter((lead) => !isSyntheticGrowthLead(lead)).length;
}

/**
 * Accurate "drafts to review" — matches the Pipeline queue definition: leads
 * still at status='new_lead' that have a DRAFT email outreach sequence. A raw
 * outreach_sequences row count badly overcounts (multiple step rows per lead +
 * non-email types), which would false-fire the drafts_waiting alert.
 */
async function countDraftsToReview(db, tenantId) {
  if (tenantId !== FGA_TENANT_ID) {
    throw new Error('manual outreach review inventory is FGA-only');
  }
  return (await listReviewableDrafts(db)).length;
}

/**
 * Compute the full funnel + stage tallies for one tenant from count queries.
 * Numbers are directional KPIs; clicking a card opens the Pipeline queue that
 * does the exact filtering, so we never need to replicate that logic here.
 */
async function computeFunnel(db, tenantId) {
  const since7d = isoDaysAgo(7);
  const t = (b) => (q) => b(q.eq('tenant_id', tenantId));

  const [
    leadRows, draftsToReview, activeDrip, activeOutreach,
    autosendSent7d, dripSent7d, recoveryJob,
  ] = await Promise.all([
    fetchAllRows((from, to) => db.from('leads')
      .select('id, status, lead_source, email, phone, lifecycle_stage, enrichment_status, lead_score, metadata, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(from, to), { cap: 10000 }),
    countDraftsToReview(db, tenantId),
    countOf(db, 'drip_enrollments', t((q) => q.in('status', ['active', 'paused']))),
    countOf(db, 'outreach_enrollments', t((q) => q.eq('status', 'active'))),
    // Outreach sent = the FIRST-touch autonomous sends (autosend_decisions)
    // PLUS the drip follow-up touches. Counting only drip_sends reported 0 all
    // week while 17 autonomous emails actually went out — the card said the
    // engine was dead when it was working.
    countOf(db, 'autosend_decisions', t((q) => q.eq('decision', 'sent').gte('created_at', since7d))),
    countOf(db, 'drip_sends', t((q) => q.eq('status', 'sent').gte('sent_at', since7d))),
    db.from('agent_jobs').select('status, result, completed_at')
      .eq('tenant_id', tenantId).eq('agent_name', 'sequence-recovery')
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (leadRows.error || leadRows.truncated) {
    throw leadRows.error || new Error('growth lead inventory exceeded safe query bound');
  }
  const leadFunnel = computeLeadFunnel(leadRows.data);
  if (recoveryJob.error) throw new Error(`sequence recovery evidence unavailable: ${recoveryJob.error.message}`);
  const recoveryResult = recoveryJob.data?.status === 'completed' ? recoveryJob.data.result || {} : null;
  const recoveryBacklog = recoveryBacklogCount(recoveryResult);

  return {
    funnel: {
      new_this_week: leadFunnel.new_this_week,
      enriched: leadFunnel.enriched,
      email_ready: leadFunnel.email_ready,
      phone_only: leadFunnel.phone_only,
      fb_only: leadFunnel.fb_only,
      no_contact: leadFunnel.no_contact,
      drafts_to_review: draftsToReview,
      active_sequences: activeDrip + activeOutreach,
      outreach_sent_7d: autosendSent7d + dripSent7d,
      autosend_sent_7d: autosendSent7d,
      drip_sent_7d: dripSent7d,
      replies: leadFunnel.replies,
      replies_7d: leadFunnel.replies_7d,
      interested: leadFunnel.interested,
      demos_booked: leadFunnel.demos_booked,
      proposals_sent: leadFunnel.proposals_sent,
      closed_won: leadFunnel.closed_won,
      contacted: leadFunnel.contacted,
      high_score: leadFunnel.high_score,
      followup_recovery_eligible: recoveryResult && Number.isFinite(Number(recoveryResult.eligible))
        ? Number(recoveryResult.eligible) : null,
      followup_recovery_deferred: recoveryBacklog,
      sequence_recovery_last_run_at: recoveryJob.data?.completed_at || null,
    },
    stage_counts: {
      enriched: leadFunnel.enriched,
      scored: leadFunnel.scored,
      sequenced: leadFunnel.sequenced,
      fb_only: leadFunnel.fb_only,
      unqualified: leadFunnel.unqualified,
    },
  };
}

/** Open ops_incidents that affect prospecting-engine agents (best-effort). */
async function fetchProspectingIncidents(db, tenantId) {
  const { data, error } = await db.from('ops_incidents').select('agent_name, issue_type, severity, business_impact, diagnosis_summary')
    .eq('tenant_id', tenantId)
    .in('status', ['open', 'remediating', 'awaiting_approval', 'escalated'])
    .order('detected_at', { ascending: false }).limit(50);
  if (error) throw new Error(`prospecting incidents unavailable: ${error.message}`);
  return (data || []).filter((i) => PROSPECTING_AGENTS.includes(i.agent_name));
}

/** Derive stall alerts from the funnel + incidents. Pure. */
function deriveAlerts(funnel, incidents) {
  const alerts = [];
  if (funnel.enriched >= ENRICHMENT_BACKLOG) {
    alerts.push({ id: 'enrichment_backlog', severity: 'warn',
      label: 'Enrichment backlog', detail: `${funnel.enriched} leads enriched but not yet scored/sequenced — scoring may be behind.` });
  }
  if (funnel.drafts_to_review >= DRAFTS_WAITING) {
    alerts.push({ id: 'drafts_waiting', severity: 'warn',
      label: 'Drafts need review', detail: `${funnel.drafts_to_review} outreach drafts genuinely need your decision; autonomously authorized drafts are excluded.` });
  }
  if (funnel.new_this_week === 0) {
    alerts.push({ id: 'no_new_prospects', severity: 'warn',
      label: 'No new prospects this week', detail: 'Prospecting has produced 0 leads in the last 7 days.' });
  }
  if (funnel.contacted > 0 && funnel.active_sequences === 0) {
    alerts.push({ id: 'sequence_continuity_gap', severity: 'urgent',
      label: 'Seven-touch continuity is empty', detail: `${funnel.contacted} contacted prospects exist, but zero current follow-up sequences are active.` });
  }
  for (const i of incidents) {
    alerts.push({ id: `incident_${i.agent_name}_${i.issue_type}`, severity: i.severity === 'red' ? 'urgent' : 'warn',
      label: `${i.agent_name}: ${i.issue_type.replace(/_/g, ' ')}`, detail: i.business_impact || i.diagnosis_summary || 'See Agent Hub for detail.' });
  }
  return alerts;
}

/** Build the Next Best Actions list. Each links to a real queue/page. Pure. */
function deriveNextActions(funnel, focus, alerts) {
  const actions = [];
  const push = (id, label, count, severity, link) => actions.push({ id, label, count, severity, link });

  if (focus && focus.status === 'recommended') {
    push('approve_focus', `Approve this week's campaign focus${focus.vertical ? ` (${focus.vertical})` : ''}`, null, 'action', '/admin/growth');
  }
  if (funnel.drafts_to_review > 0) {
    push('approve_drafts', `Approve ${funnel.drafts_to_review} outreach draft${funnel.drafts_to_review === 1 ? '' : 's'}`, funnel.drafts_to_review, 'action', '/admin/pipeline?view=drafts-to-review');
  }
  if (funnel.replies > 0) {
    push('check_replies', `Check ${funnel.replies} replied lead${funnel.replies === 1 ? '' : 's'}`, funnel.replies, 'action', '/admin/pipeline?view=replied');
  }
  if (funnel.high_score > 0) {
    push('review_high_score', `Advance ${funnel.high_score} high-score prospect${funnel.high_score === 1 ? '' : 's'} into bounded cohorts`, funnel.high_score, 'info', '/admin/pipeline?view=high-score');
  }
  if (Number(funnel.followup_recovery_deferred) > 0) {
    push('recover_sequence_continuity', `Restore seven-touch continuity for ${funnel.followup_recovery_deferred} provider-proven prospect${funnel.followup_recovery_deferred === 1 ? '' : 's'}`, funnel.followup_recovery_deferred, 'warn', '/admin/drip-campaign');
  }
  if (funnel.no_contact > 0) {
    push('review_no_contact', `Recover contact evidence for ${funnel.no_contact} unreachable prospect${funnel.no_contact === 1 ? '' : 's'}`, funnel.no_contact, 'info', '/admin/pipeline?view=no-reachable-contact');
  }
  if (funnel.fb_only > 0) {
    push('recover_facebook_contacts', `Recover email channels for ${funnel.fb_only} Facebook-only prospect${funnel.fb_only === 1 ? '' : 's'}`, funnel.fb_only, 'info', '/admin/pipeline?view=facebook-only');
  }
  if (alerts.some((a) => a.id === 'no_new_prospects')) {
    push('refill_queue', 'Refill the prospecting queue for next week', null, 'warn', '/admin/targeted-campaigns');
  }
  return actions;
}

/** Resolve the week's focus from tenant_config (prospecting rotation = source of truth). */
function deriveFocus(tenant) {
  const active = getConfig(tenant, 'prospecting_active_industries', []) || [];
  const states = getConfig(tenant, 'target_states', []) || [];
  return {
    week_start: currentWeekStart(),
    vertical: Array.isArray(active) && active.length ? active.join(', ') : null,
    geography: Array.isArray(states) && states.length ? states.slice(0, 6).join(', ') + (states.length > 6 ? '…' : '') : null,
    angle: getConfig(tenant, 'prospecting_icp_notes', null),
    weekly_target: getConfig(tenant, 'weekly_prospect_target', 50),
  };
}

/**
 * Build the full snapshot object (does NOT persist — the agent writes it).
 * Returns { focus, funnel, stage_counts, next_actions, alerts }.
 */
async function buildSnapshot(db, tenant) {
  const baseFocus = deriveFocus(tenant);
  const [{ funnel, stage_counts }, incidents] = await Promise.all([
    computeFunnel(db, tenant.id),
    fetchProspectingIncidents(db, tenant.id),
  ]);
  const alerts = deriveAlerts(funnel, incidents);
  // Patrick's standing rule is wide-industry, size-first outreach. A rotating
  // research mix may guide discovery, but it is not a weekly owner decision.
  // Treating it as one kept placing a fake approval in the Chief Revenue
  // Agent's handoff surface even though no approval was required.
  const next_actions = deriveNextActions(funnel, { ...baseFocus, status: 'standing' }, alerts);
  return { focus: baseFocus, funnel, stage_counts, next_actions, alerts };
}

module.exports = {
  buildSnapshot,
  computeFunnel,
  deriveAlerts,
  deriveNextActions,
  deriveFocus,
  currentWeekStart,
  countDraftsToReview,
  countAuthenticLeadState,
  computeLeadFunnel,
  contactBucket,
  recoveryBacklogCount,
  PROSPECTING_AGENTS,
};
