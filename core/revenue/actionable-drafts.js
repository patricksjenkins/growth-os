'use strict';

/**
 * ONE definition of "a draft the sender can still act on".
 *
 * WHY (Codex 2026-07-26, round 6)
 * `sendReady` counted every row with sequence_status='draft'. That includes
 * drafts the quality reviewer has already rejected — and because the verdict is
 * CACHED on the row, re-running the sender re-reads the same failing score and
 * rejects them again. So 17 dead drafts read as 17 units of ready inventory,
 * and the guardian's new "send-ready inventory outranks the diagnosis" rule
 * would keep queueing a sender that cannot possibly convert them, instead of
 * generating replacements.
 *
 * A number that says work is available when none is drives exactly the wrong
 * remediation. Three things disqualify a draft:
 *   1. a cached quality verdict below the send threshold — it will fail again
 *   2. staleness — a draft written days ago describes a stale moment, and the
 *      lead may since have been contacted, replied or been suppressed
 *   3. anything not actually in 'draft' state
 *
 * Everything that needs to know "is there work to send?" imports this.
 */

const { FGA_TENANT_ID } = require('../config');

/** Matches core/auto-outreach.js DEFAULTS.qualityThreshold. */
const DEFAULT_QUALITY_THRESHOLD = 70;
/**
 * A draft older than this is regenerated rather than sent.
 *
 * 7 days per Patrick, 2026-07-26 (was 3). A cold email should still reference a
 * moment that is roughly current, but a week is the realistic window before the
 * opening observation reads wrong — and a shorter window discards work that is
 * still perfectly usable.
 */
const MAX_DRAFT_AGE_DAYS = 7;

/**
 * Is this draft row still worth sending?
 * Pure, so it can be unit-tested and reused wherever rows are already loaded.
 */
function isActionableDraft(row, { qualityThreshold = DEFAULT_QUALITY_THRESHOLD, now = new Date() } = {}) {
  if (!row || row.sequence_status !== 'draft') return { ok: false, reason: 'not_a_draft' };

  const cached = (row.metadata || {}).autosend_quality;
  if (cached && cached.score != null && Number(cached.score) < qualityThreshold) {
    // The verdict is cached, so the sender will not re-score it — it is a
    // guaranteed rejection, not pending work.
    return { ok: false, reason: 'quality_failed', score: Number(cached.score) };
  }

  const created = row.created_at ? new Date(row.created_at) : null;
  if (created && (now.getTime() - created.getTime()) > MAX_DRAFT_AGE_DAYS * 86400000) {
    return { ok: false, reason: 'stale' };
  }
  return { ok: true };
}

/**
 * Count drafts the sender could still convert, and say what the rest are.
 * The breakdown matters: "0 actionable, 17 quality-failed" tells the guardian
 * to REDRAFT, where a bare 0 would only say "no inventory".
 */
async function countActionableDrafts(db, { tenantId = FGA_TENANT_ID, qualityThreshold, now = new Date() } = {}) {
  const { data, error } = await db.from('outreach_sequences')
    .select('id, sequence_status, metadata, created_at')
    .eq('tenant_id', tenantId)
    .eq('sequence_type', 'email')
    .eq('sequence_status', 'draft')
    .limit(2000);
  if (error) {
    // Fail closed: an unknown count must not be reported as available work.
    return { actionable: 0, total: 0, qualityFailed: 0, stale: 0, error: error.message };
  }
  const rows = data || [];
  let actionable = 0; let qualityFailed = 0; let stale = 0;
  for (const row of rows) {
    const verdict = isActionableDraft(row, { qualityThreshold, now });
    if (verdict.ok) actionable += 1;
    else if (verdict.reason === 'quality_failed') qualityFailed += 1;
    else if (verdict.reason === 'stale') stale += 1;
  }
  return { actionable, total: rows.length, qualityFailed, stale };
}

/**
 * Return leads whose draft is dead (stale or quality-failed) BUT who have never
 * actually been contacted, so the drafter will write them a fresh email.
 *
 * PATRICK, 2026-07-26: "the stale leads have never been contacted so we should
 * redraft any lead that we found a email should try to contact."
 *
 * He is right, and the numbers back it: 89 stale drafts spanned 2 June to 22
 * July, and in essentially every case the lead is STILL `new_lead`. Those are
 * not people we emailed and gave up on — they are prospects we wrote to and
 * then never mailed, because of the queue defects. Finding a working address is
 * the expensive part of prospecting; discarding it because our own pipeline
 * stalled would waste that work twice.
 *
 * Why they cannot simply be re-picked: drafting advances the lead to
 * lifecycle_stage 'sequenced', and the drafter only reads 'enriched'/'scored'.
 * So a lead with a dead draft is invisible to it forever. This supersedes the
 * dead draft and returns the lead to the pool.
 *
 * SAFETY: only leads with status='new_lead' — never contacted, never replied,
 * not a customer. Superseding a draft sends nothing; the fresh draft still
 * passes every gate, cap and suppression check before it can leave.
 */
async function recycleDeadDrafts(db, { tenantId = FGA_TENANT_ID, qualityThreshold, now = new Date(), limit = 500 } = {}) {
  const { data, error } = await db.from('outreach_sequences')
    .select('id, lead_id, sequence_status, metadata, created_at')
    .eq('tenant_id', tenantId)
    .eq('sequence_type', 'email')
    .eq('sequence_status', 'draft')
    .limit(limit);
  if (error) return { recycled: 0, error: error.message };

  const dead = (data || []).filter((row) => !isActionableDraft(row, { qualityThreshold, now }).ok);
  if (!dead.length) return { recycled: 0, examined: (data || []).length };

  // Only leads that were never contacted, and that still have an address.
  const leadIds = [...new Set(dead.map((d) => d.lead_id).filter(Boolean))];
  const eligible = new Set();
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data: leads } = await db.from('leads')
      .select('id, status, email')
      .eq('tenant_id', tenantId)
      .in('id', leadIds.slice(i, i + 200))
      .eq('status', 'new_lead');
    for (const l of leads || []) if (l.email) eligible.add(l.id);
  }

  const toRecycle = dead.filter((d) => eligible.has(d.lead_id));
  if (!toRecycle.length) return { recycled: 0, examined: (data || []).length, dead: dead.length };

  const { error: supErr } = await db.from('outreach_sequences')
    .update({ sequence_status: 'superseded' })
    .in('id', toRecycle.map((d) => d.id))
    .eq('tenant_id', tenantId);
  if (supErr) return { recycled: 0, error: `supersede failed: ${supErr.message}` };

  const { error: revErr } = await db.from('leads')
    .update({ lifecycle_stage: 'scored' })
    .in('id', [...new Set(toRecycle.map((d) => d.lead_id))])
    .eq('tenant_id', tenantId)
    .eq('status', 'new_lead')   // re-checked at write time; never widen the set
    .then((r) => r, (e) => ({ error: e }));
  if (revErr) return { recycled: 0, error: `lifecycle revert failed: ${revErr.message}` };

  return {
    recycled: toRecycle.length,
    leads_returned_to_pool: new Set(toRecycle.map((d) => d.lead_id)).size,
    examined: (data || []).length,
  };
}

module.exports = {
  isActionableDraft,
  countActionableDrafts,
  recycleDeadDrafts,
  DEFAULT_QUALITY_THRESHOLD,
  MAX_DRAFT_AGE_DAYS,
};
