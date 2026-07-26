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

const {
  FGA_TENANT_ID, etDayRangeIso, etParts, countFirstTouchSends,
} = require('./daily-outcome');

/**
 * Same-day flow stages, in order. Deliberately short: every one of these
 * measures the SAME population moving through one business day, so the counts
 * chain. Standing totals (leads, emails, scores, open drafts) are stock, not
 * flow, and are reported separately under `inventory`.
 */
const STAGES = Object.freeze([
  'drafts_available', 'gate_evaluated', 'gate_passed', 'provider_accepted',
]);

const OWNER_AGENT = Object.freeze({
  drafts_available: 'outreach',
  gate_evaluated: 'auto-outreach',
  gate_passed: 'auto-outreach',
  provider_accepted: 'auto-outreach / outreach-send',
});

/** Human labels for the stock figures, so the UI need not invent them. */
const INVENTORY_LABELS = Object.freeze({
  totalLeads: 'Leads in database',
  withEmail: 'With an email address',
  qualified: 'Scored and contactable',
  sendReady: 'Drafts ready to send',
  sequencesLifetime: 'Sequences sent (all time)',
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

  // "Qualified" uses the SAME bar the send gate enforces
  // (autosend_score_threshold, default 60) — not merely "has any score". The
  // earlier definition counted a lead scored 5 as qualified, which the gate
  // would then reject, making the funnel disagree with the machine it
  // describes.
  let scoreThreshold = 60;
  try {
    const { data: cfgRow } = await db.from('tenant_config').select('value')
      .eq('tenant_id', tenantId).eq('key', 'autosend_score_threshold').limit(1);
    const n = Number(cfgRow?.[0]?.value);
    if (Number.isFinite(n) && n > 0) scoreThreshold = n;
  } catch { /* default matches core/auto-outreach.js DEFAULTS.scoreThreshold */ }

  // Latest row per stage — "when did this stage last produce anything?" is
  // what turns "count is low" into "this agent has not produced output since
  // Tuesday", which is the diagnosable statement.
  const latestAt = (table, build) =>
    build(T(db.from(table).select('created_at')))
      .order('created_at', { ascending: false }).limit(1)
      .then((r) => r.data?.[0]?.created_at || null, () => null);

  const [
    totalLeads, withEmail, scored, qualifiedWithEmail, newLeadPool,
    draftsOpen, decisionRows, sentToday, enrolledRows,
    lastLeadAt, lastDraftAt, lastSentAt,
  ] = await Promise.all([
    countRows(db, 'leads', (q) => T(q)),
    countRows(db, 'leads', (q) => T(q).not('email', 'is', null)),
    countRows(db, 'leads', (q) => T(q).not('lead_score', 'is', null)),
    // Contactable AND at-or-above the gate's own threshold — a true subset of
    // withEmail, and the population the sender can actually use.
    countRows(db, 'leads', (q) => T(q).not('email', 'is', null).gte('lead_score', scoreThreshold)),
    countRows(db, 'leads', (q) => T(q).eq('status', 'new_lead')),
    countRows(db, 'outreach_sequences', (q) =>
      T(q).eq('sequence_type', 'email').eq('sequence_status', 'draft')),
    T(db.from('autosend_decisions').select('decision, reason, created_at, lead_id'))
      .gte('created_at', startIso).lt('created_at', endIso)
      .order('created_at', { ascending: false }).limit(2000)
      .then((r) => r.data || [], () => []),
    // The SAME verified counter the invariant and the guardian use. A raw row
    // count here would let the funnel show sends the invariant does not
    // recognise, and two surfaces disagreeing about "did it happen" is how the
    // department went unnoticed-broken in the first place.
    countFirstTouchSends(db, { date, tenantId }).then((r) => r.count, () => 0),
    countRows(db, 'outreach_sequences', (q) =>
      T(q).eq('sequence_type', 'email').in('sequence_status', ['sent', 'sending'])),
    latestAt('leads', (q) => q),
    latestAt('outreach_sequences', (q) => q.eq('sequence_type', 'email')),
    latestAt('outreach_sequences', (q) => q.eq('sequence_type', 'email').in('sequence_status', ['sent', 'sending'])),
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

  /**
   * TODAY'S FLOW — one population, one day, strictly monotonic.
   *
   * The first version of this array chained `input` from the previous stage's
   * output while sourcing each `output` from an unrelated query: a lifetime
   * count, a current stock, or a same-day decision. Live production therefore
   * rendered 575 "qualified" out of 295 "contactable" and 164 "sequenced" out
   * of 0 sends — arithmetic that cannot happen in a funnel, on the one surface
   * meant to be trustworthy evidence.
   *
   * The fix is a boundary, not a patch. Stock (how much inventory exists right
   * now) is reported separately as `inventory`; only same-day flow appears
   * here, where every input equals the previous output and no stage can emit
   * more than it received. assertMonotonic enforces both.
   */
  const evaluated = decisionRows.length;

  /**
   * `draftsOpen` is a CURRENT stock reading — how many drafts sit on the shelf
   * right now. That is the correct head of the funnel for today, but it says
   * nothing about how many were available on some past date, and there is no
   * historical record to reconstruct it from. Replaying 2026-07-23 against
   * today's stock produced "136 evaluated from 96 available", an anomaly that
   * was an artefact of the question, not a real fault.
   *
   * So the stage is included only when tracing today. For a past day the
   * funnel starts where the evidence actually starts: the gate ledger.
   */
  const tracingToday = etDate === etParts(new Date()).date;
  const stages = [
    ...(tracingToday
      ? [{ id: 'drafts_available', input: draftsOpen, output: draftsOpen, blocked: 0 }]
      : []),
    // Of those, how many the gate engine actually looked at. Drafts the gate
    // has not evaluated YET are `waiting`, not `blocked` — before the day's
    // first dispatch window every draft is unevaluated, and the live trace was
    // labelling all 96 as "blocked" at 8am, which reads as a fault when it is
    // simply inventory queued for a run that has not happened. `blocked` is
    // reserved for work something explicitly declined.
    { id: 'gate_evaluated',
      input: tracingToday ? draftsOpen : evaluated,
      output: evaluated,
      blocked: 0,
      waiting: tracingToday ? Math.max(0, draftsOpen - evaluated) : 0 },
    // Of those evaluated, how many the gates cleared for sending.
    { id: 'gate_passed', input: evaluated, output: sendDecisions,
      blocked: Math.max(0, evaluated - sendDecisions) },
    // Of those cleared, how many the provider actually accepted. This is the
    // only stage whose output is a delivered email, and it is the invariant.
    { id: 'provider_accepted', input: sendDecisions, output: sentToday,
      blocked: Math.max(0, sendDecisions - sentToday) },
  ].map((s) => ({
    ...s,
    agent: OWNER_AGENT[s.id],
    reasons: s.id === 'gate_passed' ? blockReasons : [],
  }));

  const anomalies = validateStages(stages);

  return {
    etDate,
    stages,
    anomalies,
    blockers,
    blockReasons,
    /**
     * STOCK — current standing totals, NOT a same-day flow and not chainable.
     * `qualified` is a true subset of `withEmail` (scored AND has an email),
     * so it can never exceed it; the old field reported every scored lead in
     * the database, which is what produced the impossible 575-of-295.
     */
    inventory: {
      totalLeads,
      withEmail,
      scored,
      newLeadPool,
      sendReady: draftsOpen,
      qualified: qualifiedWithEmail,
      verifiedEmail: withEmail,
      sequencesLifetime: enrolledRows,
    },
    /**
     * SUPPLY CHAIN — the full pipeline the collapsed flow view lost, restored
     * honestly. Where `of` is present the count is a TRUE SUBSET of that
     * stage (monotone by construction — no 575-from-295). Stages without `of`
     * are different populations (drafts, sequences) and are labelled as such
     * instead of being chained into fake arithmetic. Suppression, dedupe,
     * quality and deliverability exclusions appear per-reason in blockReasons
     * at the gate stage, where they are actually enforced.
     */
    supplyChain: [
      { id: 'prospect_supply', kind: 'stock', count: totalLeads, agent: 'prospecting',
        last_output_at: lastLeadAt },
      { id: 'contactable', kind: 'stock', count: withEmail, agent: 'enrichment', of: 'prospect_supply',
        last_output_at: null },
      { id: 'qualified', kind: 'stock', count: qualifiedWithEmail, agent: 'scoring', of: 'contactable',
        score_threshold: scoreThreshold, last_output_at: null },
      { id: 'drafts_ready', kind: 'stock', count: draftsOpen, agent: 'outreach',
        last_output_at: lastDraftAt },
      { id: 'gate', kind: 'flow', count: evaluated, agent: 'auto-outreach',
        last_output_at: decisionRows[0]?.created_at || null },
      { id: 'sequences_lifetime', kind: 'stock', count: enrolledRows, agent: 'outreach-cadence / drip-campaign',
        last_output_at: lastSentAt },
    ],
    summary: {
      decisionsToday: evaluated,
      sendDecisionsToday: sendDecisions,
      sentToday,
      recoverableBlockers: recoverable.length,
      topBlocker: recoverable[0]?.reason || null,
    },
  };
}

/**
 * A funnel stage cannot emit more than it received, and each stage must be fed
 * by the one before it.
 *
 * This REPORTS violations rather than throwing. Throwing would take the whole
 * revenue panel down, and a blank panel is the silent failure this department
 * was rebuilt to eliminate — the CEO must see "these numbers disagree", not
 * nothing. A real case: a bulk or manual send is delivered without writing an
 * autosend_decisions row, so provider_accepted legitimately exceeds
 * gate_passed. That is worth surfacing, not crashing over.
 */
function validateStages(stages) {
  const anomalies = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    if (s.output > s.input) {
      anomalies.push({
        stage: s.id,
        detail: `emits ${s.output} from an input of ${s.input}`,
        likely: 'a send path that bypasses the gate ledger (bulk or manual send)',
      });
    }
    if (i > 0 && s.input !== stages[i - 1].output) {
      anomalies.push({
        stage: s.id,
        detail: `input ${s.input} does not match ${stages[i - 1].id} output ${stages[i - 1].output}`,
        likely: 'stages are reading different populations',
      });
    }
  }
  return anomalies;
}

/** The single most actionable blocker, or null when the funnel is clear. */
function primaryBlocker(trace) {
  const order = ['deliverability', 'configuration', 'provider', 'quality', 'capacity'];
  for (const cls of order) {
    if (trace.blockers[cls]) return { class: cls, detail: trace.blockers[cls] };
  }
  return null;
}

module.exports = {
  STAGES, OWNER_AGENT, INVENTORY_LABELS, REASON_CLASS,
  classifyReason, traceFunnel, primaryBlocker, validateStages,
};
