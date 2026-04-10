/**
 * Tree Service Vertical Preset
 * Source: A Kut Above Tree Services
 */

module.exports = {
  vertical: 'tree_service',

  modules: {
    lead_capture: true,
    speed_to_lead: true,
    missed_call: true,
    follow_up: true,
    review_request: true,
    referral_request: true,
    content_engine: true,
    image_generation: false,  // Uses real photos, not AI images
    approval_queue: true,
    mobile_approvals: true,
    publishing: true,
    outreach_drip: true,
    prospecting: true,
    lead_scoring: false,
    digest: true,
    finance: true,
  },

  config: {
    timezone: 'America/Chicago',

    service_types: [
      'tree_removal', 'tree_trimming', 'stump_grinding',
      'storm_cleanup', 'emergency_removal', 'debris_haul_off',
      'lot_clearing', 'pruning'
    ],

    lead_sources: [
      'google_search', 'google_ads', 'facebook', 'instagram',
      'referral_realtor', 'referral_insurance', 'referral_landscaper',
      'referral_customer', 'word_of_mouth', 'yard_sign',
      'repeat_customer', 'missed_call', 'homeadvisor', 'other'
    ],

    status_flow: [
      'new_lead', 'contacted', 'estimate_scheduled',
      'estimate_given', 'won', 'completed', 'lost'
    ],

    loss_reasons: [
      'too_expensive', 'chose_competitor', 'no_response',
      'delayed_decision', 'out_of_area', 'bad_lead'
    ],

    content_pillars: [
      'Before/after transformations',
      'Storm damage expertise and emergency response',
      'Tree health tips and seasonal advice',
      'Community involvement and local pride',
      'Safety and professionalism',
      'Customer testimonials and reviews'
    ],

    brand_voice: 'Friendly, professional, and community-focused. Speak like a trusted neighbor who happens to be an expert arborist. Keep it down-to-earth but knowledgeable.',

    prospect_types: [
      { type: 'realtor', weight: 0.40 },
      { type: 'insurance_agent', weight: 0.30 },
      { type: 'landscaper', weight: 0.20 },
      { type: 'contractor', weight: 0.10 }
    ],

    daily_prospect_target: 10,
    referral_bonus: 100,
    referral_delay_days: 3,
    review_delay_days: 1,
    outreach_daily_limit: 20,
    follow_up_steps: 3,
    follow_up_trigger_status: 'estimate_given',

    sms_templates: {
      speed_to_lead: "Hey {name}! This is {owner} from {business_name}. Got your request about {service_type}. When's a good time to come take a look?",
      follow_up_1: "Hi {name}, just following up on the estimate we gave you for {service_type}. Any questions I can answer?",
      follow_up_2: "Hey {name}, checking in about your {service_type} project. We've got availability this week if you'd like to get on the schedule.",
      follow_up_3: "Hi {name}, last check-in from {business_name}. We're here when you're ready. No pressure at all.",
      review_request: "Hi {name}! Thanks for choosing {business_name}! If you were happy with the work, a Google review would mean the world: {review_url}",
      referral_request: "Hey {name}! If you know anyone who needs tree work, we offer a ${referral_bonus} referral bonus. Just have them mention your name!",
      missed_call: "Hi, this is {business_name}. Sorry we missed your call! How can we help? You can text us back here or call again anytime."
    },

    finance_categories: [
      'Equipment', 'Insurance', 'Labor', 'Operations',
      'Fuel', 'Vehicle_Maintenance', 'Advertising',
      'Utilities', 'Credit_Cards', 'Other'
    ],

    brand_colors: {
      primary: '#2E7D32',
      secondary: '#FFA726'
    }
  },

  integrations_required: ['twilio', 'buffer', 'smtp']
};
