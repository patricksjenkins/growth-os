/**
 * Growth OS Platform Defaults
 * Every tenant inherits these unless overridden by preset or tenant_config
 */

module.exports = {
  timezone: 'America/Chicago',

  // Pipeline
  status_flow: ['new_lead', 'contacted', 'qualified', 'won', 'lost'],

  // Follow-up
  follow_up_steps: 3,
  follow_up_trigger_status: 'estimate_given',

  // Prospecting
  daily_prospect_target: 10,

  // Review/Referral
  review_delay_days: 1,
  referral_delay_days: 3,
  referral_bonus: 100,

  // Outreach
  outreach_daily_limit: 20,

  // Content
  content_pillars: [],
  brand_voice: 'Professional and helpful.',

  // SMS Templates
  sms_templates: {
    speed_to_lead: 'Hi {name}, thanks for reaching out to {business_name}! How can we help you?',
    missed_call: 'Hi, this is {business_name}. Sorry we missed your call! How can we help? You can text us back here.',
    follow_up_1: 'Hi {name}, just following up on your inquiry. Any questions we can answer?',
    follow_up_2: 'Hey {name}, checking in one more time. We have availability this week if you\'d like to move forward.',
    follow_up_3: 'Hi {name}, last check-in from {business_name}. We\'re here when you\'re ready.',
    review_request: 'Hi {name}! Thanks for choosing {business_name}! If you were happy with the work, a review would mean a lot: {review_url}',
    referral_request: 'Hey {name}! If you know anyone who needs our services, we offer a ${referral_bonus} referral bonus. Just have them mention your name!'
  },

  // Brand
  brand_colors: {
    primary: '#333333',
    secondary: '#666666'
  }
};
