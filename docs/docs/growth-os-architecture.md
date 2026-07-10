> ⚠️ **ARCHIVED DESIGN DOC — DO NOT USE AS SOURCE OF TRUTH.**
> Written April 2026 under the retired working title "Growth OS", before the product shipped.
> The live system differs materially (15-module client catalog, Telnyx not Twilio, in-house
> scheduler not n8n, web-form onboarding). For current facts use the code itself and
> `docs/business/` (see `docs/business/onboarding/onboarding-wizard-flow.md` v4).

# Growth OS — Platform Architecture

**Version:** 1.0 — Phase 2 Blueprint
**Date:** 2026-04-09
**Status:** DESIGN — No code changes

---

## 1. Platform Vision

Growth OS is a multi-tenant growth automation platform that gives service businesses an AI-powered operating system for lead capture, outreach, content, and operations.

It extracts the best working patterns from two production systems (A Kut Above Tree Services and WellMor Benefits Consulting) into a single configurable platform where tenant behavior is driven by config and vertical presets — not code forks.

**Core principles:**

- One codebase serves all tenants
- Behavior is config-driven, not hardcoded
- Modules are opt-in per tenant
- AI agents are tenant-aware and reusable
- Security is enforced at the database level (RLS)
- Deployable and maintainable by one person

---

## 2. Repository Structure

**Decision:** Single unified repository. No Turborepo, NX, or workspace tooling.

**Rationale:** One developer maintains this. Workspace tooling adds configuration overhead, version coordination, and build complexity that provides no benefit at this scale. Standard `require('../core/tenant')` imports are simple, debuggable, and sufficient.

```
/growth-os
│
├── api/                        # Express REST API (Railway service 1)
│   ├── routes/
│   │   ├── auth.js
│   │   ├── leads.js
│   │   ├── contacts.js
│   │   ├── content.js
│   │   ├── outreach.js
│   │   ├── finance.js
│   │   ├── jobs.js
│   │   ├── approvals.js
│   │   └── admin.js
│   ├── middleware/
│   │   ├── auth.js             # JWT verification + tenant extraction
│   │   ├── tenant.js           # Set app.tenant_id for RLS
│   │   ├── rateLimit.js        # Per-tenant rate limiting
│   │   ├── validate.js         # Request validation
│   │   └── webhookVerify.js    # Twilio/Calendly signature checks
│   ├── webhooks/
│   │   ├── twilio.js           # Inbound SMS, missed calls
│   │   ├── calendly.js         # Meeting bookings
│   │   └── buffer.js           # Publish confirmations
│   └── server.js               # Express app entry point
│
├── worker/                     # Agent runner (Railway service 2)
│   ├── agents/
│   │   ├── speed-to-lead.js
│   │   ├── follow-up.js
│   │   ├── review-request.js
│   │   ├── referral-request.js
│   │   ├── prospecting.js
│   │   ├── enrichment.js
│   │   ├── scoring.js
│   │   ├── outreach-drip.js
│   │   ├── content-generation.js
│   │   ├── image-generation.js
│   │   ├── publisher.js
│   │   ├── digest.js
│   │   ├── meeting-prep.js
│   │   └── reply-classification.js
│   ├── scheduler/
│   │   └── cron.js             # Tenant-aware cron orchestrator
│   ├── jobs/
│   │   └── processor.js        # Polls agent_jobs table
│   └── index.js                # Worker entry point
│
├── portal/                     # Web dashboard (static deploy)
│   ├── src/
│   │   ├── pages/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── api/
│   ├── vite.config.js
│   └── package.json            # Portal has own package.json (Vite build)
│
├── mobile/                     # Expo mobile app
│   ├── src/
│   │   ├── screens/
│   │   ├── components/
│   │   ├── services/
│   │   └── constants/
│   ├── app.json
│   └── package.json            # Mobile has own package.json (Expo)
│
├── core/                       # Shared business logic
│   ├── tenant.js               # loadTenantConfig(), resolveTenant()
│   ├── modules.js              # isModuleEnabled(), getModuleConfig()
│   ├── config.js               # getConfig(), mergeWithDefaults()
│   ├── utils.js                # stripCodeFences, splitName, etc.
│   ├── errors.js               # Standardized error classes
│   └── logger.js               # Color-coded, agent-tagged logging
│
├── integrations/               # External service wrappers
│   ├── twilio.js               # sendSms(), tenant phone resolution
│   ├── claude.js               # askClaude(), askClaudeJSON()
│   ├── gemini.js               # generateImage()
│   ├── buffer.js               # publishToBuffer(), tenant channels
│   ├── expo-push.js            # sendPushNotification()
│   ├── email.js                # sendEmail() via SMTP/Resend
│   ├── apollo.js               # searchPeople(), enrichCompany()
│   └── serper.js               # webSearch()
│
├── db/                         # Database layer
│   ├── client.js               # Supabase client factory
│   ├── schema.sql              # Full schema (source of truth)
│   ├── migrations/             # Numbered migration files
│   │   ├── 001_tenants.sql
│   │   ├── 002_business_tables.sql
│   │   ├── 003_rls_policies.sql
│   │   └── 004_seed_presets.sql
│   └── queries/                # Reusable query functions
│       ├── leads.js
│       ├── contacts.js
│       ├── content.js
│       └── config.js
│
├── config/                     # Tenant presets and defaults
│   ├── defaults.js             # Base config all tenants inherit
│   ├── presets/
│   │   ├── tree-service.js
│   │   └── benefits-consulting.js
│   └── schemas.js              # Config validation (Joi or Zod)
│
├── docs/                       # Architecture and planning docs
├── scripts/                    # Utility scripts
│   ├── seed-tenant.js          # Create tenant from preset
│   ├── migrate.js              # Run migrations
│   └── health-check.js         # Verify all services
│
├── package.json                # Root: api + worker dependencies
├── .env.example                # Template (NO real keys)
├── .gitignore
└── README.md
```

**Why portal/ and mobile/ have their own package.json:**

Portal is a Vite/React app with its own build toolchain. Mobile is an Expo app with its own native dependencies. These are fundamentally different from the Node.js server code. Keeping them with separate `package.json` files avoids dependency conflicts while still living in the same repo.

**Why everything else shares root package.json:**

API, worker, core, integrations, db, and config are all Node.js server code sharing the same dependencies (express, @supabase/supabase-js, @anthropic-ai/sdk, sharp, etc.). One `npm install` covers them all.

---

## 3. Service Boundaries

### API Service (Railway Service 1)

**Responsibilities:**
- Handle HTTP requests from portal, mobile, and webhooks
- Authenticate users, resolve tenant
- CRUD operations on all business entities
- Queue agent jobs (write to `agent_jobs` table)
- Serve static assets (generated images, logos)

**Does NOT:**
- Run cron jobs
- Execute long-running agent tasks
- Call AI APIs directly (delegates to worker via job queue)

### Worker Service (Railway Service 2)

**Responsibilities:**
- Run scheduled cron jobs (tenant-aware)
- Poll `agent_jobs` table for on-demand work
- Execute all agent logic (prospecting, content, outreach, etc.)
- Call external APIs (Claude, Gemini, Twilio, Buffer)
- Write results back to database

**Does NOT:**
- Serve HTTP requests to end users
- Handle authentication
- Serve the portal or mobile app

### Portal (Static Deploy)

**Responsibilities:**
- Web dashboard for tenant owners/admins
- Lead management, content approval, finance, reporting
- Calls API service for all data

### Mobile App (Expo/EAS)

**Responsibilities:**
- Mobile dashboard and approvals
- Push notification recipient
- Calls API service for all data

---

## 4. Tenant-Aware Runtime Model

### Request Flow

```
1. Request arrives at API
2. Auth middleware verifies JWT (Supabase Auth)
3. Tenant middleware extracts tenant_id from JWT claims
4. Middleware calls: SET LOCAL app.tenant_id = '<uuid>'
5. All subsequent Supabase queries auto-filtered by RLS
6. If agent work needed: INSERT INTO agent_jobs (tenant_id, ...)
```

### Agent Flow

```
1. Worker scheduler fires cron for each active tenant
2. Or: Worker polls agent_jobs for pending work
3. Agent loads tenant config: SELECT * FROM tenant_config WHERE tenant_id = ?
4. Agent loads integration creds: SELECT * FROM tenant_integrations WHERE tenant_id = ?
5. Agent executes with tenant-specific config (templates, prompts, brand)
6. Agent checks idempotency: SELECT FROM idempotency_keys WHERE key = ?
7. Agent performs action, logs result to agent_activity_log
```

### Tenant Resolution

```javascript
// core/tenant.js
async function resolveTenant(supabase, tenantId) {
  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  const { data: config } = await supabase
    .from('tenant_config')
    .select('key, value')
    .eq('tenant_id', tenantId);

  const { data: modules } = await supabase
    .from('tenant_modules')
    .select('module, enabled, config')
    .eq('tenant_id', tenantId);

  return {
    ...tenant,
    config: Object.fromEntries(config.map(c => [c.key, c.value])),
    modules: Object.fromEntries(modules.map(m => [m.module, { enabled: m.enabled, ...m.config }])),
  };
}
```

---

## 5. Scheduling & Queue Strategy

### Problem from Phase 1

Both legacy systems have a **duplicate scheduler problem**: n8n runs cron schedules that call agent endpoints, AND agents have their own internal cron. This causes double-execution and makes it unclear which system is the source of truth.

### Solution: Single Internal Scheduler

The worker service owns ALL scheduling. n8n is eliminated.

```javascript
// worker/scheduler/cron.js
const cron = require('node-cron');
const { getAllActiveTenants } = require('../../db/queries/config');

const SCHEDULE = [
  { agent: 'prospecting',      cron: '0 6 * * 1-5',   module: 'prospecting' },
  { agent: 'enrichment',       cron: '0 7 * * 1-5',   module: 'prospecting' },
  { agent: 'scoring',          cron: '30 7 * * 1-5',   module: 'lead_scoring' },
  { agent: 'speed-to-lead',    cron: '*/2 * * * *',    module: 'speed_to_lead' },
  { agent: 'follow-up',        cron: '0 8-18 * * 1-5', module: 'follow_up' },
  { agent: 'outreach-drip',    cron: '0 9 * * 1,4',    module: 'outreach_drip' },
  { agent: 'review-request',   cron: '0 10 * * *',     module: 'review_request' },
  { agent: 'referral-request', cron: '0 14 * * *',     module: 'referral_request' },
  { agent: 'content-generation',cron: '0 11 * * 1',    module: 'content_engine' },
  { agent: 'publisher',        cron: '0 9 * * 1-5',    module: 'publishing' },
  { agent: 'digest',           cron: '0 17 * * 1-5',   module: 'digest' },
];

async function startScheduler() {
  for (const job of SCHEDULE) {
    cron.schedule(job.cron, async () => {
      const tenants = await getAllActiveTenants();
      for (const tenant of tenants) {
        if (isModuleEnabled(tenant, job.module)) {
          await enqueueJob(tenant.id, job.agent);
        }
      }
    });
  }
}
```

### Job Queue (No Redis)

Instead of Bull/BullMQ (which requires Redis), use the `agent_jobs` table in Supabase as a simple job queue:

```javascript
// worker/jobs/processor.js
async function pollJobs() {
  const { data: jobs } = await supabase
    .from('agent_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at')
    .limit(5);

  for (const job of jobs) {
    await supabase.from('agent_jobs').update({ status: 'processing' }).eq('id', job.id);
    try {
      await runAgent(job.agent_name, job.tenant_id, job.payload);
      await supabase.from('agent_jobs').update({ status: 'completed' }).eq('id', job.id);
    } catch (err) {
      await supabase.from('agent_jobs').update({ status: 'failed', error: err.message }).eq('id', job.id);
    }
  }
}

// Poll every 10 seconds
setInterval(pollJobs, 10_000);
```

**Tradeoff:** This is simpler than Redis but has ~10s latency for on-demand jobs. For speed-to-lead (which needs near-instant response), the webhook handler can call the agent directly rather than going through the queue.

### Deferred Enhancement

If job volume grows or latency requirements tighten, migrate to Supabase Realtime subscriptions (listen for INSERT on `agent_jobs`) or add Redis/BullMQ. The agent code doesn't change — only the job dispatch layer.

---

## 6. Config-Driven Architecture

### Philosophy

Every tenant-specific value lives in the database, not in code. Agents read config at runtime. Changing a tenant's behavior = updating a row, not deploying code.

### Config Layers (most specific wins)

```
1. Platform defaults       (config/defaults.js)
2. Vertical preset         (config/presets/tree-service.js)
3. Tenant config           (tenant_config table)
4. Module config           (tenant_modules.config column)
5. Per-run overrides       (agent_jobs.payload)
```

### Example: How an agent resolves its config

```javascript
// An agent needs SMS template for speed-to-lead
const defaults = require('../../config/defaults');
const preset = require(`../../config/presets/${tenant.vertical}`);
const tenantConfig = tenant.config; // from tenant_config table

const smsTemplate = tenantConfig.sms_templates?.speed_to_lead
  || preset.config.sms_templates?.speed_to_lead
  || defaults.sms_templates.speed_to_lead;
```

---

## 7. Module System

### Design

Modules are feature flags with optional config. Each module maps to:
- One or more agents
- One or more API routes
- One or more UI sections
- Required integrations

```javascript
// core/modules.js
function isModuleEnabled(tenant, moduleName) {
  return tenant.modules[moduleName]?.enabled === true;
}

function getModuleConfig(tenant, moduleName) {
  return tenant.modules[moduleName] || {};
}
```

### Module-aware middleware

```javascript
// api/middleware/moduleGuard.js
function requireModule(moduleName) {
  return (req, res, next) => {
    if (!isModuleEnabled(req.tenant, moduleName)) {
      return res.status(403).json({ error: `Module '${moduleName}' not enabled` });
    }
    next();
  };
}

// Usage in routes:
router.get('/leads', requireModule('lead_capture'), leadsController.list);
```

### Deferred Enhancement

A full plugin/skills registry is not needed now. If the platform grows beyond 5+ verticals or allows third-party modules, introduce a formal module registry with lifecycle hooks. For now, the simple `isModuleEnabled()` check is sufficient.

---

## 8. Security Principles

### Target-State Design

| Layer | Mechanism |
|-------|-----------|
| Authentication | Supabase Auth (JWT) — replaces hardcoded creds |
| Authorization | Role-based (owner, admin, member, crew) |
| Tenant isolation | Supabase RLS on every business table |
| API protection | Rate limiting per tenant, request validation |
| Webhook security | Signature verification (Twilio, Calendly) |
| Secrets | Platform env vars for shared keys, `tenant_integrations` for per-tenant keys (encrypted at rest in Supabase) |
| Idempotency | `idempotency_keys` table prevents duplicate SMS/email/posts |
| CORS | Whitelist tenant domains, not `*` |
| Input validation | Joi/Zod schemas on all API inputs |

### Phase 3 Implementation Plan

1. Set up Supabase Auth with email/password
2. Add JWT middleware to API
3. Create RLS policies for all tables
4. Add webhook signature verification
5. Add rate limiting (express-rate-limit, keyed by tenant_id)
6. Add input validation middleware

### Deferred Enhancement

- Encrypted `tenant_integrations.credentials` column (Supabase Vault)
- API key rotation automation
- Audit log for all admin actions
- SOC2-style access logging

---

## 9. Legacy System Mapping

### How A Kut Above maps into Growth OS

| AKA Component | Growth OS Location | Notes |
|---------------|-------------------|-------|
| `a-kut-above-api/routes/` | `api/routes/` | Add tenant middleware, merge with WellMor routes |
| `a-kut-above-api/services/` | `api/routes/` (inline) or `core/` | Simplify — services were thin wrappers |
| `a-kut-above-agents/agents/` | `worker/agents/` | Make tenant-aware, keep logic |
| `a-kut-above-agents/scheduler/` | `worker/scheduler/cron.js` | Merge into single scheduler |
| `a-kut-above-portal/` | `portal/` | Add tenant context, keep UI |
| `a-kut-above-app/` | `mobile/` | Merge best of both mobile apps |
| `a-kut-above-workflows/n8n/` | Eliminated | Replaced by worker scheduler |
| `a-kut-above-workflows/supabase/` | `db/migrations/` | Merge schemas, add tenant_id |

### How WellMor maps into Growth OS

| WellMor Component | Growth OS Location | Notes |
|-------------------|-------------------|-------|
| `agents/server.js` | `api/server.js` | Split routes from agents |
| `agents/*.js` (agent logic) | `worker/agents/` | Extract config, make tenant-aware |
| `agents/shared/` | `integrations/` + `core/` | Generalize wrappers |
| `agents/format-templates.js` | `config/presets/benefits-consulting.js` | Move to tenant config |
| `mobile-app/` | `mobile/` | Merge with AKA mobile |
| `n8n-workflows/` | Eliminated | Replaced by worker scheduler |
| `supabase/` | `db/migrations/` | Merge, add tenant_id |

---

## 10. Open Questions

| # | Question | Impact | Default Assumption |
|---|----------|--------|--------------------|
| 1 | JavaScript or TypeScript for initial build? | Development speed vs safety | Start JS, add types later |
| 2 | Single mobile app binary or per-tenant apps? | App Store strategy | Single app, tenant login |
| 3 | Portal per-tenant subdomain or single URL with tenant switch? | UX, DNS complexity | Single URL, tenant in JWT |
| 4 | Shared Supabase project or one per tenant? | Cost, isolation, complexity | Shared with RLS |
| 5 | Keep n8n for anything? | Operational complexity | Fully eliminate |
| 6 | AI keys shared or per-tenant? | Cost tracking, rate limits | Platform-level for now |

---

## Appendix: What This Architecture Does NOT Include (Intentionally)

- **Microservices** — Two services (API + Worker) is enough. Don't split further.
- **GraphQL** — REST is simpler and both legacy systems use it.
- **Docker/K8s** — Railway handles containers. No need to manage Dockerfiles.
- **Event sourcing** — Simple CRUD with audit logs is sufficient.
- **Multi-region** — Single region is fine for current scale.
- **Real-time subscriptions** — Polling is adequate. Add Supabase Realtime later if needed.
