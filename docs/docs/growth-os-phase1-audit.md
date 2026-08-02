> ⚠️ **ARCHIVED DESIGN DOC — DO NOT USE AS SOURCE OF TRUTH.**
> Written April 2026 under the retired working title "Growth OS", before the product shipped.
> The live system differs materially (15-module client catalog, Telnyx not Telnyx, in-house
> scheduler not n8n, web-form onboarding). For current facts use the code itself and
> `docs/business/` (see `docs/business/onboarding/onboarding-wizard-flow.md` v4).

# Growth OS — Phase 1: Deep Audit & Architecture Proposal

**Date:** 2026-04-09
**Author:** Claude (Principal Architect role)
**Status:** AUDIT COMPLETE — Awaiting approval before implementation

---

## 1. Repo Audit Summary

### A Kut Above (5 repos)

| Repo | Language | LOC (est) | Purpose |
|------|----------|-----------|---------|
| `a-kut-above-api` | TypeScript | ~4,000 | Express REST API (port 3000) |
| `a-kut-above-agents` | TypeScript | ~3,500 | 10 cron-based automation agents (port 3001) |
| `a-kut-above-portal` | TypeScript/React | ~5,000 | Vite SPA — leads, content, finance, crew |
| `a-kut-above-app` | TypeScript/RN | ~4,000 | Expo mobile — lead capture, photo upload |
| `a-kut-above-workflows` | SQL/JSON | ~1,500 | Schema migrations + 7 n8n workflows |

**Database:** Supabase (fogmqtnvmwahkmngmkds.supabase.co)
**Auth:** JWT via Supabase Auth (roles: admin, standard, crew)
**Hosting:** Railway (API + agents)

### WellMor (1 monolith + mobile)

| Component | Language | LOC (est) | Purpose |
|-----------|----------|-----------|---------|
| `agents/` | JavaScript | ~11,000 | Express server + 23 agents (port 3001) |
| `mobile-app/` | JavaScript/RN | ~2,000 | Expo mobile — dashboard, approvals, clients |
| `supabase/` | SQL | ~600 | Schema + migrations |
| `n8n-workflows/` | JSON | 10 files | Orchestration workflows |
| `benefitsiq/` | Next.js | ~500 | Admin dashboard (unused) |

**Database:** Supabase (qfnwjsjcufdrsokrnrzr.supabase.co)
**Auth:** Hardcoded credentials (owner/Westwood1) — no real auth
**Hosting:** Railway (wellmor-api)

---

## 2. Reusable vs Tenant-Specific Breakdown

### Reusable (port directly to Growth OS)

| Component | Source | Notes |
|-----------|--------|-------|
| Lead capture & CRM core | AKA | Status flow, source tracking, notes |
| Speed-to-lead SMS engine | AKA | Telnyx integration, template-driven |
| Follow-up sequence engine | AKA | Multi-step, day-based triggers |
| Review request engine | AKA | Post-completion trigger, link-based |
| Referral request engine | AKA | Post-completion trigger, bonus tracking |
| Content generation (AI) | Both | Claude-powered, prompt-driven |
| Image generation pipeline | WellMor | Gemini + Sharp compositing |
| Approval queue workflow | Both | draft/approved/rejected/posted |
| Buffer publishing | Both | GraphQL API, multi-channel |
| Outreach drip engine | AKA | 6-stage email sequences |
| Prospecting engine | Both | AI-powered, configurable targets |
| Lead scoring | WellMor | Claude-based ICP scoring |
| Chief of Staff dashboard | WellMor | Stats aggregation, briefing |
| Mobile app shell | Both | Tab nav, auth, push notifications |
| Portal shell | AKA | React + Vite, auth, routing |
| Finance tracking | AKA | Income, expenses, crew, debt |
| Job management | Both | Photo upload, completion tracking |
| Notification service | WellMor | Email, Slack, push |
| AI wrapper (Claude) | Both | Retry logic, JSON parsing |
| AI wrapper (OpenAI) | Both | Research queries |
| Logger utility | Both | Color-coded, agent-tagged |

### Tenant-Specific (must be extracted to config)

| Item | Current Location | Migration Target |
|------|-----------------|-----------------|
| Business name | Hardcoded in 40+ files | `tenant_config.business_name` |
| Phone number | .env + code | `tenant_config.phone` |
| Email addresses | .env + code | `tenant_config.email` |
| Brand colors | CSS + image-agent | `tenant_config.brand_colors` |
| Service types | Schema ENUMs | `tenant_config.service_types` |
| Service areas | Agent code | `tenant_config.service_areas` |
| Content pillars | content-agent.js | `tenant_config.content_pillars` |
| SMS templates | smsService + agents | `tenant_config.sms_templates` |
| Outreach templates | drip agent | `tenant_config.outreach_templates` |
| System prompts | Scattered in agents | `tenant_config.ai_prompts` |
| Scoring criteria | scoring-agent | `tenant_config.scoring_rules` |
| Referral bonus amounts | Agent code ($100) | `tenant_config.referral_bonus` |
| Google Review URL | .env | `tenant_config.review_url` |
| Buffer channel IDs | .env | `tenant_integrations` |
| Telnyx phone number | .env | `tenant_integrations` |
| Format templates (8) | format-templates.js | `tenant_config.content_formats` |
| Logo/branding assets | assets/ | `tenant_config.assets` (Supabase Storage) |

---

## 3. Security & Infrastructure Gaps

### CRITICAL (Fix immediately, before Growth OS)

| Issue | Both Systems | Impact |
|-------|-------------|--------|
| API keys in .env files committed to repos | Yes | Full API access to anyone with repo access |
| No auth on dashboard/approval endpoints | WellMor | Anyone can approve/reject content |
| Unsigned webhooks (Telnyx, Calendly, Instantly) | Both | Spoofed events, fake leads |
| Supabase service key exposed | Both | Full database read/write |
| SMTP password in .env | AKA | Email account compromise |
| CORS open to `*` | WellMor | Cross-origin attacks |
| No input validation on webhooks | WellMor | Injection attacks |

### MEDIUM (Address in Growth OS design)

| Issue | System | Impact |
|-------|--------|--------|
| No rate limiting per endpoint | WellMor | API quota exhaustion |
| No idempotency on external actions | Both | Duplicate SMS, emails, posts |
| Duplicated utility functions across agents | Both | Maintenance burden |
| System prompts hardcoded in agent files | Both | Can't update without deploy |
| No test suites | Both | Regression risk |
| No monitoring/metrics | Both | Blind to failures |
| No connection pooling | Both | DB connection exhaustion under load |
| Agent secret is guessable | WellMor | Weak auth |

### LOW (Nice to have)

| Issue | Notes |
|-------|-------|
| No logging to external service | Logs lost on container restart |
| No request size limits | DOS vector |
| No health check dependencies | /health doesn't check DB |
| Backup files (.backup.*) in codebase | ~5k LOC of dead code in WellMor |

---

## 4. Proposed Growth OS Architecture

### High-Level Diagram

```
                    ┌─────────────────────────────┐
                    │        Growth OS Core         │
                    │    (Multi-Tenant Platform)     │
                    └──────────┬──────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
   ┌────▼────┐          ┌─────▼─────┐          ┌─────▼─────┐
   │   API   │          │  Workers  │          │   Portal  │
   │ Express │          │  Agents   │          │   Vite    │
   │ :3000   │          │  Crons    │          │   :5173   │
   └────┬────┘          └─────┬─────┘          └─────┬─────┘
        │                      │                      │
        ├──────────────────────┼──────────────────────┤
        │                      │                      │
   ┌────▼──────────────────────▼──────────────────────▼────┐
   │                    Supabase                            │
   │   PostgreSQL + Auth + Storage + Row-Level Security     │
   └───────────────────────────────────────────────────────┘
        │
   ┌────▼────────────────────────────┐
   │        External Services         │
   │  Telnyx · Buffer · Claude ·      │
   │  Gemini · Serper · Expo Push     │
   └──────────────────────────────────┘
```

### Tenant Resolution Flow

```
Request → Auth Middleware → Extract tenant_id from JWT
       → RLS enforces row isolation
       → Agent loads tenant_config for prompts/templates
       → Integration uses tenant's API keys
```

---

## 5. Monorepo Structure

```
/growth-os
├── apps/
│   ├── api/                    # Express REST API (TypeScript)
│   │   ├── src/
│   │   │   ├── routes/         # Lead, content, outreach, finance, auth
│   │   │   ├── services/       # Business logic (tenant-aware)
│   │   │   ├── middleware/     # Auth, tenant resolution, rate limit, validation
│   │   │   └── webhooks/      # Telnyx, Calendly, Buffer (signed)
│   │   └── package.json
│   │
│   ├── worker/                 # Agent/cron runner (TypeScript)
│   │   ├── src/
│   │   │   ├── agents/         # Reusable agent implementations
│   │   │   ├── scheduler/      # Cron job orchestrator (tenant-aware)
│   │   │   └── queue/          # Job queue (Bull/BullMQ)
│   │   └── package.json
│   │
│   ├── portal/                 # Web dashboard (Vite + React)
│   │   ├── src/
│   │   │   ├── pages/          # Dashboard, leads, content, finance
│   │   │   ├── components/     # Shared UI components
│   │   │   └── hooks/          # useAuth, useTenant, useFinance
│   │   └── package.json
│   │
│   ├── mobile/                 # Mobile app (Expo)
│   │   ├── src/
│   │   │   ├── screens/        # Dashboard, leads, approvals
│   │   │   └── services/       # API client
│   │   └── package.json
│   │
│   └── admin/                  # Platform admin (future)
│       └── package.json
│
├── packages/
│   ├── core/                   # Shared business logic
│   │   ├── src/
│   │   │   ├── tenant.ts       # Tenant resolution, config loading
│   │   │   ├── modules.ts      # Feature flag system
│   │   │   └── utils.ts        # stripCodeFences, splitName, etc.
│   │   └── package.json
│   │
│   ├── db/                     # Database client & queries
│   │   ├── src/
│   │   │   ├── client.ts       # Supabase client factory (tenant-aware)
│   │   │   ├── queries/        # Typed query functions
│   │   │   └── migrations/     # SQL migrations
│   │   └── package.json
│   │
│   ├── config/                 # Tenant config schemas & defaults
│   │   ├── src/
│   │   │   ├── schema.ts       # Zod schemas for all config
│   │   │   ├── presets/        # tree-service.ts, benefits-consulting.ts
│   │   │   └── defaults.ts     # Base defaults
│   │   └── package.json
│   │
│   ├── agents/                 # Reusable agent modules
│   │   ├── src/
│   │   │   ├── speed-to-lead.ts
│   │   │   ├── follow-up.ts
│   │   │   ├── review-request.ts
│   │   │   ├── referral-request.ts
│   │   │   ├── content-generation.ts
│   │   │   ├── image-generation.ts
│   │   │   ├── prospecting.ts
│   │   │   ├── scoring.ts
│   │   │   ├── outreach-drip.ts
│   │   │   ├── publishing.ts
│   │   │   └── digest.ts
│   │   └── package.json
│   │
│   ├── integrations/           # External service wrappers
│   │   ├── src/
│   │   │   ├── telnyx.ts       # SMS sending (tenant phone)
│   │   │   ├── claude.ts       # Anthropic wrapper
│   │   │   ├── gemini.ts       # Google image gen
│   │   │   ├── buffer.ts       # Social publishing
│   │   │   ├── expo-push.ts    # Mobile notifications
│   │   │   └── email.ts        # SMTP/Resend
│   │   └── package.json
│   │
│   └── types/                  # Shared TypeScript types
│       ├── src/
│       │   ├── tenant.ts
│       │   ├── lead.ts
│       │   ├── content.ts
│       │   ├── agent.ts
│       │   └── index.ts
│       └── package.json
│
├── docs/
│   ├── growth-os-architecture.md
│   ├── data-model.md
│   ├── module-catalog.md
│   └── migration-plan.md
│
├── turbo.json                  # Turborepo config
├── package.json                # Root workspace
└── .env.example                # Template (NO real keys)
```

---

## 6. Schema Design

### Core Multi-Tenant Tables

```sql
-- Tenant (the business)
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                    -- "A Kut Above Tree Services"
  slug TEXT UNIQUE NOT NULL,             -- "a-kut-above"
  vertical TEXT NOT NULL,                -- "tree_service" | "benefits_consulting"
  status TEXT DEFAULT 'active',          -- active | suspended | trial
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Users who belong to a tenant
CREATE TABLE tenant_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  role TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member | crew
  email TEXT NOT NULL,
  full_name TEXT,
  UNIQUE(tenant_id, user_id)
);

-- All business config (replaces hardcoded values)
CREATE TABLE tenant_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,                     -- "business_name", "phone", "brand_colors", etc.
  value JSONB NOT NULL,                  -- Flexible value storage
  UNIQUE(tenant_id, key)
);

-- Feature flags per tenant
CREATE TABLE tenant_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  module TEXT NOT NULL,                  -- "speed_to_lead", "content_engine", "finance"
  enabled BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}',             -- Module-specific settings
  UNIQUE(tenant_id, module)
);

-- External service credentials per tenant
CREATE TABLE tenant_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  service TEXT NOT NULL,                 -- "telnyx", "buffer", "claude", "smtp"
  credentials JSONB NOT NULL,            -- Encrypted API keys, tokens
  config JSONB DEFAULT '{}',             -- Channel IDs, phone numbers, etc.
  UNIQUE(tenant_id, service)
);

-- Idempotency protection
CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  key TEXT NOT NULL,                     -- "sms:lead_123:step_1"
  action TEXT NOT NULL,                  -- "send_sms", "publish_post", "send_email"
  result JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, key)
);
```

### Business Tables (all get tenant_id)

```sql
-- Every existing table gets tenant_id added:
ALTER TABLE leads ADD COLUMN tenant_id UUID REFERENCES tenants(id);
ALTER TABLE contacts ADD COLUMN tenant_id UUID REFERENCES tenants(id);
ALTER TABLE content_queue ADD COLUMN tenant_id UUID REFERENCES tenants(id);
ALTER TABLE outreach_contacts ADD COLUMN tenant_id UUID REFERENCES tenants(id);
-- ... etc for all tables

-- RLS enforces isolation:
CREATE POLICY tenant_isolation ON leads
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

---

## 7. Module Catalog

| Module | Description | AKA | WellMor | Config Keys |
|--------|-------------|-----|---------|-------------|
| `lead_capture` | Lead intake, source tracking, status flow | Core | - | service_types, lead_sources, status_flow |
| `speed_to_lead` | Immediate SMS on new lead | Active | - | sms_template, delay_seconds |
| `follow_up` | Multi-step follow-up sequences | Active | - | steps[], day_delays[], templates[] |
| `review_request` | Post-completion review ask | Active | - | delay_days, review_url, template |
| `referral_request` | Post-completion referral ask | Active | - | delay_days, bonus_amount, template |
| `outreach_drip` | Multi-stage email sequences | Active | - | stages[], templates[], intervals[] |
| `prospecting` | AI-powered prospect discovery | Active | Active | daily_target, service_areas, contact_types |
| `lead_scoring` | AI-based lead qualification | - | Active | scoring_prompt, tier_thresholds |
| `content_engine` | AI content generation + images | Active | Active | content_pillars, formats, brand_voice |
| `image_generation` | AI image creation + compositing | - | Active | model, brand_colors, logo_path |
| `approval_queue` | Draft/approve/reject workflow | Active | Active | auto_approve, notify_on_draft |
| `publishing` | Buffer social media posting | Active | Active | channels{}, schedule{} |
| `digest` | Daily/weekly summary reports | Active | Active | recipients[], schedule, format |
| `finance` | Income, expenses, crew, debt | Active | - | categories[], crew_rates |
| `notifications` | Email, Slack, push alerts | Both | Both | channels[], templates[] |
| `job_photos` | Before/after photo management | Active | - | storage_bucket, max_size |
| `missed_call` | Telnyx missed call text-back | Active | - | template, auto_create_lead |

---

## 8. Migration Matrix

### Old Repos to New Locations

| Old Path | New Location | Notes |
|----------|-------------|-------|
| `a-kut-above-api/src/routes/` | `apps/api/src/routes/` | Add tenant middleware |
| `a-kut-above-api/src/services/` | `apps/api/src/services/` | Extract config to tenant_config |
| `a-kut-above-agents/src/agents/` | `packages/agents/src/` | Make tenant-aware |
| `a-kut-above-portal/src/` | `apps/portal/src/` | Add tenant context |
| `a-kut-above-app/src/` | `apps/mobile/src/` | Add tenant login |
| `wellmor-growth-system/agents/*.js` | `packages/agents/src/` | Convert JS→TS, extract config |
| `wellmor-growth-system/agents/shared/` | `packages/integrations/src/` | Generalize wrappers |
| `wellmor-growth-system/mobile-app/` | `apps/mobile/src/` | Merge with AKA mobile |
| `wellmor-growth-system/n8n-workflows/` | `docs/legacy-workflows/` | Replace with worker scheduler |

### Old Tables to New Schema

| Old Table | Old DB | New Table | Changes |
|-----------|--------|-----------|---------|
| `leads` (AKA) | fogmqt... | `leads` | + tenant_id, + RLS |
| `companies` (WM) | qfnwjs... | `leads` | Merge with leads, + tenant_id |
| `clients` (WM) | qfnwjs... | `leads` | Merge (was duplicate of companies) |
| `contacts` (WM) | qfnwjs... | `contacts` | + tenant_id |
| `outreach_contacts` (AKA) | fogmqt... | `contacts` | Merge, add contact_type |
| `content_drafts` (AKA) | fogmqt... | `content_queue` | Standardize schema |
| `content_queue` (WM) | qfnwjs... | `content_queue` | + tenant_id |
| `job_photos` (AKA) | fogmqt... | `job_photos` | + tenant_id |
| `automation_logs` (AKA) | fogmqt... | `agent_activity_log` | Merge, standardize |
| `agent_activity_log` (WM) | qfnwjs... | `agent_activity_log` | + tenant_id |
| `income_entries` (AKA) | fogmqt... | `finance_income` | + tenant_id |
| `expense_entries` (AKA) | fogmqt... | `finance_expenses` | + tenant_id |
| `crew_members` (AKA) | fogmqt... | `crew_members` | + tenant_id |

### Old Env Vars to New Config

| Old Var | System | New Location |
|---------|--------|-------------|
| `BUSINESS_PHONE` | AKA | `tenant_config.phone` |
| `BUSINESS_EMAIL` | AKA | `tenant_config.email` |
| `GOOGLE_REVIEW_URL` | AKA | `tenant_config.review_url` |
| `BUFFER_CHANNEL_*` | Both | `tenant_integrations.buffer.channels` |
| `TWILIO_*` | AKA | `tenant_integrations.telnyx` |
| `ANTHROPIC_API_KEY` | Both | `tenant_integrations.claude` (or platform-level) |
| `OPENAI_API_KEY` | Both | `tenant_integrations.openai` (or platform-level) |
| `GOOGLE_API_KEY` | WellMor | `tenant_integrations.gemini` (or platform-level) |

---

## 9. Vertical Presets

### Tree Service Preset

```typescript
const TREE_SERVICE_PRESET = {
  vertical: 'tree_service',
  modules: [
    'lead_capture', 'speed_to_lead', 'follow_up',
    'review_request', 'referral_request', 'outreach_drip',
    'content_engine', 'job_photos', 'publishing',
    'prospecting', 'finance', 'missed_call', 'digest'
  ],
  config: {
    service_types: ['tree_removal', 'trimming', 'stump_grinding', 'storm_cleanup', 'emergency', 'debris_haul'],
    lead_sources: ['google_search', 'google_ads', 'facebook', 'referral', 'yard_sign', 'missed_call', 'repeat'],
    sms_templates: { /* speed-to-lead, follow-up, review, referral */ },
    outreach_contact_types: ['realtor', 'insurance_agent', 'landscaper', 'contractor'],
    content_pillars: ['Before/after transformations', 'Storm damage expertise', 'Community involvement'],
    scoring_rules: null, // Not needed for tree service
  }
};
```

### Benefits Consulting Preset

```typescript
const BENEFITS_CONSULTING_PRESET = {
  vertical: 'benefits_consulting',
  modules: [
    'lead_capture', 'prospecting', 'lead_scoring',
    'content_engine', 'image_generation', 'approval_queue',
    'publishing', 'outreach_drip', 'digest', 'notifications'
  ],
  config: {
    service_types: ['benefits_audit', 'plan_design', 'compliance_review', 'enrollment_support'],
    lead_sources: ['linkedin', 'referral', 'website', 'cold_outreach', 'event'],
    content_pillars: ['Benefits as retention', 'Common employer mistakes', 'Modernizing benefits'],
    content_formats: [/* 8 format templates */],
    scoring_rules: { tier_a: 75, tier_b: 50 },
    outreach_contact_types: ['hr_director', 'cfo', 'ceo', 'benefits_broker'],
  }
};
```

---

## 10. Risks, Assumptions & Blockers

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Data migration breaks existing clients | High | Keep legacy systems running in parallel |
| Shared Supabase instance hits limits | Medium | Separate DB per tenant if needed |
| TypeScript migration of WellMor (currently JS) | Medium | Phase incrementally, start with types package |
| n8n dependency for WellMor workflows | Medium | Replace with worker scheduler |
| Single developer maintaining monorepo | Medium | Keep architecture simple, good docs |

### Assumptions

1. Both systems will migrate to a single Supabase project (new)
2. Railway can host API + worker as separate services in one project
3. AI API keys can be platform-level (shared) not per-tenant (for now)
4. Buffer is the publishing target for all tenants (for now)
5. Mobile app will be tenant-branded via config, not separate apps

### Blockers

1. **API key rotation** — Must happen before any code is shared/public
2. **Supabase project creation** — Need new project for Growth OS
3. **Domain/DNS** — Each tenant needs subdomain or custom domain
4. **Apple Developer** — Separate app or multi-tenant single app decision needed

---

## 11. Recommended Execution Order

1. **Phase 2** — Write architecture docs (this document, refined)
2. **Phase 3** — Scaffold monorepo with Turborepo
3. **Phase 4** — Build tenant schema + config system in new Supabase
4. **Phase 5a** — Port A Kut Above first (it's TypeScript, cleaner)
5. **Phase 5b** — Port WellMor second (JS→TS conversion)
6. **Phase 6** — Deploy, onboard, test

**Estimated timeline:** 4-6 weeks for a working MVP with both tenants.

---

## APPROVAL REQUESTED

This audit is complete. No code has been changed.

**Next step:** Review this document and confirm:
1. Does the architecture direction look right?
2. Any modules missing or misclassified?
3. Ready to proceed to Phase 2 (detailed docs) and Phase 3 (scaffold)?
