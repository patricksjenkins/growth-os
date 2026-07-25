'use strict';

/**
 * Full-funnel trace for the FGA outbound sales department.
 *
 * The recurring failure was never "a gate is wrong" — it was that ~20 gates
 * can each independently stop sending, each records a clean skip, and nobody
 * could see WHICH one. Fixing them one at a time simply revealed the next.
 *
 * This walks the whole chain in one read and reports, per stage:
 *   input · output · blocked · block reasons · oldest blocked · owning agent
 *
 * Read-only. No writes, no sends, no paid APIs. FGA-scoped by construction.
 */

const { FGA_TENANT_ID, etDayRangeIso, etParts } = require('./daily-outcome');

/** Stage ids in pipeline order. */
const STAGES = Object.freeze([
  'prospect_supply', 'contactable', 'qualified', 'drafted',
  'gate_evaluated', 'send_ready', 'sent', 'sequenced',
]);

const OWNER_AGENT = Object.freeze({
  prospect_supply: 'prospecting',
  contactable: 'enrichment',
  qualified: 'scoring',
  drafted: 'outreach',
  gate_evaluated: 'auto-outreach',
  send_ready: 'auto-outreach',
  sent: 'auto-outreach / outreach-send',
  sequenced: 'outreach-cadence / drip-campaign',
});

/**
 * Gate reasons grouped into the blocker classes the invariant understands.
 * `terminal` reasons are correct exclusions (a customer, a suppressed
 * address) — they are NOT department failures and must not raise incidents.
 */
const REASON_CLASS = Object.freeze({
  // Correct, permanent exclusions — healthy behaviour.
  valid_email: 'terminal', inbound_lead: 'terminal', not_customer: 'terminal',
  blocklist: 'terminal', suppression: 'terminal', dedupe: 'terminal',
  icp_fit: 'terminal', lead_state: 'terminal', first_touch_only: 'terminal',
  not_enrolled: 'terminal',
  // Recoverable — these are what the guardian acts on.
  deliverability: 'deliverability',
  kill_switch: 'configuration',
  postal_address_config: 'configuration',
  gate_error: 'configuration',
  daily_cap: 'capacity',
  score_threshold: 'quality',
  draft_quality: 'quality',
});

const classifyReason = (r) => REASON_CLASS[r] || 'unknown';

async function countRows(db, table, build) {
  const q = build(db.from(table).select('id', { count: 'exact', head: true }));
  const { count, error } = await q;
  if (error) throw new Error(`${table} count failed: ${error.message}`);
  return count || 0;
}

/**
 * Trace the funnel for a given day.
 * @returns {{stages:Array, blockers:Object, inventory:Object, summary:Object}}
 */
async function traceFunnel(db, { date = new Date(), tenantId = FGA_TENANT_ID } = {}) {
  const { date: etDate } = etParts(date);
  const { startIso, endIso } = etDayRangeIso(etDate);
  const T = (q) => q.eq('tenant_id', tenantId);

  const [
    totalLeads, withEmail, scored, newLeadPool,
    draftsOpen, decisionRows, sentToday, enrolledRows,
  ] = await Promise.all([
    countRows(db, 'leads', (q) => T(q)),
    countRows(db, 'leads', (q) => T(q).not('email', 'is', null)),
    countRows(db, 'leads', (q) => T(q).not('lead_score', 'is', null)),
    countRows(db, 'leads', (q) => T(q).eq('status', 'new_lead')),
    countRows(db, 'outreach_sequences', (q) =>
      T(q).eq('sequence_type', 'email').eq('sequence_status', 'draft')),
    T(db.from('autosend_decisions').select('decision, reason, created_at, lead_id'))
      .gte('created_at', startIso).lt('created_at', endIso)
      .order('created_at', { ascending: false }).limit(2000)
      .then((r) => r.data || [], () => []),
    countRows(db, 'activity_log', (q) =>
      T(q).eq('action', 'outreach_sent').gte('created_at', startIso).lt('created_at', endIso)),
    countRows(db, 'outreach_sequences', (q) =>
      T(q).eq('sequence_type', 'email').in('sequence_status', ['sent', 'sending'])),
  ]);

  // Today's gate decisions, grouped by reason.
  const byReason = new Map();
  let sendDecisions = 0;
  for (const d of decisionRows) {
    if (d.decision === 'sent' || d.decision === 'send') { sendDecisions++; continue; }
    const key = d.reason || 'unknown';
    const cur = byReason.get(key) || { reason: key, count: 0, class: classifyReason(key), oldest: d.created_at };
    cur.count++;
    if (d.created_at < cur.oldest) cur.oldest = d.created_at;
    byReason.set(key, cur);
  }
  const blockReasons = [...byReason.values()].sort((a, b) => b.count - a.count);

  // Recoverable blockers only — a suppressed address is not a failure.
  const recoverable = blockReasons.filter((r) => r.class !== 'terminal' && r.class !== 'unknown');
  const blockers = {};
  for (const r of recoverable) {
    if (!blockers[r.class]) blockers[r.class] = `${r.count} blocked on ${r.reason}`;
  }

  const stages = [
    { id: 'prospect_supply', input: totalLeads, output: totalLeads, blocked: 0 },
    { id: 'contactable', input: totalLeads, output: withEmail, blocked: totalLeads - withEmail },
    { id: 'qualified', input: withEmail, output: scored, blocked: Math.max(0, withEmail - scored) },
    { id: 'drafted', input: newLeadPool, output: draftsOpen, blocked: Math.max(0, newLeadPool - draftsOpen) },
    { id: 'gate_evaluated', input: draftsOpen, output: decisionRows.length, blocked: 0 },
    { id: 'send_ready', input: decisionRows.length, output: sendDecisions,
      blocked: decisionRows.length - sendDecisions },
    { id: 'sent', input: sendDecisions, output: sentToday, blocked: Math.max(0, sendDecisions - sentToday) },
    { id: 'sequenced', input: sentToday, output: enrolledRows, blocked: 0 },
  ].map((s) => ({
    ...s,
    agent: OWNER_AGENT[s.id],
    reasons: s.id === 'send_ready' ? blockReasons : [],
  }));

  return {
    etDate,
    stages,
    blockers,
    blockReasons,
    inventory: {
      totalLeads,
      withEmail,
      scored,
      newLeadPool,
      sendReady: draftsOpen,
      qualified: scored,
      verifiedEmail: withEmail,
    },
    summary: {
      decisionsToday: decisionRows.length,
      sendDecisionsToday: sendDecisions,
      sentToday,
      recoverableBlockers: recoverable.length,
      topBlocker: recoverable[0]?.reason || null,
    },
  };
}

/** The single most actionable blocker, or null when the funnel is clear. */
function primaryBlocker(trace) {
  const order = ['deliverability', 'configuration', 'provider', 'quality', 'capacity'];
  for (const cls of order) {
    if (trace.blockers[cls]) return { class: cls, detail: trace.blockers[cls] };
  }
  return null;
}

module.exports = { STAGES, OWNER_AGENT, REASON_CLASS, classifyReason, traceFunnel, primaryBlocker };
