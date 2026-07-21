/**
 * Lead-status sets — THE single source of truth (2026-07-21, Patrick-approved).
 *
 * Before this file, three modules kept their own "terminal statuses" sets
 * (suppression, the bulk-send gate, drip) and they disagreed — every
 * disagreement in the unsafe direction (the bulk-send gate would happily
 * first-touch a lead who had already REPLIED). Two named sets with distinct
 * meanings, and one union, cover every consumer:
 *
 *  CLOSED_STATUSES   — the sales motion is over. Nothing contacts them,
 *                      nothing owns a next action for them.
 *  ENGAGED_STATUSES  — a live human conversation exists. Automation steps
 *                      aside (no cold touches, no drip, no bulk sends);
 *                      the owner and the warm cadences take over.
 *  NEVER_COLD_CONTACT — the union. The answer to "may automation send this
 *                      lead a cold/sequence touch?" is NO for every member.
 *
 * Consumers (all import from here; legacy TERMINAL_LEAD_STATUSES exports are
 * kept as aliases so no call site changes shape):
 *  - core/growth/suppression.js   → NEVER_COLD_CONTACT
 *  - core/drip-campaign.js        → NEVER_COLD_CONTACT
 *  - api/routes/admin.js bulk send→ NEVER_COLD_CONTACT
 *  - core/sales/coordination.js   → CLOSED_STATUSES
 */

const CLOSED_STATUSES = new Set([
  'won', 'lost', 'rejected', 'declined', 'disqualified',
  'no_response', 'unsubscribed', 'bounced',
]);

const ENGAGED_STATUSES = new Set([
  'replied', 'interested', 'demo_booked', 'quoted', 'trial_active',
]);

const NEVER_COLD_CONTACT = new Set([...CLOSED_STATUSES, ...ENGAGED_STATUSES]);

module.exports = { CLOSED_STATUSES, ENGAGED_STATUSES, NEVER_COLD_CONTACT };
