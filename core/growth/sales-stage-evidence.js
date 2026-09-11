'use strict';

/**
 * Translate an owner-authenticated FGA pipeline stage change into append-only
 * Growth evidence. Owner acceptance has its own authenticated action and must
 * never be inferred from a later stage. Demo booked is an outcome milestone
 * but is intentionally not projected as a canonical stage until the database
 * enum is expanded.
 */
function evidenceForSalesStage(status) {
  switch (String(status || '').trim().toLowerCase()) {
    case 'replied':
      return [{ eventType: 'human_reply_owner_verified', stage: 'human_reply' }];
    case 'interested':
      return [{ eventType: 'warm_reply_owner_verified', stage: 'warm' }];
    case 'demo_booked':
      return [{ eventType: 'demo_booked', stage: null }];
    case 'demo_held':
    case 'appointment_held':
      return [{ eventType: 'demo_held_owner_verified', stage: 'demo_held' }];
    case 'quoted':
    case 'proposal_sent':
      return [{ eventType: 'proposal_sent_owner_verified', stage: 'proposal' }];
    case 'won':
    case 'closed_won':
      return [{ eventType: 'closed_won_owner_verified', stage: 'won' }];
    case 'lost':
    case 'closed_lost':
      return [{ eventType: 'closed_lost_owner_verified', stage: null }];
    default:
      return [];
  }
}

module.exports = { evidenceForSalesStage };
