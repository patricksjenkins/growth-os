/**
 * Sales coordination — the shared state that turns FGA's individual sales
 * agents into one department (2026-07-21).
 *
 * Three jobs, all additive to the existing machinery:
 *
 *  1. NEXT ACTIONS — every non-closed lead carries exactly ONE
 *     {next_best_action, next_action_owner, next_action_due_at}, derived by a
 *     pure rule function so two agents can never own the same lead's next
 *     step. The orchestrator agent sweeps these 3×/day.
 *  2. STALE-DRAFT SUPERSESSION — email drafts belonging to leads that already
 *     left `new_lead` are flipped to sequence_status='superseded' so they stop
 *     polluting candidate pools and counts. Scoped STRICTLY to
 *     sequence_type='email' (facebook_dm drafts feed the FB-DM queue and must
 *     keep status 'draft'; see admin-targeted-campaigns.js).
 *  3. HUMAN HANDOFF — one shared function that marks a lead as needing
 *     Patrick, writes the attention_queue item (deduped), pushes to his
 *     phone, and records the handoff in activity_log.
 *
 * Hard rules inherited from the platform: never sends, never calls a paid
 * API, all writes tenant-scoped, best-effort side channels never abort the
 * primary write. Kill switch: tenant_config sales_coordination_enabled
 * ('false' disables the orchestrator sweeps; handoff surfacing stays on —
 * losing an interested prospect silently is never the safe default).
 */

const { createLogger } = require('../logger');

const log = createLogger('sales-coordination');

// Lead statuses that mean "this sales motion is over" — next action cleared.
// (Distinct from NEVER_COLD_CONTACT, which answers a different question and
// also contains live engaged states like replied/demo_booked.) Single source:
// core/growth/lead-status.js.
const { CLOSED_STATUSES } = require('../growth/lead-status');

const OWNER = 'owner'; // the human (Patrick)

/**
 * Pure rule: one lead + context → exactly one next action (or null when the
 * lead is closed). Priority order matters: human-lane states first, then the
 * engaged pipeline, then the cold-outreach machine.
 *
 * ctx: {
 *   hasDraft        — lead has an email outreach_sequences row in 'draft'
 *   hasActiveEnrollment — active/paused drip enrollment exists
 *   nextTouchAt     — ISO of the enrollment's next send (may be null)
 *   autosendArmed   — autonomous_outreach_enabled for the tenant
 * }
 */
function deriveLeadNextAction(lead, ctx = {}) {
  if (!lead || CLOSED_STATUSES.has(lead.status)) return null;

  const inDays = (n) => new Date(Date.now() + n * 86400_000).toISOString();

  // --- Human lane (a real person is waiting) --------------------------------
  if (lead.status === 'replied' || lead.lifecycle_stage === 'interested') {
    return { action: 'sales_call', owner: OWNER, due_at: inDays(1) };
  }
  if (lead.lifecycle_stage === 'engaged') {
    return { action: 'answer_question', owner: OWNER, due_at: inDays(1) };
  }
  if (lead.status === 'demo_booked') {
    return lead.briefing_generated
      ? { action: 'sales_call', owner: OWNER, due_at: inDays(1) }
      : { action: 'prep_meeting', owner: 'meeting-prep', due_at: inDays(1) };
  }

  // --- Engaged pipeline (warm cadences own it) ------------------------------
  if (lead.status === 'quoted') {
    return { action: 'follow_up_proposal', owner: 'sales-nurture', due_at: inDays(3) };
  }
  if (lead.status === 'trial_active') {
    return { action: 'trial_checkin', owner: 'sales-nurture', due_at: inDays(7) };
  }
  if (lead.lifecycle_stage === 'nurture') {
    return { action: 'nurture_touch', owner: 'sales-nurture', due_at: inDays(30) };
  }

  // --- Contacted: the follow-up machine owns it -----------------------------
  if (lead.status === 'contacted') {
    return ctx.hasActiveEnrollment
      ? { action: 'await_sequence', owner: 'drip-campaign', due_at: ctx.nextTouchAt || null }
      : { action: 'enroll_followup', owner: 'drip-campaign', due_at: inDays(1) };
  }

  // --- New lead: the cold-outreach machine owns it --------------------------
  if (lead.status === 'new_lead') {
    if (ctx.hasDraft) {
      return {
        action: 'review_draft',
        owner: ctx.autosendArmed ? 'auto-outreach' : OWNER,
        due_at: inDays(2),
      };
    }
    if (lead.email) {
      return { action: 'draft_outreach', owner: 'outreach', due_at: inDays(2) };
    }
    if (lead.lifecycle_stage === 'fb_only') {
      return { action: 'facebook_dm', owner: 'facebook-prospecting', due_at: inDays(3) };
    }
    return { action: 'enrich', owner: 'enrichment', due_at: inDays(3) };
  }

  // Unknown/legacy status — surface rather than guess an owner.
  return { action: 'review_draft', owner: OWNER, due_at: inDays(2) };
}

/**
 * Flip email drafts on leads that already left new_lead to 'superseded'.
 * Verified against every sequence_status reader (2026-07-21 audit):
 *  - candidate pools / draft counts are new_lead-gated → no visible change;
 *  - approve/send/edit endpoints correctly refuse non-draft rows;
 *  - facebook_dm rows are NOT touched (their queue filters on 'draft').
 * Returns { superseded } count.
 */
async function supersedeStaleDrafts(db, tenantId) {
  const { data: seqs, error } = await db.from('outreach_sequences')
    .select('id, lead_id')
    .eq('tenant_id', tenantId)
    .eq('sequence_type', 'email')
    .eq('sequence_status', 'draft')
    .limit(3000);
  if (error) throw error;
  const byLead = new Map();
  for (const s of seqs || []) {
    if (!s.lead_id) continue;
    if (!byLead.has(s.lead_id)) byLead.set(s.lead_id, []);
    byLead.get(s.lead_id).push(s.id);
  }
  if (!byLead.size) return { superseded: 0 };

  const leadIds = [...byLead.keys()];
  const stale = [];
  for (let i = 0; i < leadIds.length; i += 200) {
    const chunk = leadIds.slice(i, i + 200);
    const { data: rows } = await db.from('leads')
      .select('id, status').eq('tenant_id', tenantId).in('id', chunk);
    for (const r of rows || []) {
      if (r.status !== 'new_lead') stale.push(...byLead.get(r.id));
    }
  }
  if (!stale.length) return { superseded: 0 };

  for (let i = 0; i < stale.length; i += 200) {
    const chunk = stale.slice(i, i + 200);
    const { error: upErr } = await db.from('outreach_sequences')
      .update({ sequence_status: 'superseded', updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
      .eq('sequence_status', 'draft') // don't clobber a concurrent claim to 'sending'
      .in('id', chunk);
    if (upErr) throw upErr;
  }

  await db.from('activity_log').insert({
    tenant_id: tenantId,
    agent: 'sales-orchestrator',
    action: 'drafts_superseded',
    entity_type: 'outreach_sequences',
    level: 'info',
    metadata: { count: stale.length, reason: 'lead_left_new_lead' },
  }).then(() => {}, () => {});

  log.info(`Superseded ${stale.length} stale email draft(s)`);
  return { superseded: stale.length };
}

/**
 * Batch sweep: give every non-closed lead its ONE next action. Writes only
 * rows whose action/owner/handoff-derived state actually changed (the sweep
 * runs 3×/day; unchanged leads cost zero writes). Never overwrites a fresher
 * human-lane action with a machine one: once next_action_owner='owner', only
 * a lead-state change (closed, or status moved on) re-derives it.
 */
async function computeNextActionsForLeads(db, tenant) {
  const tenantId = tenant.id;
  const autosendArmed = String(
    tenant.config?.autonomous_outreach_enabled ?? 'false'
  ) === 'true' && String(tenant.config?.autosend_paused ?? 'false') !== 'true';

  const { data: leads, error } = await db.from('leads')
    .select('id, status, lifecycle_stage, email, briefing_generated, next_best_action, next_action_owner, next_action_due_at')
    .eq('tenant_id', tenantId)
    .limit(5000);
  if (error) throw error;
  if (!leads || !leads.length) return { examined: 0, updated: 0, cleared: 0 };

  // Context lookups (two cheap set queries instead of N per-lead queries).
  const draftLeads = new Set();
  {
    const { data } = await db.from('outreach_sequences')
      .select('lead_id').eq('tenant_id', tenantId)
      .eq('sequence_type', 'email').eq('sequence_status', 'draft').limit(3000);
    for (const s of data || []) if (s.lead_id) draftLeads.add(s.lead_id);
  }
  const enrollment = new Map(); // lead_id -> next_send_at
  {
    const { data } = await db.from('drip_enrollments')
      .select('lead_id, next_send_at').eq('tenant_id', tenantId)
      .in('status', ['active', 'paused', 'review']).limit(5000);
    for (const e of data || []) enrollment.set(e.lead_id, e.next_send_at || null);
  }

  let updated = 0; let cleared = 0;
  for (const lead of leads) {
    const next = deriveLeadNextAction(lead, {
      hasDraft: draftLeads.has(lead.id),
      hasActiveEnrollment: enrollment.has(lead.id),
      nextTouchAt: enrollment.get(lead.id) || null,
      autosendArmed,
    });

    if (!next) {
      if (lead.next_best_action) {
        await db.from('leads').update({
          next_best_action: null, next_action_owner: null, next_action_due_at: null,
        }).eq('id', lead.id).eq('tenant_id', tenantId);
        cleared++;
      }
      continue;
    }

    const unchanged = lead.next_best_action === next.action
      && lead.next_action_owner === next.owner;
    if (unchanged) continue;

    // Respect the human lane: a machine-derived action never displaces an
    // existing owner-assigned one unless the new action is ALSO owner-lane
    // (e.g. review_draft -> sales_call after a reply) or the lead moved on.
    if (lead.next_action_owner === OWNER && next.owner !== OWNER) continue;

    await db.from('leads').update({
      next_best_action: next.action,
      next_action_owner: next.owner,
      next_action_due_at: next.due_at,
    }).eq('id', lead.id).eq('tenant_id', tenantId);

    await recordHandoff(db, {
      tenantId,
      leadId: lead.id,
      fromOwner: lead.next_action_owner || null,
      toOwner: next.owner,
      reason: 'orchestrator_sweep',
      nextAction: next.action,
      dueAt: next.due_at,
      sourceAgent: 'sales-orchestrator',
    });
    updated++;
  }

  return { examined: leads.length, updated, cleared };
}

/** Structured handoff trail — activity_log, best-effort, audited convention. */
async function recordHandoff(db, { tenantId, leadId, fromOwner, toOwner, reason, nextAction, dueAt, sourceAgent }) {
  await db.from('activity_log').insert({
    tenant_id: tenantId,
    agent: sourceAgent || 'sales-orchestrator',
    action: 'sales_handoff',
    entity_type: 'lead',
    entity_id: leadId,
    level: 'info',
    metadata: {
      from_owner: fromOwner || null,
      to_owner: toOwner,
      reason,
      next_action: nextAction,
      due_at: dueAt || null,
    },
  }).then(() => {}, () => {});
}

/**
 * The human-handoff lane. Marks the lead as needing Patrick, raises a deduped
 * attention_queue item, pushes to his phone, and records the handoff. The
 * caller's own writes (classification, enrollment stop) must happen FIRST —
 * everything in here is additive and, except the lead-field write, best-effort.
 *
 * opts: { reason, action='sales_call', summary, severity='red',
 *         attentionType (null = skip the attention item, e.g. when the caller
 *         already wrote one), conversationId, dueHours=24, producedBy }
 */
async function markHumanHandoff(db, tenantId, leadId, opts = {}) {
  const {
    reason, action = 'sales_call', summary = '', severity = 'red',
    attentionType, conversationId = null, dueHours = 24,
    producedBy = 'sales-coordination',
  } = opts;
  const now = new Date();
  const dueAt = new Date(now.getTime() + dueHours * 3600_000).toISOString();

  // 1. The lead fields — this is the primary write.
  const { error } = await db.from('leads').update({
    next_best_action: action,
    next_action_owner: OWNER,
    next_action_due_at: dueAt,
    human_handoff_reason: reason,
    handoff_at: now.toISOString(),
    last_reply_at: now.toISOString(),
    sales_call_status: action === 'sales_call' ? 'needed' : undefined,
  }).eq('id', leadId).eq('tenant_id', tenantId);
  if (error) throw error;

  // 2. Owner action (attention_queue), deduped per lead+type per 24h.
  if (attentionType) {
    try {
      const { data: recent } = await db.from('attention_queue')
        .select('id').eq('tenant_id', tenantId)
        .eq('type', attentionType).eq('entity_id', leadId)
        .is('resolved_at', null)
        .gte('produced_at', new Date(now.getTime() - 24 * 3600_000).toISOString())
        .limit(1);
      if (!recent || !recent.length) {
        await db.from('attention_queue').insert({
          tenant_id: tenantId,
          type: attentionType,
          severity,
          title: attentionType === 'sales_reply_interested'
            ? 'Interested prospect — sales call needed'
            : 'Prospect asked a question — needs your reply',
          summary: String(summary || '').slice(0, 400),
          entity_type: 'lead',
          entity_id: leadId,
          payload: { conversation_id: conversationId, reason, recommended_action: action },
          produced_by: producedBy,
        });
      }
    } catch (attErr) {
      log.warn(`attention item failed (non-fatal): ${attErr.message}`);
    }
  }

  // 3. Push to the owner's phone — best-effort.
  try {
    const { sendPushToTenant } = require('../../integrations/push');
    const PUSH_TITLES = {
      sales_call: '🔥 Interested prospect',
      answer_question: '💬 Prospect question',
      review_reply: '📨 Prospect replied — needs your read',
    };
    await sendPushToTenant(tenantId, {
      title: PUSH_TITLES[action] || 'A prospect needs you',
      body: String(summary || 'A prospect needs you.').slice(0, 160),
      data: { route: 'LeadDetail', lead_id: leadId, reason },
    });
  } catch (pushErr) {
    log.warn(`handoff push failed (non-fatal): ${pushErr.message}`);
  }

  // 4. Handoff trail.
  await recordHandoff(db, {
    tenantId, leadId, fromOwner: null, toOwner: OWNER,
    reason, nextAction: action, dueAt, sourceAgent: producedBy,
  });

  return { due_at: dueAt };
}

/**
 * Sales invariants for the snapshot/guardian: counts the dashboard and the
 * daily brief surface. All real counts, defensive (0 on error, never throws).
 */
async function salesInvariants(db, tenantId) {
  const safeCount = async (build) => {
    try {
      const { count } = await build();
      return count || 0;
    } catch (_) { return 0; }
  };
  const nowIso = new Date().toISOString();
  const [salesCallsNeeded, ownerOverdue, noNextAction, openSalesActions] = await Promise.all([
    // Must reconcile EXACTLY with the Pipeline 'sales-calls' queue predicate
    // (active leads whose next action belongs to the owner) — Pass-4 audit
    // caught the tile reading 0 while the queue it links to showed 5.
    safeCount(() => db.from('leads').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('next_action_owner', 'owner')
      .not('status', 'in', '(won,lost,rejected,declined,disqualified,no_response,unsubscribed,bounced)')),
    safeCount(() => db.from('leads').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('next_action_owner', OWNER).lt('next_action_due_at', nowIso)),
    safeCount(() => db.from('leads').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).is('next_best_action', null)
      .not('status', 'in', '(won,lost,rejected,declined,disqualified,no_response,unsubscribed,bounced)')),
    safeCount(() => db.from('attention_queue').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).like('type', 'sales_%').is('resolved_at', null)),
  ]);
  return {
    sales_calls_needed: salesCallsNeeded,
    owner_actions_overdue: ownerOverdue,
    no_next_action: noNextAction,
    owner_actions_open: openSalesActions,
  };
}

module.exports = {
  CLOSED_STATUSES,
  deriveLeadNextAction,
  supersedeStaleDrafts,
  computeNextActionsForLeads,
  recordHandoff,
  markHumanHandoff,
  salesInvariants,
};
