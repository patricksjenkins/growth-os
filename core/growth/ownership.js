/**
 * Growth Engine — canonical agent ownership map + overlap rules.
 *
 * Pure data. Encodes the brief's ownership model so the Agent Hub can show, for
 * every prospecting-related agent, what it owns / triggers on / reads / writes /
 * hands off to — and so overlapping ownership (two agents touching the same
 * record type or send channel) is flagged with the agreed handoff rule rather
 * than left for the owner to guess.
 *
 * This drives UI only. It changes no behavior.
 */

// The 8 owner-facing categories.
const CATEGORIES = [
  { key: 'prospecting_growth', label: 'Prospecting & Growth' },
  { key: 'outreach_comms', label: 'Outreach & Communication' },
  { key: 'voice_engagement', label: 'Voice & Engagement' },
  { key: 'content_social', label: 'Content & Social' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'back_office', label: 'Back Office & Financial' },
  { key: 'onboarding_platform', label: 'Onboarding & Platform' },
  { key: 'internal_ops', label: 'Internal Operations / Reliability' },
];

// agent → ownership card. `channel` is the outbound channel it can send on
// (null = no outbound). `handoffTo` is the next agent/page in the flow.
const OWNERSHIP = {
  // ── Prospecting & Growth ──
  'prospecting-orchestrator': { category: 'prospecting_growth', owns: 'End-to-end prospecting workflow coordination + funnel reporting', triggers: 'Cron 3×/day (FGA-only)', reads: 'leads, agent_jobs, ops_incidents, tenant_config', writes: 'growth_engine_snapshots, growth_campaign_focus', handoffTo: 'prospecting', channel: null },
  'prospecting': { category: 'prospecting_growth', owns: 'Standard weekly prospect discovery (50/wk ceiling)', triggers: 'Cron daily 6am ET', reads: 'tenant_config, leads (dedupe)', writes: 'leads (lifecycle_stage=prospect→enriched)', handoffTo: 'enrichment', channel: null },
  'targeted-campaign': { category: 'prospecting_growth', owns: 'Owner-defined targeted campaigns only', triggers: 'Cron 6:30am ET — only when a campaign is executable', reads: 'targeted_campaigns, leads (dedupe)', writes: 'leads, outreach_sequences (drafts)', handoffTo: 'outreach (owner approval)', channel: null },
  'facebook-prospecting': { category: 'prospecting_growth', owns: 'Facebook-only prospect channel (fb_only leads)', triggers: 'Cron 2pm ET daily', reads: 'leads (lifecycle_stage=fb_only)', writes: 'leads (text_message_sent/nurture), conversations (FB DM draft)', handoffTo: 'owner (manual FB DM)', channel: 'sms' },
  'enrichment': { category: 'prospecting_growth', owns: 'Contact / social / website details', triggers: 'Inline in prospecting + cron 8am ET', reads: 'leads (prospect)', writes: 'leads (email/fb/website, lifecycle_stage)', handoffTo: 'scoring / facebook-prospecting', channel: null },
  'scoring': { category: 'prospecting_growth', owns: 'Fit + pain score (ICP qualification)', triggers: 'Cron 7:30am ET weekdays + event', reads: 'leads (enriched), tenant_config ICP', writes: 'leads (lead_score, lifecycle_stage=scored)', handoffTo: 'outreach', channel: null },

  // ── Outreach & Communication ──
  'outreach': { category: 'outreach_comms', owns: 'Cold outreach COPY (drafts only, never auto-sends)', triggers: 'Cron 9am ET Mon-Sat', reads: 'leads (enriched/scored)', writes: 'outreach_sequences (draft), leads (sequenced)', handoffTo: 'owner approval → drip-campaign', channel: 'email' },
  'scheduled-email-dispatch': { category: 'outreach_comms', owns: 'Sends approved SCHEDULED emails (onboarding check-ins, etc.)', triggers: 'Cron hourly', reads: 'scheduled_emails (pending)', writes: 'scheduled_emails (sent)', handoffTo: null, channel: 'email' },
  'drip-campaign': { category: 'outreach_comms', owns: 'FGA cold-EMAIL cadence (Days 7-180)', triggers: 'Cron every 30min 9-11:30am ET (FGA-only)', reads: 'drip_enrollments, drip_suppressions, leads', writes: 'drip_sends, drip_enrollments, leads (status)', handoffTo: 'reply-classification', channel: 'email' },
  'follow-up': { category: 'outreach_comms', owns: 'Estimate / customer follow-up (NOT cold prospecting)', triggers: 'Cron Mon/Wed/Fri 11am ET', reads: 'leads (contacted), contacts (drip_stage)', writes: 'contacts (drip_stage), messages', handoffTo: null, channel: 'sms+email' },
  'outreach-cadence': { category: 'outreach_comms', owns: 'Tenant Outreach Center (review/quote/referral/commercial)', triggers: 'Cron 10am/1pm/4pm ET — only when an enrollment is due', reads: 'outreach_enrollments (due)', writes: 'outreach_messages (drafts), outreach_enrollments', handoffTo: 'owner approval', channel: 'email+sms' },
  'reply-classification': { category: 'outreach_comms', owns: 'Classifies inbound replies; stops/continues automation', triggers: 'Cron half-hourly weekdays', reads: 'conversations (inbound)', writes: 'conversations (classification), leads (status), suppressions', handoffTo: 'sales-nurture / conversation-responder', channel: null },
  'sales-nurture': { category: 'outreach_comms', owns: 'Prospects already in sales / demo pipeline', triggers: 'Cron daily 9am ET (FGA-only)', reads: 'leads (demo_booked/trial_active/nurture)', writes: 'messages (email)', handoffTo: null, channel: 'email' },
  'partner-outreach': { category: 'outreach_comms', owns: 'Warm referral-partner relationships', triggers: 'Cron Tue/Thu 11am + Mon 9am ET', reads: 'contacts (referral_partner)', writes: 'contacts (outreach_status), messages', handoffTo: null, channel: 'email+sms' },
  'past-customer-reengagement': { category: 'outreach_comms', owns: 'Reactivate dormant won customers', triggers: 'Cron Wed 9am ET', reads: 'leads (won, dormant 6mo)', writes: 'leads (status=contacted), messages', handoffTo: 'follow-up', channel: 'sms+email' },

  // ── Voice & Engagement ──
  'conversation-responder': { category: 'voice_engagement', owns: 'Inbound SMS multi-turn conversations', triggers: 'Event — inbound SMS webhook', reads: 'conversations (history)', writes: 'conversations (outbound SMS)', handoffTo: null, channel: 'sms' },
  'voice-receptionist': { category: 'voice_engagement', owns: 'AI voice call answering + lead capture', triggers: 'Event — Vapi end-of-call', reads: 'call transcript', writes: 'leads, conversations', handoffTo: 'enrichment → scoring → speed-to-lead', channel: 'sms' },

  // ── Internal Ops / Reliability ──
  'operations-guardian': { category: 'internal_ops', owns: 'Agent-level self-healing + escalation', triggers: 'Cron every 3h ET', reads: 'agent_jobs, ai_usage_events', writes: 'ops_incidents, attention_queue', handoffTo: null, channel: null },
  'system-monitor': { category: 'internal_ops', owns: 'External dependency health probes', triggers: 'Cron every 3h', reads: 'external APIs', writes: 'platform_health_checks', handoffTo: 'operations-guardian', channel: null },
};

/**
 * Overlap rules — where two agents legitimately touch the same record type or
 * channel. Each rule names the OWNER (authoritative) and the handoff so the
 * Agent Hub can render "this is intentional, here's the boundary" instead of a
 * scary duplicate warning. `severity` is 'info' for designed handoffs, 'warn'
 * for ones worth watching (could double-contact without the central gate).
 */
const OVERLAP_RULES = [
  { agents: ['outreach', 'drip-campaign'], channel: 'email', resource: 'cold prospect', owner: 'drip-campaign', rule: 'outreach DRAFTS the first cold touch (owner approves); drip-campaign owns the ongoing cadence after enrollment.', severity: 'info' },
  { agents: ['drip-campaign', 'follow-up'], channel: 'email/sms', resource: 'lead', owner: 'drip-campaign', rule: 'drip-campaign = cold prospects; follow-up = estimate/customer follow-up only. Different lead sets (cold vs contacted).', severity: 'info' },
  { agents: ['outreach-cadence', 'follow-up'], channel: 'email/sms', resource: 'customer', owner: 'outreach-cadence', rule: 'outreach-cadence owns review/quote/referral/commercial cadences; follow-up handles generic estimate follow-up. Tenant-scoped (AKA uses outreach-cadence).', severity: 'info' },
  { agents: ['facebook-prospecting', 'drip-campaign'], channel: 'sms/email', resource: 'prospect', owner: 'central gate', rule: 'fb_only leads go to facebook-prospecting (SMS+FB); email-found leads go to outreach→drip. lifecycle_stage routes them so they never overlap.', severity: 'info' },
  { agents: ['sales-nurture', 'drip-campaign'], channel: 'email', resource: 'prospect', owner: 'sales-nurture', rule: 'Once a lead reaches demo_booked/trial/nurture, drip stops (terminal status) and sales-nurture takes over. Central suppression enforces the handoff.', severity: 'warn' },
  { agents: ['scheduled-email-dispatch', 'drip-campaign'], channel: 'email', resource: 'email send', owner: 'separate', rule: 'scheduled-email-dispatch only sends rows other agents schedule (onboarding); it never picks prospects. No prospect overlap.', severity: 'info' },
  { agents: ['partner-outreach', 'outreach-cadence'], channel: 'email/sms', resource: 'referral partner', owner: 'partner-outreach', rule: 'partner-outreach = warm existing partners; outreach-cadence referral_partner type = cold partner discovery follow-up. Different partner states.', severity: 'warn' },
];

function categoryLabel(key) {
  const c = CATEGORIES.find((x) => x.key === key);
  return c ? c.label : key;
}

module.exports = { CATEGORIES, OWNERSHIP, OVERLAP_RULES, categoryLabel };
