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

const { getConfig } = require('../config');

// Tunables (env-overridable) for stall detection.
const ENRICHMENT_BACKLOG = Number(process.env.GROWTH_ENRICHMENT_BACKLOG || 30);
const DRAFTS_WAITING = Number(process.env.GROWTH_DRAFTS_WAITING || 15);
const HIGH_SCORE = 70;

const PROSPECTING_AGENTS = [
  'prospecting', 'enrichment', 'scoring', 'outreach',
  'targeted-campaign', 'facebook-prospecting', 'drip-campaign', 'reply-classification',
];

function isoDaysAgo(n) { return new Date(Date.now() - n * 86400_000).toISOString(); }

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
 * Accurate "drafts to review" — matches the Pipeline queue definition: leads
 * still at status='new_lead' that have a DRAFT email outreach sequence. A raw
 * outreach_sequences row count badly overcounts (multiple step rows per lead +
 * non-email types), which would false-fire the drafts_waiting alert.
 */
async function countDraftsToReview(db, tenantId) {
  const { data: seqs, error: sequenceError } = await db.from('outreach_sequences')
    .select('lead_id').eq('tenant_id', tenantId)
    .eq('sequence_type', 'email').eq('sequence_status', 'draft').limit(3000);
  if (sequenceError) throw new Error(`outreach draft inventory unavailable: ${sequenceError.message}`);
  const ids = [...new Set((seqs || []).map((s) => s.lead_id).filter(Boolean))];
  if (!ids.length) return 0;
  const { count, error: leadError } = await db.from('leads').select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).in('id', ids).eq('status', 'new_lead');
  if (leadError) throw new Error(`draft lead inventory unavailable: ${leadError.message}`);
  return count || 0;
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
    newThisWeek, enriched, scored, sequenced, fbOnly, unqualified,
    emailReady, phoneOnly, noContact, replied, interested, demos, proposals,
    closedWon, highScore, draftsToReview, activeDrip, activeOutreach,
    autosendSent7d, replies7d, dripSent7d,
  ] = await Promise.all([
    countOf(db, 'leads', t((q) => q.gte('created_at', since7d))),
    countOf(db, 'leads', t((q) => q.eq('lifecycle_stage', 'enriched'))),
    countOf(db, 'leads', t((q) => q.eq('lifecycle_stage', 'scored'))),
    countOf(db, 'leads', t((q) => q.eq('lifecycle_stage', 'sequenced'))),
    countOf(db, 'leads', t((q) => q.eq('lifecycle_stage', 'fb_only'))),
    countOf(db, 'leads', t((q) => q.eq('lifecycle_stage', 'unqualified'))),
    countOf(db, 'leads', t((q) => q.in('lifecycle_stage', ['enriched', 'scored']).not('email', 'is', null))),
    countOf(db, 'leads', t((q) => q.eq('status', 'new_lead').is('email', null).not('phone', 'is', null))),
    countOf(db, 'leads', t((q) => q.eq('status', 'new_lead').is('email', null).is('phone', null))),
    countOf(db, 'leads', t((q) => q.eq('status', 'replied'))),
    countOf(db, 'leads', t((q) => q.eq('status', 'interested'))),
    countOf(db, 'leads', t((q) => q.eq('status', 'demo_booked'))),
    countOf(db, 'leads', t((q) => q.eq('status', 'quoted'))),
    countOf(db, 'leads', t((q) => q.eq('status', 'won'))),
    countOf(db, 'leads', t((q) => q.gte('lead_score', HIGH_SCORE).not('status', 'in', '(won,lost,rejected,disqualified,no_response)'))),
    countDraftsToReview(db, tenantId),
    countOf(db, 'drip_enrollments', t((q) => q.in('status', ['active', 'paused']))),
    countOf(db, 'outreach_enrollments', t((q) => q.eq('status', 'active'))),
    // Outreach sent = the FIRST-touch autonomous sends (autosend_decisions)
    // PLUS the drip follow-up touches. Counting only drip_sends reported 0 all
    // week while 17 autonomous emails actually went out — the card said the
    // engine was dead when it was working.
    countOf(db, 'autosend_decisions', t((q) => q.eq('decision', 'sent').gte('created_at', since7d))),
    countOf(db, 'drip_inbound', t((q) => q.eq('classification', 'genuine_reply').gte('received_at', since7d))),
    countOf(db, 'drip_sends', t((q) => q.eq('status', 'sent').gte('sent_at', since7d))),
  ]);

  return {
    funnel: {
      new_this_week: newThisWeek,
      enriched, email_ready: emailReady, phone_only: phoneOnly,
      fb_only: fbOnly, no_contact: noContact,
      drafts_to_review: draftsToReview,
      active_sequences: activeDrip + activeOutreach,
      outreach_sent_7d: autosendSent7d + dripSent7d,
      autosend_sent_7d: autosendSent7d,
      drip_sent_7d: dripSent7d,
      replies: replied, replies_7d: replies7d, interested,
      demos_booked: demos, proposals_sent: proposals, closed_won: closedWon,
      high_score: highScore,
    },
    stage_counts: { enriched, scored, sequenced, fb_only: fbOnly, unqualified },
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
      label: 'Drafts piling up', detail: `${funnel.drafts_to_review} outreach drafts waiting for your approval.` });
  }
  if (funnel.new_this_week === 0) {
    alerts.push({ id: 'no_new_prospects', severity: 'warn',
      label: 'No new prospects this week', detail: 'Prospecting has produced 0 leads in the last 7 days.' });
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
    push('review_high_score', `Review ${funnel.high_score} high-score prospect${funnel.high_score === 1 ? '' : 's'}`, funnel.high_score, 'info', '/admin/pipeline?view=high-score');
  }
  if (funnel.no_contact > 0) {
    push('review_no_contact', `Review ${funnel.no_contact} prospect${funnel.no_contact === 1 ? '' : 's'} with no reachable contact`, funnel.no_contact, 'info', '/admin/pipeline?view=no-reachable-contact');
  }
  if (funnel.fb_only > 0) {
    push('facebook_dms', `${funnel.fb_only} Facebook-only prospect${funnel.fb_only === 1 ? '' : 's'} awaiting a DM`, funnel.fb_only, 'info', '/admin/pipeline?view=facebook-only');
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
  const next_actions = deriveNextActions(funnel, { ...baseFocus, status: 'recommended' }, alerts);
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
  PROSPECTING_AGENTS,
};
