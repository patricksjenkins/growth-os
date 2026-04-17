/**
 * Real Estate vertical config.
 * Covers residential agents, brokers. Commission-based revenue.
 * "Leads" become "buyers/sellers", "jobs" become "listings" / "closings".
 */

module.exports = {
  slug: 'real_estate',
  name: 'Real Estate Agent',

  labels: {
    customer: 'Client',
    customers: 'Clients',
    lead: 'Prospect',
    leads: 'Prospects',
    job: 'Listing',
    jobs: 'Listings',
    revenue: 'Commission',
    pipeline: 'Deals Pipeline',
    income_label: 'Commission',
    mrr_label: 'Closings This Month',
    recurring_revenue_hidden: true,
  },

  palette: {
    primary: '#1E3A8A',    // deep blue, real-estate formal
    secondary: '#CA8A04',  // muted gold accent
    accent: '#64748B',     // slate for secondary UI
  },

  pipeline_stages: [
    'new_lead',
    'contacted',
    'showing_scheduled',
    'offer_submitted',
    'under_contract',
    'closed',
    'lost',
  ],

  revenue_model: 'commission',

  content_voice: 'polished, knowledgeable, community-focused',
  review_ask_timing_hours: 72, // wait a few days after closing
};
