'use strict';

/**
 * FGA prospect lifecycle monotonicity.
 *
 * Enrichment and scoring are research steps. Re-running either one to refresh
 * evidence must never move a prospect backwards after outreach or a reply.
 * Customer tenants deliberately retain their deployed state behavior; callers
 * apply this contract only inside the exact FGA boundary.
 */

const STAGE_RANK = Object.freeze({
  prospect: 0,
  new: 0,
  enriched: 1,
  scored: 2,
  sequenced: 3,
  contacted: 3,
  replied: 4,
  engaged: 4,
  nurture: 4,
  interested: 5,
  sales_call: 6,
  meeting_booked: 7,
  demo_booked: 7,
  quoted: 8,
  trial_active: 9,
  customer: 10,
  won: 10,
});

const STATUS_FLOOR = Object.freeze({
  contacted: 'sequenced',
  replied: 'replied',
  nurture: 'nurture',
  interested: 'interested',
  demo_booked: 'demo_booked',
  quoted: 'quoted',
  trial_active: 'trial_active',
  won: 'customer',
});

const TERMINAL_STATUS = new Set([
  'lost', 'rejected', 'declined', 'disqualified', 'unsubscribed', 'bounced',
]);

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Return the furthest evidenced lifecycle stage for an FGA research write.
 * Unknown/terminal existing stages fail closed and are preserved rather than
 * overwritten by an earlier research stage.
 */
function fgaLifecycleAfterResearch(lead = {}, proposedStage) {
  const proposed = normalized(proposedStage);
  const current = normalized(lead.lifecycle_stage);
  const status = normalized(lead.status);

  if (!proposed) return current || null;
  if (TERMINAL_STATUS.has(status)) return current || proposed;
  if (current && STAGE_RANK[current] === undefined) return current;

  const candidates = [proposed, current, STATUS_FLOOR[status]].filter(Boolean);
  return candidates.reduce((furthest, stage) => {
    const rank = STAGE_RANK[stage];
    if (rank === undefined) return furthest;
    return STAGE_RANK[furthest] >= rank ? furthest : stage;
  }, proposed);
}

module.exports = { fgaLifecycleAfterResearch, STAGE_RANK, STATUS_FLOOR };
