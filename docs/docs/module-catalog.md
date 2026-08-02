> ⚠️ **ARCHIVED DESIGN DOC — DO NOT USE AS SOURCE OF TRUTH.**
> Written April 2026 under the retired working title "Growth OS", before the product shipped.
> The live system differs materially (15-module client catalog, Telnyx not Telnyx, in-house
> scheduler not n8n, web-form onboarding). For current facts use the code itself and
> `docs/business/` (see `docs/business/onboarding/onboarding-wizard-flow.md` v4).

# Growth OS — Module Catalog

**Version:** 1.0 — Phase 2 Blueprint
**Date:** 2026-04-09
**Status:** DESIGN — No code changes

---

## Overview

Modules are the feature units of Growth OS. Each module can be enabled or disabled per tenant. Modules map to agents, API routes, and UI sections.

**Module tiers:**
- **Core** — Included for all tenants. Foundation features.
- **Pro** — Available for tenants who need them. Vertical-specific or advanced.
- **Future** — Planned but not built in Phase 3.

---

## 1. Lead Capture & CRM Core

| Field | Value |
|-------|-------|
| **Module key** | `lead_capture` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** Centralized lead intake, status tracking, and pipeline management. Every tenant needs this.

**Business outcome:** Single source of truth for all prospects and customers. No leads slip through cracks.

**Required tables:** `leads`, `contacts`

**Required integrations:** None (core module)

**Required config:**
- `service_types` — array of services offered
- `lead_sources` — array of intake channels
- `status_flow` — ordered array of pipeline stages

**Dependencies:** None (foundation module)

**What it includes:**
- Lead CRUD API endpoints
- Status pipeline with configurable stages
- Lead source tracking
- Notes and activity timeline
- Assignment to team members
- Portal lead management page
- Mobile lead list and detail screens

**Source code references:**
- AKA: `a-kut-above-api/src/routes/leads.ts`, `leadService.ts`
- WellMor: `agents/server.js` (lead-related endpoints), `agents/clients-agent.js`

---

## 2. Speed-to-Lead

| Field | Value |
|-------|-------|
| **Module key** | `speed_to_lead` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** Send an SMS within seconds of a new lead arriving. First response wins the job.

**Business outcome:** 5x higher conversion rate vs responding in 30+ minutes.

**Required tables:** `leads`, `messages`, `idempotency_keys`

**Required integrations:** Telnyx

**Required config:**
- `sms_templates.speed_to_lead` — message template with `{name}` variable
- `response_delay_seconds` — how long to wait (default: 0)

**Dependencies:** `lead_capture`

**What it includes:**
- Agent that triggers on new lead creation
- SMS sent via Telnyx with tenant's phone number
- Idempotency check prevents duplicate sends
- Message logged to `messages` table
- Activity logged to `agent_activity_log`

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/SpeedToLeadAgent.ts` — runs every 2 min, catches any new leads without SMS
- WellMor: No equivalent (WellMor handles B2B, not instant response)

---

## 3. Missed Call Text Back

| Field | Value |
|-------|-------|
| **Module key** | `missed_call` |
| **Tier** | Pro |
| **Implement** | Phase 3 (now) |

**Purpose:** Auto-text someone who called but wasn't answered. Captures leads that would otherwise be lost.

**Business outcome:** Recovers 15-30% of missed call leads.

**Required tables:** `leads`, `messages`, `idempotency_keys`

**Required integrations:** Telnyx (webhook)

**Required config:**
- `sms_templates.missed_call` — message template
- `auto_create_lead` — boolean, whether to auto-create a lead record

**Dependencies:** `lead_capture`, `speed_to_lead`

**What it includes:**
- Telnyx webhook handler for missed calls
- Auto-creates lead with source='missed_call'
- Sends immediate text-back
- Prevents duplicate texts via idempotency

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/MissedCallAgent.ts`
- WellMor: No equivalent

---

## 4. Follow-Up Engine

| Field | Value |
|-------|-------|
| **Module key** | `follow_up` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** Multi-step SMS follow-up sequence for leads that haven't converted.

**Business outcome:** Systematic follow-up closes 20-30% more estimates.

**Required tables:** `leads`, `messages`, `outreach_campaigns`, `idempotency_keys`

**Required integrations:** Telnyx

**Required config:**
- `follow_up_steps` — array of `{ delay_days, template }` objects
- `follow_up_trigger_status` — which lead status triggers follow-up (e.g., "estimate_given")

**Dependencies:** `lead_capture`

**What it includes:**
- Agent runs hourly during business hours
- Checks for leads with pending follow-up steps
- Sends next step based on days elapsed
- Tracks progress in outreach_campaigns
- Skips if lead already responded or converted

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/FollowUpAgent.ts` — 3-step sequence, hourly 8am-6pm weekdays

---

## 5. Review Request Engine

| Field | Value |
|-------|-------|
| **Module key** | `review_request` |
| **Tier** | Pro |
| **Implement** | Phase 3 (now) |

**Purpose:** Auto-send Google Review request after job completion.

**Business outcome:** Consistent 5-star review flow. Social proof drives new leads.

**Required tables:** `leads`, `jobs`, `messages`, `idempotency_keys`

**Required integrations:** Telnyx

**Required config:**
- `sms_templates.review_request` — message with `{review_url}` variable
- `review_url` — Google Review link
- `review_delay_days` — days after completion to send (default: 1)

**Dependencies:** `lead_capture`

**What it includes:**
- Agent runs daily
- Finds completed jobs without review request
- Sends SMS with review link
- One request per job (idempotency)

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/ReviewRequestAgent.ts` — daily at 10am

---

## 6. Referral Engine

| Field | Value |
|-------|-------|
| **Module key** | `referral_request` |
| **Tier** | Pro |
| **Implement** | Phase 3 (now) |

**Purpose:** Ask satisfied customers for referrals with bonus incentive.

**Business outcome:** Referral leads have highest close rate (~60%) and lowest acquisition cost.

**Required tables:** `leads`, `messages`, `idempotency_keys`

**Required integrations:** Telnyx

**Required config:**
- `sms_templates.referral_request` — message template
- `referral_bonus` — incentive amount (e.g., $100)
- `referral_delay_days` — days after completion (default: 3)

**Dependencies:** `lead_capture`

**What it includes:**
- Agent runs daily
- Finds completed jobs without referral request
- Sends SMS with referral incentive
- Tracks referral source on new leads

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/ReferralRequestAgent.ts` — daily at 2pm

---

## 7. Content Engine

| Field | Value |
|-------|-------|
| **Module key** | `content_engine` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** AI-powered content generation for social media. Creates carousels, posts, and copy.

**Business outcome:** Consistent social media presence without manual content creation.

**Required tables:** `content_drafts`, `agent_activity_log`

**Required integrations:** Claude (content generation)

**Required config:**
- `content_pillars` — array of topic categories
- `brand_voice` — tone description for AI
- `content_formats` — array of format template definitions
- `business_name` — for branding in content

**Dependencies:** None

**What it includes:**
- Agent generates content based on format templates and pillars
- Claude API creates headline, body copy, hashtags
- Drafts saved to content_drafts with status='draft'
- Supports multiple format variations (editorial, listicle, story, etc.)

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/ContentGenerationAgent.ts`
- WellMor: `agents/content-agent.js`, `agents/format-templates.js` (8 formats)

---

## 8. Image Generation

| Field | Value |
|-------|-------|
| **Module key** | `image_generation` |
| **Tier** | Pro |
| **Implement** | Phase 3 (now) |

**Purpose:** AI-generated and composited images for social content. Combines AI backgrounds with text overlay and branding.

**Business outcome:** Professional-quality visuals without a designer.

**Required tables:** `content_drafts`

**Required integrations:** Gemini (image generation), Sharp (compositing)

**Required config:**
- `brand_colors` — primary, secondary colors
- `logo_url` — brand logo for compositing
- `image_style` — "editorial", "bold", "minimal"

**Dependencies:** `content_engine`

**What it includes:**
- Gemini API generates photographic backgrounds
- Solid color backgrounds for text-heavy slides (no API call needed)
- Sharp composites text overlay + logo + shadows
- Supports carousel (multi-slide) and single image formats
- Brightness detection for auto-contrast text color

**Source code references:**
- WellMor: `agents/image-agent.js` (31KB — full pipeline with Gemini + Sharp)
- AKA: No equivalent (AKA uses before/after photos, not AI images)

---

## 9. Approval Queue

| Field | Value |
|-------|-------|
| **Module key** | `approval_queue` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** Human review gate before content goes live. Owner/admin approves or rejects drafts.

**Business outcome:** Quality control without slowing down content creation.

**Required tables:** `content_drafts`, `tenant_users`

**Required integrations:** Expo Push (notification on new draft)

**Required config:**
- `auto_approve` — boolean, skip queue (default: false)
- `notify_on_draft` — array of user IDs to notify

**Dependencies:** `content_engine`

**What it includes:**
- API endpoints: list drafts, approve, reject
- Push notification to mobile when new draft arrives
- Approval tracked with approver ID and timestamp
- Rejected items include reason
- Mobile app approval screen with swipe actions

**Source code references:**
- WellMor: `agents/approval-queue-agent.js`, mobile `PendingPostsScreen.js`
- AKA: `a-kut-above-api/src/routes/content.ts` (approve/reject endpoints)

---

## 10. Publishing / Buffer Integration

| Field | Value |
|-------|-------|
| **Module key** | `publishing` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** Auto-publish approved content to social media platforms via Buffer.

**Business outcome:** Hands-off publishing. Approve on phone, it posts automatically.

**Required tables:** `content_drafts`

**Required integrations:** Buffer

**Required config:**
- `buffer_channels` — map of platform → channel ID
- `publish_schedule` — when to publish (or immediate on approval)

**Dependencies:** `approval_queue`

**What it includes:**
- Agent watches for approved content
- Uploads images and text to Buffer API
- Updates content_drafts with buffer_post_id and posted_at
- Supports LinkedIn, Instagram, Facebook, Threads

**Source code references:**
- WellMor: `agents/publisher-agent.js`, `agents/buffer-publisher.js`
- AKA: `a-kut-above-api/src/services/socialPublisher.ts`

---

## 11. Outreach Engine

| Field | Value |
|-------|-------|
| **Module key** | `outreach_drip` |
| **Tier** | Pro |
| **Implement** | Phase 3 (now) |

**Purpose:** Multi-stage AI-personalized email drip campaigns to referral partners or prospects.

**Business outcome:** Builds referral network on autopilot. 6-month nurture sequence.

**Required tables:** `contacts`, `outreach_campaigns`, `messages`, `idempotency_keys`

**Required integrations:** Email (SMTP/Resend), Claude (personalization)

**Required config:**
- `outreach_stages` — array of `{ stage, delay_days, template_prompt }` objects
- `outreach_contact_types` — target categories (realtors, HR directors, etc.)
- `outreach_daily_limit` — max emails per day

**Dependencies:** `lead_capture` (for contact management)

**What it includes:**
- Multi-stage email sequence (configurable, AKA uses 7 stages)
- Claude-powered personalization per contact
- Bounce handling and auto-pause
- Stage progression tracking
- Daily send limits to avoid spam flags

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/OutreachDripAgent.ts` — 7 stages, Mon/Thu at 9am
- WellMor: `agents/outreach-agent.js` — similar pattern for B2B prospects

---

## 12. Prospecting Engine

| Field | Value |
|-------|-------|
| **Module key** | `prospecting` |
| **Tier** | Pro |
| **Implement** | Phase 3 (now) |

**Purpose:** AI-powered discovery of new referral partners or sales prospects.

**Business outcome:** Fills the top of the outreach funnel automatically.

**Required tables:** `contacts`, `agent_activity_log`

**Required integrations:** Apollo (AKA), Claude (both), Serper (WellMor)

**Required config:**
- `daily_target` — number of new contacts per day
- `prospect_types` — weighted categories (e.g., realtors 40%, insurance 30%)
- `service_areas` — geographic targeting
- `exclusion_domains` — skip these companies

**Dependencies:** None (feeds into `outreach_drip`)

**What it includes:**
- Apollo.io search for B2B contacts (AKA pattern)
- AI-powered prospect generation from service area (AKA pattern)
- Web search + enrichment (WellMor pattern)
- Deduplication against existing contacts
- Daily target enforcement

**Source code references:**
- AKA: `a-kut-above-agents/src/agents/ProspectingAgent.ts`, `EmailVerificationAgent.ts`, `ContactEnrichmentAgent.ts`
- WellMor: `agents/prospecting-agent.js`, `agents/enrichment-agent.js`

---

## 13. Lead Scoring

| Field | Value |
|-------|-------|
| **Module key** | `lead_scoring` |
| **Tier** | Pro |
| **Implement** | Phase 3 (now) |

**Purpose:** AI-based qualification scoring. Prioritizes leads by fit and intent.

**Business outcome:** Focus outreach on highest-value prospects. Stop wasting time on bad fits.

**Required tables:** `leads` (lead_score, priority_tier columns)

**Required integrations:** Claude

**Required config:**
- `scoring_prompt` — AI prompt defining scoring criteria
- `tier_thresholds` — `{ tier_a: 75, tier_b: 50 }` cutoffs
- `scoring_dimensions` — what to evaluate (company size, industry fit, etc.)

**Dependencies:** `lead_capture`

**What it includes:**
- Claude analyzes lead data against ICP criteria
- Returns 0-100 score with breakdown
- Assigns priority tier (A/B/C)
- Re-scores when lead data is updated

**Source code references:**
- WellMor: `agents/scoring-agent.js` — 6-dimension scoring rubric

---

## 14. Executive Digest / Reporting

| Field | Value |
|-------|-------|
| **Module key** | `digest` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** Daily/weekly AI-generated business summary. Dashboard + email/Slack briefing.

**Business outcome:** Owner knows what happened without checking every screen.

**Required tables:** `agent_activity_log`, `leads`, `content_drafts`, `messages`

**Required integrations:** Email or Slack (delivery), Claude (summarization)

**Required config:**
- `digest_schedule` — "daily" or "weekly"
- `digest_recipients` — email addresses or Slack channels
- `digest_sections` — which metrics to include

**Dependencies:** None (reads from all other module data)

**What it includes:**
- Aggregates key metrics across all modules
- Claude generates natural language summary
- Delivered via email, Slack, or push notification
- Dashboard widget with at-a-glance stats

**Source code references:**
- WellMor: `agents/chief-of-staff-agent.js` — comprehensive briefing
- AKA: `a-kut-above-workflows/n8n/daily-digest.json`

---

## 15. Mobile Approvals

| Field | Value |
|-------|-------|
| **Module key** | `mobile_approvals` |
| **Tier** | Core |
| **Implement** | Phase 3 (now) |

**Purpose:** Mobile interface for content review and approval.

**Business outcome:** Morgan (or any non-technical owner) can approve content from her phone in 10 seconds.

**Required tables:** `content_drafts`

**Required integrations:** Expo Push

**Required config:** None (uses approval_queue config)

**Dependencies:** `approval_queue`

**What it includes:**
- Pending posts list with image preview
- Full post detail view
- Approve/reject buttons
- Push notification on new drafts
- Posted history view

**Source code references:**
- WellMor: `mobile-app/src/screens/PendingPostsScreen.js`, `PostDetailScreen.js`
- AKA: `a-kut-above-app/app/(tabs)/content.tsx`

---

## 16. Finance Tracking

| Field | Value |
|-------|-------|
| **Module key** | `finance` |
| **Tier** | Pro |
| **Implement** | Later (Phase 4+) |

**Purpose:** Income, expense, crew pay, and debt tracking.

**Business outcome:** Financial visibility without QuickBooks. Especially useful for service businesses.

**Required tables:** `finance_entries`, `crew_members`

**Required integrations:** None

**Required config:**
- `finance_categories` — expense categories
- `crew_rates` — daily/hourly rates

**Dependencies:** `lead_capture` (income tied to jobs)

**What it includes:**
- Income logging per job
- Expense tracking by category
- Crew daily pay calculation
- Monthly/annual summaries
- Debt tracking and payoff planning

**Source code references:**
- AKA: `a-kut-above-api/src/routes/finance.ts`, `financeService.ts`
- AKA Portal: `a-kut-above-portal/src/pages/Finance.tsx`, `Debt.tsx`

**Why deferred:** Finance is fully working in AKA but only applies to service verticals. Port it after core modules are stable.

---

## 17. Onboarding Automation

| Field | Value |
|-------|-------|
| **Module key** | `onboarding` |
| **Tier** | Future |
| **Implement** | Later (Phase 5+) |

**Purpose:** Guided setup flow for new tenants. Walks through config, integrations, and first content.

**Business outcome:** New tenant goes from sign-up to first automated action in < 1 hour.

**Required tables:** `tenants`, `tenant_config`, `tenant_modules`, `tenant_integrations`

**Required integrations:** All (guided connection)

**Required config:** Vertical preset as starting point

**Dependencies:** All core modules

**What it includes:**
- Step-by-step setup wizard
- Vertical preset selection
- Integration connection (Telnyx, Buffer, etc.)
- Brand configuration (colors, logo, voice)
- Test message send
- First content generation

**Source code references:** No existing code — new feature.

**Why deferred:** Requires all core modules to be working first. Build this when ready to onboard tenants beyond the initial two.

---

## Module Dependency Graph

```
lead_capture (foundation)
  ├── speed_to_lead
  ├── missed_call
  ├── follow_up
  ├── review_request
  ├── referral_request
  ├── lead_scoring
  └── finance

content_engine
  ├── image_generation
  ├── approval_queue
  │   ├── mobile_approvals
  │   └── publishing
  └── (standalone — no lead_capture dependency)

prospecting → outreach_drip

digest (reads all, depends on nothing)

onboarding (depends on everything)
```

---

## Module-to-Vertical Default Matrix

| Module | Tree Service | Benefits Consulting |
|--------|:---:|:---:|
| lead_capture | ON | ON |
| speed_to_lead | ON | OFF |
| missed_call | ON | OFF |
| follow_up | ON | OFF |
| review_request | ON | OFF |
| referral_request | ON | OFF |
| lead_scoring | OFF | ON |
| content_engine | ON | ON |
| image_generation | OFF | ON |
| approval_queue | ON | ON |
| mobile_approvals | ON | ON |
| publishing | ON | ON |
| outreach_drip | ON | ON |
| prospecting | ON | ON |
| digest | ON | ON |
| finance | ON | OFF |
| onboarding | Future | Future |

---

## Open Questions

| # | Question | Impact |
|---|----------|--------|
| 1 | Should `image_generation` be part of `content_engine` or separate? | Module granularity. Current: separate, because AKA uses photos not AI images. |
| 2 | Should `mobile_approvals` be a module or just part of `approval_queue`? | UI feature flagging. Current: separate, so mobile approval can be disabled if portal-only. |
| 3 | Do we need an `analytics` module for marketing_performance? | WellMor has advertising-agent. Could be its own module or part of digest. |
| 4 | Should each outreach type (email drip, SMS follow-up) be separate modules? | Current: follow_up (SMS) and outreach_drip (email) are separate. Makes sense by channel. |
