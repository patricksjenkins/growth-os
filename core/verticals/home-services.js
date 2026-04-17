/**
 * Home Services vertical config.
 * Covers plumbing, electrical, HVAC, tree service, landscaping, painting,
 * roofing, pressure washing, pest control, pool service, cleaning, general
 * contractors. All job-based (one-time revenue per visit).
 */

module.exports = {
  slug: 'home_services',
  name: 'Service Pro',

  labels: {
    customer: 'Customer',
    customers: 'Customers',
    lead: 'Lead',
    leads: 'Leads',
    job: 'Job',
    jobs: 'Jobs',
    revenue: 'Revenue',
    pipeline: 'Jobs Pipeline',
    // Finance
    income_label: 'Job Revenue',
    mrr_label: 'This Month Revenue',
    recurring_revenue_hidden: true,   // service pros don't have MRR; hide the card
  },

  palette: {
    primary: '#0B1120',    // deep navy (same as FGA base)
    secondary: '#22C55E',  // signal green
    accent: '#F59E0B',     // warm amber for job highlights
  },

  pipeline_stages: [
    'new_lead',
    'contacted',
    'estimate_scheduled',
    'estimate_given',
    'won',
    'completed',
    'lost',
  ],

  revenue_model: 'one_time', // per-job, not recurring subscription

  // Seed vocabulary for content/SMS templates
  content_voice: 'practical, direct, proud-of-the-work',
  review_ask_timing_hours: 24,
};
