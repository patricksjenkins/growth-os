'use strict';

/**
 * Tier-2 handoff: Chief Revenue Agent -> reliability.
 *
 * Tier 1 is what the revenue guardian may safely do itself (requeue work,
 * suppress a bounced address, re-run the capped sender). Everything else —
 * a broken configuration, a provider outage, a remediation that cannot even
 * queue — is a RELIABILITY problem, and the revenue guardian has no business
 * guessing at it.
 *
 * Before this module existed those cases produced an empty remediation plan
 * and nothing more: no request was ever sent to anyone, so "Tier 2" was a
 * label on a dead end. This turns it into an actual handoff with three parts:
 *
 *   1. A REQUEST — a structured ops_incidents row addressed to the agent that
 *      owns the blocked stage, carrying the funnel verdict as diagnosis and a
 *      named requested action. Same ledger the Operations Guardian and the
 *      Agent Hub already read, so it lands in an existing workflow rather than
 *      a new inbox nobody watches.
 *   2. A CONTROL-RETURN CONTRACT — the handoff stays open and owned by
 *      reliability until sends resume. Revenue does not silently reclaim it.
 *   3. VERIFICATION — at every later checkpoint the revenue guardian re-checks
 *      each open handoff against the actual outcome and closes it only on
 *      evidence (sends happened), never on elapsed time or an agent's say-so.
 *
 * Read/write is confined to ops_incidents + attention_queue, both FGA-scoped.
 * Never sends email. Never changes configuration. Never touches money.
 */

const { FGA_TENANT_ID } = require('./daily-outcome');

/** Blocker class -> how much authority reliability is being handed. */
const TIER = Object.freeze({
  // A config error is repairable by an approved runbook, with owner approval.
  configuration: { issueType: 'revenue_blocked_configuration', permission: 2, severity: 'red' },
  // A provider outage is not ours to fix; it needs a human to decide to wait,
  // fail over, or contact the vendor.
  provider: { issueType: 'revenue_blocked_provider', permission: 3, severity: 'red' },
  // The guardian could not even queue recovery work: infrastructure fault.
  remediation_failed: { issueType: 'revenue_remediation_failed', permission: 3, severity: 'red' },
  // The funnel's own numbers disagree — evidence integrity, not sales.
  data_integrity: { issueType: 'revenue_funnel_anomaly', permission: 2, severity: 'amber' },
});

/** What reliability is actually being asked to do. Named, not implied. */
const REQUESTED_ACTION = Object.freeze({
  configuration: 'Repair the outbound configuration named in the diagnosis, then confirm the sender can evaluate drafts again.',
  provider: 'Confirm provider status and decide: wait, fail over, or contact the vendor. Revenue cannot proceed until sends are accepted.',
  remediation_failed: 'Restore the agent job queue. Revenue remediation could not enqueue recovery work at all.',
  data_integrity: 'Reconcile the funnel stages named in the diagnosis; the revenue dashboard is reporting counts that cannot both be true.',
});

const ACTIVE = ['open', 'remediating', 'awaiting_approval'];
const nowIso = () => new Date().toISOString();

/**
 * Open (or refresh) a Tier-2 handoff.
 *
 * Idempotent on (agent_name, issue_type) to match the partial unique index in
 * migration 057 — a blocker that persists for three days updates one row
 * rather than filing three tickets nobody reads.
 *
 * @returns {{ok:boolean, handoff:object|null, detail:string}}
 */
async function openHandoff(db, {
  blockerClass, owningAgent, diagnosis, businessImpact, evidence = {},
}) {
  const tier = TIER[blockerClass];
  if (!tier) return { ok: false, handoff: null, detail: `no Tier-2 route for '${blockerClass}'` };
  const agent = owningAgent || 'auto-outreach';

  // FGA-scoped on BOTH the lookup and the update. Without the tenant filter an
  // adversarial probe matched another tenant's incident by (agent, issue_type)
  // and this code updated it — a cross-tenant write from the revenue layer.
  const { data: found, error: findErr } = await db.from('ops_incidents')
    .select('id, attempt_count, remediation_attempted')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('agent_name', agent).eq('issue_type', tier.issueType)
    .in('status', ACTIVE).order('detected_at', { ascending: false }).limit(1);
  if (findErr) return { ok: false, handoff: null, detail: `lookup failed: ${findErr.message}` };

  const shared = {
    severity: tier.severity,
    business_impact: businessImpact,
    diagnosis_summary: diagnosis,
    latest_error: diagnosis,
    links_to_logs: { ...evidence, requested_action: REQUESTED_ACTION[blockerClass] },
    // Pending until sends actually resume. Reliability does not get to mark
    // its own homework, and neither does revenue.
    verification_result: 'pending',
    updated_at: nowIso(),
  };

  if (found && found.length) {
    const { data, error } = await db.from('ops_incidents')
      .update(shared).eq('id', found[0].id).eq('tenant_id', FGA_TENANT_ID)
      .select('id, status, issue_type, agent_name').limit(1);
    if (error) return { ok: false, handoff: null, detail: `update failed: ${error.message}` };
    return { ok: true, handoff: (data || [])[0] || { id: found[0].id }, detail: 'handoff refreshed' };
  }

  const { data, error } = await db.from('ops_incidents').insert({
    tenant_id: FGA_TENANT_ID,
    agent_name: agent,
    issue_type: tier.issueType,
    status: 'open',
    permission_level: tier.permission,
    // Level 3 is escalate-only: no automated repair may be attempted.
    requires_owner_approval: tier.permission >= 3,
    approval_reason: tier.permission >= 3 ? REQUESTED_ACTION[blockerClass] : null,
    ...shared,
  }).select('id, status, issue_type, agent_name').limit(1);
  if (error) return { ok: false, handoff: null, detail: `insert failed: ${error.message}` };
  return { ok: true, handoff: (data || [])[0] || null, detail: 'handoff opened' };
}

/**
 * Control return: close handoffs the outcome proves are fixed.
 *
 * `sendsResumed` is the ONLY thing that closes a revenue handoff. Not a
 * successful agent run, not a cleared error, not elapsed time — the department
 * exists to deliver emails, so delivered emails are the evidence. Anything
 * still open after that check is reported as still_failing so a stalled repair
 * surfaces instead of ageing quietly.
 */
async function verifyHandoffs(db, { sendsResumed }) {
  const { data, error } = await db.from('ops_incidents')
    .select('id, agent_name, issue_type, detected_at')
    .eq('tenant_id', FGA_TENANT_ID)
    .in('issue_type', Object.values(TIER).map((t) => t.issueType))
    .in('status', ACTIVE).limit(50);
  if (error) return { checked: 0, recovered: 0, stillFailing: 0, detail: error.message };
  const open = data || [];
  if (!open.length) return { checked: 0, recovered: 0, stillFailing: 0 };

  if (!sendsResumed) {
    await db.from('ops_incidents')
      .update({ verification_result: 'still_failing', updated_at: nowIso() })
      .eq('tenant_id', FGA_TENANT_ID)
      .in('id', open.map((r) => r.id)).then(() => {}, () => {});
    return { checked: open.length, recovered: 0, stillFailing: open.length };
  }

  const { error: upErr } = await db.from('ops_incidents').update({
    status: 'recovered',
    verification_result: 'recovered',
    remediation_result: 'Revenue outcome met; first-touch sends resumed.',
    resolved_at: nowIso(),
    updated_at: nowIso(),
  }).eq('tenant_id', FGA_TENANT_ID).in('id', open.map((r) => r.id));
  if (upErr) return { checked: open.length, recovered: 0, stillFailing: 0, detail: upErr.message };
  return { checked: open.length, recovered: open.length, stillFailing: 0 };
}

module.exports = { TIER, REQUESTED_ACTION, openHandoff, verifyHandoffs };
