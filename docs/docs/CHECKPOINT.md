> ⚠️ **ARCHIVED DESIGN DOC — DO NOT USE AS SOURCE OF TRUTH.**
> Written April 2026 under the retired working title "Growth OS", before the product shipped.
> The live system differs materially (15-module client catalog, Telnyx not Twilio, in-house
> scheduler not n8n, web-form onboarding). For current facts use the code itself and
> `docs/business/` (see `docs/business/onboarding/onboarding-wizard-flow.md` v4).

# Growth OS — Project Checkpoint

**Last updated:** 2026-04-10

---

## Phase Status

| Phase | Status | Date |
|-------|--------|------|
| Phase 1: Deep Audit | COMPLETE | 2026-04-09 |
| Phase 2: Platform Blueprint | COMPLETE | 2026-04-09 |
| Phase 3A: Foundation | COMPLETE | 2026-04-10 |
| Phase 3B: Content Pipeline | NOT STARTED | — |
| Phase 3C: Communication Agents | NOT STARTED | — |
| Phase 3D: Intelligence Agents | NOT STARTED | — |
| Phase 3E: Frontend | NOT STARTED | — |
| Phase 3F: Data Migration | NOT STARTED | — |

---

## Phase 1 Summary

Audited both legacy systems:
- **A Kut Above:** 5 repos, TypeScript, ~18,000 LOC, 10 agents, Supabase + Railway
- **WellMor:** 1 monolith, JavaScript, ~14,000 LOC, 23 agents, Supabase + Railway + n8n

Identified 20+ reusable components, 15+ tenant-specific items to extract, 7 critical security gaps, and 8 medium-severity issues.

**Deliverable:** `docs/growth-os-phase1-audit.md`

---

## Phase 2 Summary

Produced 6 architecture documents covering the full Growth OS platform design:

| Document | Key Decisions |
|----------|--------------|
| `growth-os-architecture.md` | Single repo (no Turborepo), 2 Railway services, config-driven modules, Supabase RLS |
| `data-model.md` | 18 tables, tenant_id on all business tables, RLS policies, idempotency keys, JSONB config |
| `module-catalog.md` | 17 modules, Core/Pro/Future tiers, dependency graph, vertical default matrix |
| `migration-plan.md` | Extract-not-rebuild philosophy, 6-phase migration, full migration matrix |
| `deployment-architecture.md` | Railway API + Worker, Supabase, no Redis, no n8n, webhook security |
| `vertical-presets.md` | Tree service + benefits consulting presets, config templates, SMS/email defaults |

---

## Phase 3A Summary — Foundation

All code-level foundation work is complete. The platform is ready for Supabase project creation and Railway deployment.

### What was built

| Component | Files | Status |
|-----------|-------|--------|
| **Full schema** | `db/schema.sql` (source of truth) | COMPLETE |
| **Migrations** | `db/migrations/001-003.sql` | COMPLETE |
| **Core modules** | `core/tenant.js`, `modules.js`, `config.js`, `logger.js`, `errors.js`, `utils.js` | COMPLETE |
| **DB client** | `db/client.js` (service + anon clients) | COMPLETE |
| **DB queries** | `db/queries/leads.js`, `content.js`, `contacts.js`, `outreach.js`, `jobs.js`, `config.js` | COMPLETE |
| **API server** | `api/server.js` (Express, cors, rate limit, health check) | COMPLETE |
| **Auth middleware** | `api/middleware/auth.js` (JWT via Supabase Auth) | COMPLETE |
| **Tenant middleware** | `api/middleware/tenant.js` (RLS context) | COMPLETE |
| **Validation middleware** | `api/middleware/validate.js` | COMPLETE |
| **Webhook verification** | `api/middleware/webhookVerify.js` (Twilio + Calendly) | COMPLETE |
| **API routes** | leads, contacts, content, approvals, outreach, finance, crew, jobs, dashboard, config | COMPLETE |
| **Webhook handlers** | `api/webhooks/twilio.js` (SMS + voice), `api/webhooks/calendly.js` | COMPLETE |
| **Worker service** | `worker/index.js` (Express health, agent registry) | COMPLETE |
| **Scheduler** | `worker/scheduler/cron.js` (11 tenant-aware cron jobs) | COMPLETE |
| **Job processor** | `worker/jobs/processor.js` (poll + dispatch) | COMPLETE |
| **3 agents ported** | content-generation, image-generation, publisher | COMPLETE |
| **Integrations** | claude.js, gemini.js, twilio.js, buffer.js, email.js (stub), expo-push.js | COMPLETE |
| **Config system** | `config/defaults.js`, `config/presets/tree-service.js`, `config/presets/benefits-consulting.js` | COMPLETE |
| **Scripts** | `scripts/migrate.js`, `scripts/seed-tenant.js`, `scripts/health-check.js` | COMPLETE |

### Remaining setup (requires manual steps)

| Task | Action Required |
|------|----------------|
| **Create Supabase project** | Go to supabase.com → New Project → copy URL + keys to `.env` |
| **Run schema** | Copy `db/schema.sql` → paste in Supabase SQL Editor → Run |
| **Create exec_sql RPC** | Run the helper function in SQL Editor (see `scripts/migrate.js` for instructions) |
| **Seed tenants** | `node scripts/seed-tenant.js --name "A Kut Above" --slug a-kut-above --vertical tree_service --email patrick@akutabove.com` |
| **Seed WellMor** | `node scripts/seed-tenant.js --name "WellMor Benefits" --slug wellmor --vertical benefits_consulting --email morgan@wellmor.com` |
| **Create auth users** | In Supabase Auth dashboard, create users and set `app_metadata.tenant_id` |
| **Deploy API to Railway** | `railway up` with start command: `node api/server.js` |
| **Deploy Worker to Railway** | Second Railway service with start command: `node worker/index.js` |
| **Set Railway env vars** | Copy `.env` values to Railway environment |
| **Run health check** | `node scripts/health-check.js` |

---

## Key Architectural Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Single flat repo** — no Turborepo/NX | One developer. Workspace tooling adds overhead with no benefit at this scale. |
| 2 | **JavaScript first** — not TypeScript rewrite | WellMor is JS. Avoid blocking rewrite. Add types incrementally. |
| 3 | **Supabase table as job queue** — no Redis/Bull | ~100 jobs/day. Supabase polling is sufficient. Avoids Redis cost and complexity. |
| 4 | **n8n fully eliminated** — internal scheduler | Fixes duplicate scheduler problem. Single source of truth. |
| 5 | **AI keys platform-level** — not per-tenant | Simpler. Tenants don't need their own Claude/Gemini accounts. |
| 6 | **Extract, don't rebuild** — port working code | Both systems have production-tested logic. Keep it, add tenant_id. |
| 7 | **Two Railway services** — API + Worker | Clean separation. API handles requests, Worker runs agents. |
| 8 | **Config-driven behavior** — tenant_config table | Every tenant-specific value in DB, not code. Change behavior = update a row. |

---

## Open Questions (Across All Documents)

### High Priority (Decide before Phase 3B)

| # | Question | Decision |
|---|----------|----------|
| 1 | JS or TS for initial build? | **JS** — decided, faster, avoids rewrite |
| 2 | Single mobile app or per-tenant? | One binary, tenant at login |
| 3 | Portal hosting? | Railway (keep it together) |
| 4 | Need staging environment? | **No** — prod only for now |
| 5 | Image storage? | API filesystem → move to Supabase Storage later |

### Medium Priority (Can decide during Phase 3)

| # | Question | Default |
|---|----------|---------|
| 6 | Auto-retry failed agent jobs? | No — manual re-trigger via portal |
| 7 | Tenant config: key-value rows or single JSONB blob? | **Key-value rows** — decided |
| 8 | Webhook tenant routing for unknown callers? | **Phone number lookup** for Twilio — implemented |
| 9 | Keep image_generation as separate module from content_engine? | Yes — separate |
| 10 | Full audit log table in Phase 3? | No — defer to Phase 4 |

---

## Recommended Next Steps (Phase 3B)

```
Phase 3B: Content Pipeline (end-to-end)
  ├── Verify content-generation agent works with real Supabase data
  ├── Verify image-generation agent works (Gemini API)
  ├── Test approval flow: generate → approve → publish
  ├── Test publisher agent with Buffer integration
  ├── Port remaining format templates (2-8) into benefits-consulting preset
  └── Verify: both tenants can generate and publish content
```

---

## What's NOT in Scope for Phase 3

- Finance module (defer to Phase 4)
- Advertising/analytics agent (defer)
- Full audit log table (defer)
- Onboarding wizard (defer)
- TypeScript conversion (incremental)
- Staging environment (not needed yet)
- External monitoring/alerting (Railway sufficient)
- Custom domains per tenant (defer)
- Admin portal for platform management (defer)

---

## Files Produced

| File | Phase | Purpose |
|------|-------|---------|
| `docs/growth-os-phase1-audit.md` | 1 | Full audit |
| `docs/growth-os-architecture.md` | 2 | Architecture |
| `docs/data-model.md` | 2 | Schema design |
| `docs/module-catalog.md` | 2 | 17 modules |
| `docs/migration-plan.md` | 2 | Migration matrix |
| `docs/deployment-architecture.md` | 2 | Railway + Supabase |
| `docs/vertical-presets.md` | 2 | 2 presets |
| `docs/CHECKPOINT.md` | 2-3 | This file |
| `db/schema.sql` | 3A | Full database schema |
