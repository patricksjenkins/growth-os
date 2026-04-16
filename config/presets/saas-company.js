/**
 * First Gen Automate Vertical Preset — SaaS / Tech Company
 * Used for First Gen Automate itself (eating your own cooking).
 *
 * All 14 modules enabled. This is the Scale tier at maximum.
 * The system markets First Gen Automate, captures leads, follows up,
 * manages social, monitors inbox, and sends the founder a daily digest.
 */

module.exports = {
  vertical: 'saas_company',
  label: 'SaaS / Tech Company',

  // All 14 modules enabled — FGA gets everything
  modules: {
    lead_capture:       true,
    speed_to_lead:      true,
    missed_call:        true,
    follow_up:          true,
    content_engine:     true,
    publishing:         true,
    review_request:     true,
    branded_app:        true,
    social_engagement:  true,
    email_chief:        true,
    referral_engine:    true,
    referral_outreach:  true,
    prospecting:        true,
    lead_scoring:       true,
    finance:            true,
    digest:             true,
  },

  config: {
    // Business info
    business_name: 'First Gen Automate',
    business_type: 'saas_company',
    tagline: 'We install the system that runs your business.',
    website: 'www.firstgenautomate.com',
    phone: '(678) 777-8922',
    email: 'patrick@firstgenautomate.com',
    timezone: 'America/New_York',
    business_hours: { start: '9:00', end: '18:00', days: [1, 2, 3, 4, 5] },

    // Service types (what FGA sells)
    service_types: [
      'First Gen Automate Setup',
      'First Gen Automate Growth Tier',
      'First Gen Automate Scale Tier',
      'Demo Request',
      'Consultation',
    ],

    // Lead sources
    lead_sources: [
      'Website Form',
      'Facebook Ad',
      'Instagram Ad',
      'LinkedIn',
      'Referral',
      'Google Search',
      'Personal Network',
      'Trade Show',
      'Cold Outreach',
    ],

    // Lead status flow
    status_flow: ['new_lead', 'contacted', 'demo_booked', 'demo_done', 'proposal_sent', 'won', 'lost'],

    // Loss reasons
    loss_reasons: [
      'Too expensive',
      'Went with competitor',
      'Not ready yet',
      'No budget',
      'No response',
      'Bad fit',
    ],

    // Content pillars (what FGA posts about)
    content_pillars: [
      'The Missed Opportunity — make business owners feel the cost of what they are NOT doing: missed calls, no follow-ups, no reviews, no social presence. Not guilt, just reality. Examples: "You finished 4 jobs today. How many got a follow-up?" / "That missed call at 2pm? That was a $3,000 job."',
      'The System in Action — show Growth OS working with real flows and outcomes, not features. A lead comes in, instant text goes out, customer replies, booked. Photos uploaded, post created, approved with one tap, posted. Job done, review request sent, 5-star review appears.',
      'Behind the Build — show what the system does and how it works. Real updates, real results, real progress. Focus on the agents, the automation, and the outcomes — not the founder\'s personal schedule. Examples: "We deploy agents that do the jobs you would have to do yourself — or hire someone for." / "Two clients live. Zero missed leads. The system runs while they work." / "32 agents. Each one handles a task you would need to hire for."',
      'The Cost of Doing Nothing — hard numbers that make the math obvious. "78% of customers hire the first business that responds." / "A 1-star increase on Google = 9% more revenue." Educational but with an edge.',
      'Not Software, Not an Agency — differentiation against what they have tried before. "Agencies send you reports. We install a system that does the work." / "You don\'t need another dashboard. You need a system that runs." / "We\'re not asking you to learn software. We\'re asking you to upload photos."',
      'Your Business Deserves This — the aspirational angle. Show them what their business looks like with Growth OS. "Your business gets its own app. Your competitors don\'t have that." / "What if every customer got a thank-you text, a review request, and a referral ask — automatically?"',
    ],

    // Brand voice for AI content generation
    brand_voice: 'Confident, direct, plain-spoken. Like a trusted business advisor who respects the owner\'s time. Not salesy. Not corporate. Not techy. Short sentences. Concrete outcomes. Real numbers when possible. Speak to small business owners who are too busy doing the work to market their business. No jargon, no buzzwords, no "AI-powered" language.',

    // SMS templates
    sms_templates: {
      speed_to_lead: 'Hi {{lead_name}}, thanks for checking out First Gen Automate. I\'m Patrick — I\'d love to show you how First Gen Automate can run your business growth on autopilot. When works for a quick call?',
      missed_call: 'Hey, sorry I missed your call. This is Patrick from First Gen Automate. What can I help you with?',
      follow_up_1: 'Hi {{lead_name}}, just following up on First Gen Automate. Happy to answer any questions or schedule a quick demo. No pressure.',
      follow_up_2: 'Hi {{lead_name}}, wanted to circle back one more time. If you\'re still thinking about automating your business growth, I\'m here when you\'re ready.',
      review_request: 'Hi {{customer_name}}, thanks for choosing First Gen Automate! If you\'re seeing results, would you mind leaving a quick Google review? It really helps. {{review_link}}',
      referral_request: 'Hi {{customer_name}}, glad First Gen Automate is working for you! Know any other business owners who could use a system like this? I\'d love to help them too.',
    },

    // Prospecting config
    prospect_types: ['small_business_owner', 'service_company', 'trades_business', 'professional_services'],
    prospect_industries: ['tree_service', 'landscaping', 'plumbing', 'hvac', 'cleaning', 'consulting', 'fitness', 'auto_detailing'],
    outreach_daily_limit: 40,

    // Volume limits (Scale tier — max everything)
    volume_limits: {
      sms_per_month: 1000,
      posts_per_month: 30,
      post_max_words: 75,
      sms_max_words: 25,
      comment_responses_per_month: 300,
      email_responses_per_month: 500,
      outreach_per_day: 40,
    },

    // Social accounts
    social_platforms: ['facebook', 'instagram', 'linkedin'],

    // Digest config
    digest_email: 'patrick@firstgenautomate.com',
    digest_daily: true,
    digest_weekly: true,
    digest_time: '17:00',
  },
};
