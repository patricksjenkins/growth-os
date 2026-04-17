/**
 * Retail / Single-Person Seller vertical config.
 * Covers Etsy sellers, specialty food brands, boutique retail, farmers market
 * vendors, subscription boxes, e-commerce. Per-sale revenue + optional
 * recurring (subscription box).
 */

module.exports = {
  slug: 'retail',
  name: 'Small Retailer',

  labels: {
    customer: 'Customer',
    customers: 'Customers',
    lead: 'Shopper',
    leads: 'Shoppers',
    job: 'Order',
    jobs: 'Orders',
    revenue: 'Revenue',
    pipeline: 'Orders',
    income_label: 'Sales',
    mrr_label: 'This Month Sales',
    recurring_revenue_hidden: false, // subscription boxes may have MRR
  },

  palette: {
    primary: '#7C2D12',    // warm brick — boutique feel
    secondary: '#F97316',  // orange accent
    accent: '#FBBF24',     // soft amber for highlights
  },

  pipeline_stages: [
    'new_lead',
    'contacted',
    'quote_given',
    'won',
    'fulfilled',
    'lost',
  ],

  revenue_model: 'per_sale',

  content_voice: 'warm, story-driven, behind-the-scenes',
  review_ask_timing_hours: 240, // 10 days — give time for shipping + use
};
