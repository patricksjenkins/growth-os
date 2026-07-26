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
/** A draft older than this is regenerated rather than sent. */
const MAX_DRAFT_AGE_DAYS = 3;

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

module.exports = {
  isActionableDraft,
  countActionableDrafts,
  DEFAULT_QUALITY_THRESHOLD,
  MAX_DRAFT_AGE_DAYS,
};
