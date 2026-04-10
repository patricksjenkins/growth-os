/**
 * Benefits Consulting Vertical Preset
 * Source: WellMor Benefits Consulting
 *
 * Includes format templates ported from agents/format-templates.js
 */

module.exports = {
  vertical: 'benefits_consulting',

  modules: {
    lead_capture: true,
    speed_to_lead: false,
    missed_call: false,
    follow_up: false,
    review_request: false,
    referral_request: false,
    content_engine: true,
    image_generation: true,
    approval_queue: true,
    mobile_approvals: true,
    publishing: true,
    outreach_drip: true,
    prospecting: true,
    lead_scoring: true,
    digest: true,
    finance: false,
  },

  config: {
    timezone: 'America/Chicago',

    service_types: [
      'benefits_audit', 'plan_design', 'compliance_review',
      'enrollment_support', 'benefits_strategy', 'vendor_negotiation',
      'employee_education', 'open_enrollment'
    ],

    lead_sources: [
      'linkedin', 'referral', 'website', 'cold_outreach',
      'event', 'webinar', 'content_download', 'partner_referral', 'other'
    ],

    status_flow: [
      'new_lead', 'researching', 'qualified', 'meeting_scheduled',
      'proposal_sent', 'negotiating', 'won', 'lost'
    ],

    loss_reasons: [
      'no_budget', 'chose_competitor', 'no_response',
      'not_decision_maker', 'timing_not_right',
      'current_broker_retained', 'company_too_small'
    ],

    content_pillars: [
      'Benefits as a retention and recruitment tool',
      'Common employer mistakes with benefits',
      'Modernizing and optimizing benefits packages',
      'Compliance and regulatory updates',
      'Cost containment strategies',
      'Employee wellness and engagement'
    ],

    brand_voice: 'Bold, modern, emotionally intelligent, warm yet authoritative. Write like a premium wellness-meets-business brand strategist. Favor clarity and insight over buzzwords. Each piece should feel like a premium editorial wellness brand.',

    brand_colors: {
      primary: '#1B3A4B',
      secondary: '#4A90A4',
      accent: '#C4A35A',
      background: '#F5F0EB',
      text_dark: '#2C2C2C',
      text_light: '#FFFFFF'
    },

    prospect_types: [
      { type: 'hr_director', weight: 0.40 },
      { type: 'cfo', weight: 0.25 },
      { type: 'ceo', weight: 0.15 },
      { type: 'benefits_broker', weight: 0.10 },
      { type: 'operations_director', weight: 0.10 }
    ],

    daily_prospect_target: 30,
    outreach_daily_limit: 50,

    // === ICP Parameters (used by scoring + prospecting agents) ===
    target_states: ['GA', 'FL', 'NC', 'SC', 'TN', 'AL', 'TX', 'VA', 'CO', 'IL'],
    target_industries: [
      'Manufacturing', 'Construction', 'Architecture/Engineering',
      'Legal Services', 'Law Firm', 'Technology', 'SaaS',
      'Healthcare', 'Financial Services', 'Real Estate',
      'Logistics', 'Accounting', 'Professional Services',
      'Marketing Agency', 'Marketing', 'Advertising', 'Creative'
    ],
    excluded_industries: [
      'HR Consulting', 'Benefits Consulting', 'Insurance Brokerage',
      'PEO', 'Staffing', 'Recruiting', 'Payroll Services'
    ],
    excluded_keywords: [
      'benefits broker', 'benefits consulting', 'hr consulting',
      'peo', 'staffing agency', 'recruiting firm', 'payroll provider',
      'insurance broker', 'human resources consulting'
    ],
    min_employees: 20,
    max_employees: 150,

    scoring_rules: {
      tier_a: 70,
      tier_b: 50,
    },

    // === FORMAT TEMPLATES (ported from format-templates.js) ===
    // Only Format 1 shown here — the full 8 formats from the legacy system
    // will be added as they're tested
    content_formats: [
      {
        id: 1,
        name: 'Warm Earth Editorial',
        slideCount: 5,
        slides: [
          {
            slideNumber: 1, role: 'hook', backgroundType: 'image',
            imagePrompt: 'Dark, moody architectural interior scene with premium natural materials. Materials: dark marble, green stone, warm wood, linen curtain, concrete floor. Architectural elements: arched wall or doorway, clean surfaces. Include a tree or plant. Colors: deep browns, dark greens, charcoal, warm amber accents. Overall DARK tone — this image needs to support white text overlay. CRITICAL: Leave BIG open space in the CENTER of the image for headline text. Style: luxury boutique hotel lobby, art gallery, premium wellness space. Moody editorial lighting with warm highlights. No text, no people.',
            textLayout: { headline: { position: 'center', color: 'white', font: 'bold serif', shadow: 'strong-black' }, body: null },
            branding: { wellmorBenefits: null, logo: { position: 'top-center', size: 'large' } }
          },
          {
            slideNumber: 2, role: 'problem', backgroundType: 'solid',
            bgPalette: { base: '#F5F0EB', gradient: '#FAF7F4' },
            textLayout: { headline: { position: 'center', color: '#2C1810', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#5A4A3F', font: 'regular sans', shadow: 'none' } },
            branding: { wellmorBenefits: { position: 'top-center', color: '#8B7D6B' }, logo: { position: 'bottom-right' } }
          },
          {
            slideNumber: 3, role: 'insight', backgroundType: 'solid',
            bgPalette: { base: '#E8E2D9', gradient: '#F0EBE4' },
            textLayout: { headline: { position: 'center', color: '#2C1810', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#5A4A3F', font: 'regular sans', shadow: 'none' } },
            branding: { wellmorBenefits: { position: 'top-center', color: '#8B7D6B' }, logo: { position: 'bottom-right' } }
          },
          {
            slideNumber: 4, role: 'value', backgroundType: 'solid',
            bgPalette: { base: '#2E3B2F', gradient: '#3A4A3B' },
            textLayout: { headline: { position: 'center', color: '#F5F0EB', font: 'bold serif', shadow: 'none' }, body: { position: 'center', color: '#D4CCC2', font: 'regular sans', shadow: 'none' } },
            branding: { wellmorBenefits: { position: 'top-center', color: '#8B9A7B' }, logo: { position: 'bottom-right' } }
          },
          {
            slideNumber: 5, role: 'cta', backgroundType: 'image',
            imagePrompt: 'Warm, moody, object-focused scene. Dark overall tone. Single calming object: lit candle in clay holder, warm tea in ceramic cup, smooth stones, or soft fabric draped on a natural surface. Warm golden/amber lighting. Dark but warm background. MUST be darker overall to support white text. Generous negative space in the center/upper area for text. No people, no text.',
            textLayout: { headline: { position: 'center', color: 'white', font: 'bold serif', shadow: 'strong-black' }, body: { position: 'center', color: 'white', font: 'regular sans', shadow: 'black' }, website: { position: 'bottom-center', color: 'white', shadow: 'black' } },
            branding: { wellmorBenefits: null, logo: { position: 'bottom-right' } }
          }
        ],
        contentStructure: {
          type: 'narrative',
          slideInstructions: {
            hook: 'Bold, scroll-stopping headline ONLY (5-10 words). No body text.',
            problem: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
            insight: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
            value: 'Headline (6-10 words) + body paragraph (20-35 words MAX).',
            cta: 'Call to action headline + short body with website URL.',
          }
        }
      }
      // Formats 2-8 will be ported from the legacy format-templates.js as needed
    ]
  },

  integrations_required: ['buffer', 'smtp']
};
