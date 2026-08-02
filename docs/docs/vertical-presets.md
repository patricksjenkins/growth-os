> ⚠️ **ARCHIVED DESIGN DOC — DO NOT USE AS SOURCE OF TRUTH.**
> Written April 2026 under the retired working title "Growth OS", before the product shipped.
> The live system differs materially (15-module client catalog, Telnyx not Telnyx, in-house
> scheduler not n8n, web-form onboarding). For current facts use the code itself and
> `docs/business/` (see `docs/business/onboarding/onboarding-wizard-flow.md` v4).

# Growth OS — Vertical Presets

**Version:** 1.0 — Phase 2 Blueprint
**Date:** 2026-04-09
**Status:** DESIGN — No code changes

---

## Overview

A vertical preset is a complete configuration package that bootstraps a new tenant. When a tenant is created with `vertical: 'tree_service'`, the preset automatically:

1. Enables the right modules
2. Seeds default config values
3. Sets messaging tone and templates
4. Configures scheduling defaults
5. Lists required integrations

Presets are the starting point — every value is overridable per tenant.

---

## 1. Tree Service Preset

**Vertical key:** `tree_service`
**Source system:** A Kut Above Tree Services
**Target tenant:** A Kut Above (and future tree service companies)

### Default Modules Enabled

| Module | Enabled | Notes |
|--------|---------|-------|
| `lead_capture` | YES | Foundation |
| `speed_to_lead` | YES | Critical for residential service |
| `missed_call` | YES | High-value for field businesses |
| `follow_up` | YES | 3-step SMS sequence |
| `review_request` | YES | Google Reviews are #1 growth driver |
| `referral_request` | YES | Highest ROI lead source |
| `content_engine` | YES | Before/after content |
| `image_generation` | NO | Uses real job photos, not AI images |
| `approval_queue` | YES | Owner approves before posting |
| `mobile_approvals` | YES | Approve from the field |
| `publishing` | YES | Auto-post to social |
| `outreach_drip` | YES | Referral partner nurture |
| `prospecting` | YES | Find realtors, insurance agents |
| `lead_scoring` | NO | Not needed — all leads are worth pursuing |
| `digest` | YES | Daily summary |
| `finance` | YES | Income, expenses, crew pay |

### Default Config Values

```javascript
const TREE_SERVICE_CONFIG = {
  // Business identity
  business_name: '',              // Set during onboarding
  phone: '',                      // Set during onboarding
  email: '',                      // Set during onboarding
  timezone: 'America/Chicago',

  // Service configuration
  service_types: [
    'tree_removal',
    'tree_trimming',
    'stump_grinding',
    'storm_cleanup',
    'emergency_removal',
    'debris_haul_off',
    'lot_clearing',
    'pruning'
  ],

  lead_sources: [
    'google_search',
    'google_ads',
    'facebook',
    'instagram',
    'referral_realtor',
    'referral_insurance',
    'referral_landscaper',
    'referral_customer',
    'word_of_mouth',
    'yard_sign',
    'repeat_customer',
    'missed_call',
    'homeadvisor',
    'other'
  ],

  // Pipeline
  status_flow: [
    'new_lead',
    'contacted',
    'estimate_scheduled',
    'estimate_given',
    'won',
    'completed',
    'lost'
  ],

  loss_reasons: [
    'too_expensive',
    'chose_competitor',
    'no_response',
    'delayed_decision',
    'out_of_area',
    'bad_lead'
  ],

  // Service areas (customized per tenant)
  service_areas: [],              // Set during onboarding

  // Content
  content_pillars: [
    'Before/after transformations',
    'Storm damage expertise and emergency response',
    'Tree health tips and seasonal advice',
    'Community involvement and local pride',
    'Safety and professionalism',
    'Customer testimonials and reviews'
  ],

  brand_voice: 'Friendly, professional, and community-focused. Speak like a trusted neighbor who happens to be an expert arborist. Keep it down-to-earth but knowledgeable.',

  // Referral partner types for prospecting
  prospect_types: [
    { type: 'realtor', weight: 0.40 },
    { type: 'insurance_agent', weight: 0.30 },
    { type: 'landscaper', weight: 0.20 },
    { type: 'contractor', weight: 0.10 }
  ],

  // Prospecting
  daily_prospect_target: 10,

  // Referral
  referral_bonus: 100,            // $100 referral bonus
  referral_delay_days: 3,

  // Review
  review_url: '',                 // Set during onboarding
  review_delay_days: 1,

  // Finance
  finance_categories: [
    'Equipment',
    'Insurance',
    'Labor',
    'Operations',
    'Fuel',
    'Vehicle_Maintenance',
    'Advertising',
    'Utilities',
    'Credit_Cards',
    'Other'
  ],
};
```

### Messaging Tone

**SMS style:** Short, friendly, personal. No corporate language. Use first names.

```javascript
const TREE_SERVICE_SMS = {
  speed_to_lead: "Hey {name}! This is {owner} from {business}. Got your request about {service_type}. When's a good time to come take a look? We can usually get out there within a day or two.",

  follow_up_step_1: "Hi {name}, just following up on the estimate we gave you for {service_type}. Any questions I can answer? Happy to help.",

  follow_up_step_2: "Hey {name}, wanted to check in one more time about your {service_type} project. We've got some availability opening up this week if you'd like to get on the schedule.",

  follow_up_step_3: "Hi {name}, last check-in from {business}. If you're still thinking about the {service_type} work, we're here when you're ready. No pressure at all.",

  review_request: "Hi {name}! Thanks for choosing {business}! If you were happy with the work, a Google review would mean the world to us: {review_url}",

  referral_request: "Hey {name}! Hope you're enjoying the yard. If you know anyone who needs tree work, we offer a ${referral_bonus} referral bonus. Just have them mention your name!",

  missed_call: "Hi, this is {business}. Sorry we missed your call! How can we help? You can text us back here or call again anytime."
};
```

### Outreach Email Templates (7 Stages)

**Tone:** Professional but warm. Building a referral partnership, not selling.

```javascript
const TREE_SERVICE_OUTREACH = {
  stages: [
    { stage: 0, delay_days: 0, subject_prompt: 'Introduce yourself as a local tree service partner' },
    { stage: 1, delay_days: 14, subject_prompt: 'Share a helpful tree care tip relevant to their industry' },
    { stage: 2, delay_days: 30, subject_prompt: 'Offer a free property assessment for their clients' },
    { stage: 3, delay_days: 60, subject_prompt: 'Share a success story of a referral partnership' },
    { stage: 4, delay_days: 90, subject_prompt: 'Seasonal check-in with timely tree care advice' },
    { stage: 5, delay_days: 120, subject_prompt: 'Highlight your emergency response capabilities' },
    { stage: 6, delay_days: 180, subject_prompt: 'Recap value and make a clear referral partnership ask' },
  ],
  daily_send_limit: 20,
  from_name: '{owner_name} at {business_name}',
};
```

### Scheduling Defaults

| Agent | Schedule | Notes |
|-------|----------|-------|
| speed-to-lead | Every 2 min | Catch new leads fast |
| follow-up | Hourly 8am-6pm weekdays | Business hours only |
| prospecting | 6am weekdays | Before business opens |
| outreach-drip | Mon/Thu 9am | Twice weekly |
| review-request | 10am daily | After job completion |
| referral-request | 2pm daily | Afternoon send |
| content-generation | Mon 11am | Weekly content batch |
| publisher | 9am weekdays | Daily publish check |
| digest | 5pm weekdays | End of day summary |

### Required Integrations

| Service | Required? | Purpose |
|---------|-----------|---------|
| Telnyx | YES | SMS for speed-to-lead, follow-up, review, referral |
| Buffer | YES | Social media publishing |
| SMTP | YES | Outreach drip emails |
| Claude (platform) | YES | Content generation, outreach personalization |
| Google Review | YES | Review request link |
| Apollo | OPTIONAL | Prospect enrichment |

### Customizable per Tenant

| Setting | Customizable? | Notes |
|---------|:---:|-------|
| Service types | YES | Add/remove service categories |
| Service areas | YES | Geographic coverage |
| SMS templates | YES | Personalize voice |
| Outreach templates | YES | Industry-specific |
| Content pillars | YES | Brand focus areas |
| Brand colors | YES | For content/portal |
| Referral bonus | YES | Dollar amount |
| Review URL | YES | Google Business link |
| Crew roles/rates | YES | Team structure |
| Finance categories | YES | Expense types |

### Standardized (Same for All Tree Services)

| Setting | Value | Why |
|---------|-------|-----|
| Pipeline stages | new_lead → estimate_given → won → completed → lost | Industry standard flow |
| Follow-up cadence | 3 steps over 7 days | Proven optimal for residential service |
| Prospect types | Realtors, insurance, landscapers, contractors | Universal referral partners |
| Speed-to-lead timing | < 2 minutes | Industry best practice |
| Image generation | Disabled | Real photos beat AI for tree work |

---

## 2. Benefits Consulting Preset

**Vertical key:** `benefits_consulting`
**Source system:** WellMor Benefits Consulting
**Target tenant:** WellMor (and future benefits/insurance consultants)

### Default Modules Enabled

| Module | Enabled | Notes |
|--------|---------|-------|
| `lead_capture` | YES | Foundation |
| `speed_to_lead` | NO | B2B doesn't need instant SMS |
| `missed_call` | NO | Not a phone-first business |
| `follow_up` | NO | Email-based, not SMS |
| `review_request` | NO | Not applicable for B2B consulting |
| `referral_request` | NO | Referrals happen via relationships, not automation |
| `content_engine` | YES | LinkedIn thought leadership |
| `image_generation` | YES | AI-generated editorial visuals |
| `approval_queue` | YES | Morgan approves all content |
| `mobile_approvals` | YES | Morgan approves from phone |
| `publishing` | YES | Auto-post to LinkedIn, Instagram |
| `outreach_drip` | YES | Email nurture for HR directors |
| `prospecting` | YES | Find HR directors, CFOs |
| `lead_scoring` | YES | Score by company size, industry fit |
| `digest` | YES | Daily executive briefing |
| `finance` | NO | Not needed for consulting |

### Default Config Values

```javascript
const BENEFITS_CONSULTING_CONFIG = {
  // Business identity
  business_name: '',              // Set during onboarding
  phone: '',
  email: '',
  timezone: 'America/Chicago',

  // Service configuration
  service_types: [
    'benefits_audit',
    'plan_design',
    'compliance_review',
    'enrollment_support',
    'benefits_strategy',
    'vendor_negotiation',
    'employee_education',
    'open_enrollment'
  ],

  lead_sources: [
    'linkedin',
    'referral',
    'website',
    'cold_outreach',
    'event',
    'webinar',
    'content_download',
    'partner_referral',
    'other'
  ],

  // Pipeline
  status_flow: [
    'new_lead',
    'researching',
    'qualified',
    'meeting_scheduled',
    'proposal_sent',
    'negotiating',
    'won',
    'lost'
  ],

  loss_reasons: [
    'no_budget',
    'chose_competitor',
    'no_response',
    'not_decision_maker',
    'timing_not_right',
    'current_broker_retained',
    'company_too_small'
  ],

  // Target market
  target_company_size: { min: 50, max: 5000 },
  target_industries: [
    'manufacturing',
    'technology',
    'healthcare',
    'professional_services',
    'financial_services',
    'construction',
    'education',
    'nonprofit'
  ],

  // Content
  content_pillars: [
    'Benefits as a retention and recruitment tool',
    'Common employer mistakes with benefits',
    'Modernizing and optimizing benefits packages',
    'Compliance and regulatory updates',
    'Cost containment strategies',
    'Employee wellness and engagement'
  ],

  brand_voice: 'Authoritative but approachable. Position as a trusted advisor who simplifies complexity. Use data and examples. Avoid jargon. Speak to HR directors and CFOs who are frustrated with their current benefits situation.',

  brand_colors: {
    primary: '#1B3A4B',           // Deep navy
    secondary: '#4A90A4',         // Teal
    accent: '#C4A35A',            // Gold
    background: '#F5F0EB',        // Warm cream
    text_dark: '#2C2C2C',
    text_light: '#FFFFFF'
  },

  // Content formats (the 8 carousel templates from format-templates.js)
  content_formats: [
    // Format 1: Warm Earth Editorial
    // Format 2: Bold Statement
    // Format 3: Data-Driven Insight
    // ... (migrated from format-templates.js)
  ],

  // Prospecting
  prospect_types: [
    { type: 'hr_director', weight: 0.40 },
    { type: 'cfo', weight: 0.25 },
    { type: 'ceo', weight: 0.15 },
    { type: 'benefits_broker', weight: 0.10 },
    { type: 'operations_director', weight: 0.10 }
  ],
  daily_prospect_target: 30,

  // Scoring
  scoring_rules: {
    tier_a: 75,                   // Score >= 75 = Tier A
    tier_b: 50,                   // Score >= 50 = Tier B
    // Below 50 = Tier C
  },
  scoring_dimensions: [
    'company_size_fit',
    'industry_relevance',
    'benefits_complexity',
    'growth_signals',
    'decision_maker_access',
    'timing_indicators'
  ],
};
```

### Messaging Tone

**Email style:** Professional, consultative, data-informed. Position as a strategic partner, not a vendor.

```javascript
const BENEFITS_CONSULTING_EMAIL = {
  outreach_stages: [
    {
      stage: 0,
      delay_days: 0,
      prompt: 'Write a brief, personalized introduction email from a benefits consultant to {contact_title} at {company}. Reference something specific about their company ({industry}, {employee_count} employees). Keep it to 3 sentences max. No hard sell — just introduce yourself as someone who helps companies like theirs optimize their benefits strategy.'
    },
    {
      stage: 1,
      delay_days: 7,
      prompt: 'Write a follow-up email sharing a specific insight about benefits trends in the {industry} industry. Include one data point. End with a soft question, not a meeting request.'
    },
    {
      stage: 2,
      delay_days: 14,
      prompt: 'Write an email sharing a brief case study of helping a similar-sized company save on benefits costs while improving employee satisfaction. Keep it concise — 4 sentences max.'
    },
    {
      stage: 3,
      delay_days: 30,
      prompt: 'Write a timely email about an upcoming benefits deadline or regulatory change that affects companies with {employee_count} employees. Offer a free 15-minute review.'
    },
    {
      stage: 4,
      delay_days: 60,
      prompt: 'Write a brief check-in email referencing open enrollment season. Ask if they would find value in a benchmarking comparison against similar companies.'
    },
  ],
  daily_send_limit: 50,
  from_name: '{owner_name}, {business_name}',
};
```

### Scheduling Defaults

| Agent | Schedule | Notes |
|-------|----------|-------|
| prospecting | 6am weekdays | Daily prospect discovery |
| enrichment | 7am weekdays | Enrich new prospects |
| scoring | 7:30am weekdays | Score new leads |
| outreach-drip | Mon/Wed/Fri 9am | Three times weekly |
| content-generation | Mon 11am | Weekly content batch |
| image-generation | (triggered by content) | Per-slide generation |
| publisher | 9am weekdays | Daily publish check |
| digest | 5pm weekdays | End of day summary |
| reply-classification | Every 30 min | Check for replies |
| meeting-prep | (triggered by webhook) | On Calendly booking |

### Required Integrations

| Service | Required? | Purpose |
|---------|-----------|---------|
| Buffer | YES | LinkedIn, Instagram publishing |
| SMTP | YES | Outreach emails |
| Claude (platform) | YES | Content, scoring, outreach |
| Gemini (platform) | YES | Image generation |
| Calendly | OPTIONAL | Meeting booking |
| Apollo | OPTIONAL | Contact enrichment |
| Serper (platform) | YES | Web research for prospecting |

### Customizable per Tenant

| Setting | Customizable? | Notes |
|---------|:---:|-------|
| Target industries | YES | Industry focus |
| Target company size | YES | Min/max employees |
| Content pillars | YES | Thought leadership focus |
| Brand colors | YES | Visual identity |
| Outreach templates | YES | Email voice |
| Scoring dimensions | YES | What matters for qualification |
| Prospect types | YES | Who to target |
| Content formats | YES | Carousel templates |

### Standardized (Same for All Benefits Consultants)

| Setting | Value | Why |
|---------|-------|-----|
| Pipeline stages | new_lead → qualified → meeting → proposal → won/lost | Standard B2B sales process |
| Scoring model | 6-dimension Claude analysis | Proven ICP scoring pattern |
| Content approach | LinkedIn carousels + editorial imagery | B2B thought leadership standard |
| Outreach cadence | 5 stages over 60 days | Professional B2B nurture pace |
| Image generation | Enabled (AI editorial style) | No physical work to photograph |
| SMS modules | All disabled | B2B = email, not text |

---

## 3. Creating a New Vertical Preset

### Template

When adding a new vertical (e.g., `plumbing`, `hvac`, `insurance_agency`), create a file:

```
config/presets/{vertical-name}.js
```

Must export:

```javascript
module.exports = {
  vertical: 'vertical_key',

  modules: {
    // Which modules to enable by default
    lead_capture: true,
    speed_to_lead: true,
    // ...
  },

  config: {
    // All tenant_config key-value pairs
    service_types: [...],
    lead_sources: [...],
    status_flow: [...],
    content_pillars: [...],
    brand_voice: '...',
    // ...
  },

  sms_templates: {
    // SMS message templates with {variables}
  },

  outreach_templates: {
    // Email outreach stage definitions
  },

  integrations_required: [
    // List of services the tenant must connect
  ],
};
```

### Seed Script

```javascript
// scripts/seed-tenant.js
const preset = require(`../config/presets/${vertical}`);

// 1. Create tenant
const tenant = await db.from('tenants').insert({ name, slug, vertical });

// 2. Seed modules
for (const [module, enabled] of Object.entries(preset.modules)) {
  await db.from('tenant_modules').insert({ tenant_id: tenant.id, module, enabled });
}

// 3. Seed config
for (const [key, value] of Object.entries(preset.config)) {
  await db.from('tenant_config').insert({ tenant_id: tenant.id, key, value });
}

// 4. Create owner user
// ...
```

---

## 4. Open Questions

| # | Question | Impact | Default |
|---|----------|--------|---------|
| 1 | Should presets be in code files or in the database? | Maintenance, versioning | Code files (version controlled, easy to diff) |
| 2 | Can a tenant switch verticals after creation? | Edge case | No — create a new tenant if needed |
| 3 | Should SMS templates use simple `{variable}` or a templating engine? | Complexity | Simple `{variable}` replacement — no need for Handlebars/Mustache |
| 4 | How to handle vertical-specific UI components? | Portal/mobile complexity | Module-gated sections. Hide UI for disabled modules. |
| 5 | Should outreach email prompts be exact templates or AI generation prompts? | Quality control | AI generation prompts (from AKA pattern). More natural, personalized. |
