# Growth OS — Migration Plan

**Version:** 1.0 — Phase 2 Blueprint
**Date:** 2026-04-09
**Status:** DESIGN — No code changes

---

## 1. Migration Philosophy

### Extract, Don't Rebuild

Both legacy systems have **working production code**. The goal is to extract and reorganize — not rewrite from scratch.

**Rules:**
1. If it works, keep the logic. Change the wiring, not the algorithm.
2. Port the best implementation of each feature (AKA or WellMor, whichever is stronger).
3. Make tenant-aware by adding `tenant_id` parameters, not by forking code.
4. Convert hardcoded values to config lookups — same logic, different data source.
5. Legacy systems stay running until Growth OS is validated per-tenant.

### What "migration" means

```
Legacy code → Extract core logic → Add tenant_id parameter → Wire to new config system → Test → Deploy
```

NOT:
```
Legacy code → Read it → Write new code from scratch → Hope it works the same
```

---

## 2. Phased Migration Approach

### Phase 3A: Foundation (Week 1-2)

**Goal:** Scaffold the repo, create the database, deploy empty services.

| Task | Details |
|------|---------|
| Create `/growth-os` repo | Flat structure per architecture doc |
| Set up new Supabase project | Fresh instance, no legacy data |
| Run schema migrations | All tables from data-model.md |
| Create RLS policies | All business tables |
| Deploy API skeleton to Railway | Health check + auth middleware |
| Deploy Worker skeleton to Railway | Scheduler + job processor (no agents yet) |
| Set up env vars | Platform-level keys |
| Seed tenants | 2 rows: A Kut Above, WellMor |
| Seed vertical presets | Config + modules for each tenant |
| Test tenant resolution | API can resolve tenant from JWT |

**Validation:** `GET /health` returns 200 from both API and Worker. Tenant config loads correctly.

---

### Phase 3B: Core Modules (Week 2-3)

**Goal:** Port the foundation modules that both tenants need.

**Order matters — each module depends on the previous:**

1. **Lead Capture** — Port AKA lead CRUD routes + WellMor companies logic. Both tenants need leads.
2. **Content Engine** — Port WellMor content-agent.js. Extract format templates to tenant config.
3. **Image Generation** — Port WellMor image-agent.js. Already uses Gemini.
4. **Approval Queue** — Port WellMor approval-queue-agent.js + API endpoints.
5. **Publishing** — Port WellMor publisher-agent.js + buffer-publisher.js.
6. **Digest** — Port WellMor chief-of-staff-agent.js.

**Why this order:** Content pipeline (generate → approve → publish) is the most actively used flow in both systems. Get this working end-to-end first.

**Validation:** Generate content for WellMor tenant, approve via API, publish to Buffer. Same for AKA with different config.

---

### Phase 3C: Communication Modules (Week 3-4)

**Goal:** Port SMS and email automation.

1. **Speed-to-Lead** — Port AKA SpeedToLeadAgent.ts. Add tenant phone lookup.
2. **Follow-Up** — Port AKA FollowUpAgent.ts. Templates from tenant config.
3. **Missed Call** — Port AKA MissedCallAgent.ts. Twilio webhook with tenant routing.
4. **Review Request** — Port AKA ReviewRequestAgent.ts.
5. **Referral Request** — Port AKA ReferralRequestAgent.ts.
6. **Outreach Drip** — Port AKA OutreachDripAgent.ts. This is the most complex agent.

**Why this order:** Simple agents first (speed-to-lead is ~100 lines of core logic), complex last (outreach drip is 7 stages with bounce handling).

**Validation:** Test SMS sending for AKA tenant. Verify WellMor tenant doesn't trigger SMS agents (modules disabled).

---

### Phase 3D: Intelligence Modules (Week 4-5)

1. **Prospecting** — Merge AKA and WellMor prospecting agents. AKA uses Apollo, WellMor uses Serper + Claude.
2. **Lead Scoring** — Port WellMor scoring-agent.js. Only enabled for benefits_consulting.
3. **Enrichment** — Port WellMor enrichment-agent.js.
4. **Meeting Prep** — Port WellMor meeting-prep-agent.js.
5. **Reply Classification** — Port WellMor reply-classification-agent.js.

**Validation:** Run prospecting for both tenants with different configs. Verify different contact types discovered.

---

### Phase 3E: Frontend (Week 5-6)

1. **Mobile App** — Merge WellMor and AKA mobile apps. Tenant login, config-driven UI.
2. **Portal** — Port AKA portal with tenant context. Add WellMor-specific views.

**Validation:** Login as AKA user → see tree service UI. Login as WellMor user → see benefits UI.

---

### Phase 3F: Data Migration (Week 6)

1. Export AKA data from old Supabase → import to Growth OS with tenant_id
2. Export WellMor data from old Supabase → import to Growth OS with tenant_id
3. Verify data integrity
4. Switch DNS/endpoints to Growth OS
5. Monitor for 1 week
6. Decommission legacy systems

**Validation:** Both tenants operational on Growth OS. Legacy systems idle.

---

## 3. Sequencing Dependencies

```
Foundation (3A)
  │
  ├── Lead Capture
  │     ├── Speed-to-Lead
  │     ├── Follow-Up
  │     ├── Review Request
  │     ├── Referral Request
  │     ├── Lead Scoring
  │     └── Missed Call
  │
  ├── Content Engine
  │     ├── Image Generation
  │     ├── Approval Queue
  │     │     └── Publishing
  │     └── Mobile Approvals
  │
  ├── Prospecting
  │     └── Outreach Drip
  │
  └── Digest (last — reads all other data)
```

---

## 4. Rollback Considerations

### Strategy: Parallel Running

Both legacy systems continue operating during the entire migration. Growth OS is tested alongside them, not as a replacement.

| Risk | Rollback Plan |
|------|--------------|
| Growth OS API fails | Legacy API is still running at old URL |
| Data migration corrupts records | Growth OS uses new Supabase instance — old data untouched |
| Agent sends duplicate SMS | Idempotency keys prevent duplicates. If both systems run same agent, the second one is a no-op. |
| Mobile app broken | App Store build points to Growth OS API. Rollback = submit new build pointing to legacy API. TestFlight makes this fast. |
| Portal broken | Static deploy. Rollback = redeploy previous version. |

### Kill switch

Each legacy system can be reactivated by:
1. Re-enabling its Railway service (if paused)
2. Pointing mobile app back to legacy URL
3. Re-enabling n8n workflows

**Data sync concern:** If Growth OS has been running for days, new data exists only in the new database. A full rollback requires manual data reconciliation. This is acceptable risk — the alternative (real-time sync between old and new) is far more complex than it's worth for 2 tenants.

---

## 5. Risk Areas

| Risk | Severity | Mitigation |
|------|----------|------------|
| SMS duplication during parallel run | High | Idempotency keys. Disable SMS agents in legacy before enabling in Growth OS. |
| Content published twice | Medium | Disable publisher-agent in legacy. Enable in Growth OS only. |
| Email drip restart from stage 0 | High | Migrate outreach_contacts.drip_stage to outreach_campaigns.current_step. Verify before enabling agent. |
| Mobile app pointing to wrong API | Medium | Use feature flag or config to switch API URL in app. |
| Config values missed during extraction | Medium | Create config audit checklist. Test each agent with real config before enabling. |
| Sharp/image processing differences | Low | Image-agent is identical code, just moved. Test image output visually. |

---

## 6. Migration Matrix

### Old Repo → New Location

| Old Path | New Location | Action |
|----------|-------------|--------|
| `a-kut-above-api/src/routes/leads.ts` | `api/routes/leads.js` | Port, add tenant middleware |
| `a-kut-above-api/src/routes/content.ts` | `api/routes/content.js` | Port, merge with WellMor endpoints |
| `a-kut-above-api/src/routes/finance.ts` | `api/routes/finance.js` | Port (Phase 4) |
| `a-kut-above-api/src/routes/outreach.ts` | `api/routes/outreach.js` | Port, add tenant middleware |
| `a-kut-above-api/src/routes/webhooks.ts` | `api/webhooks/` | Port, add signature verification |
| `a-kut-above-api/src/services/smsService.ts` | `integrations/twilio.js` | Generalize, tenant phone lookup |
| `a-kut-above-api/src/services/aiService.ts` | `integrations/claude.js` | Merge with WellMor claude.js |
| `a-kut-above-api/src/services/socialPublisher.ts` | `integrations/buffer.js` | Merge with WellMor buffer-publisher.js |
| `a-kut-above-api/src/services/emailService.ts` | `integrations/email.js` | Generalize |
| `a-kut-above-agents/src/agents/SpeedToLeadAgent.ts` | `worker/agents/speed-to-lead.js` | Add tenant_id, config lookup |
| `a-kut-above-agents/src/agents/FollowUpAgent.ts` | `worker/agents/follow-up.js` | Add tenant_id, config lookup |
| `a-kut-above-agents/src/agents/ReviewRequestAgent.ts` | `worker/agents/review-request.js` | Add tenant_id, config lookup |
| `a-kut-above-agents/src/agents/ReferralRequestAgent.ts` | `worker/agents/referral-request.js` | Add tenant_id, config lookup |
| `a-kut-above-agents/src/agents/OutreachDripAgent.ts` | `worker/agents/outreach-drip.js` | Add tenant_id, config lookup |
| `a-kut-above-agents/src/agents/ProspectingAgent.ts` | `worker/agents/prospecting.js` | Merge with WellMor, add tenant_id |
| `a-kut-above-agents/src/agents/ContentGenerationAgent.ts` | `worker/agents/content-generation.js` | Merge with WellMor content-agent |
| `a-kut-above-agents/src/agents/MissedCallAgent.ts` | `worker/agents/missed-call.js` | Add tenant_id |
| `a-kut-above-agents/src/scheduler/cronJobs.ts` | `worker/scheduler/cron.js` | Rebuild as tenant-aware scheduler |
| `a-kut-above-portal/src/` | `portal/src/` | Add tenant context |
| `a-kut-above-app/app/` | `mobile/src/` | Merge with WellMor mobile |
| `a-kut-above-workflows/n8n/` | Eliminated | Replaced by worker scheduler |
| `a-kut-above-workflows/supabase/migrations/` | `db/migrations/` | Merge schemas |
| `wellmor/agents/server.js` | `api/server.js` | Split: routes → api, agents → worker |
| `wellmor/agents/content-agent.js` | `worker/agents/content-generation.js` | Merge with AKA, extract config |
| `wellmor/agents/image-agent.js` | `worker/agents/image-generation.js` | Port directly, add tenant_id |
| `wellmor/agents/format-templates.js` | `config/presets/benefits-consulting.js` | Move to tenant config |
| `wellmor/agents/scoring-agent.js` | `worker/agents/scoring.js` | Port, add tenant_id |
| `wellmor/agents/prospecting-agent.js` | `worker/agents/prospecting.js` | Merge with AKA version |
| `wellmor/agents/enrichment-agent.js` | `worker/agents/enrichment.js` | Port, add tenant_id |
| `wellmor/agents/outreach-agent.js` | `worker/agents/outreach-drip.js` | Merge with AKA version |
| `wellmor/agents/reply-classification-agent.js` | `worker/agents/reply-classification.js` | Port, add tenant_id |
| `wellmor/agents/meeting-prep-agent.js` | `worker/agents/meeting-prep.js` | Port, add tenant_id |
| `wellmor/agents/social-content-agent.js` | `worker/agents/content-generation.js` | Merge |
| `wellmor/agents/advertising-agent.js` | `worker/agents/advertising.js` | Port (Phase 4) |
| `wellmor/agents/approval-queue-agent.js` | `worker/agents/approval-queue.js` | Port, add tenant_id |
| `wellmor/agents/publisher-agent.js` | `worker/agents/publisher.js` | Port, add tenant_id |
| `wellmor/agents/campaign-orchestrator-agent.js` | `worker/agents/campaign-orchestrator.js` | Port, add tenant_id |
| `wellmor/agents/chief-of-staff-agent.js` | `worker/agents/digest.js` | Port, add tenant_id |
| `wellmor/agents/clients-agent.js` | Eliminated | Merged into lead CRUD |
| `wellmor/agents/notification-push.js` | `integrations/expo-push.js` | Generalize |
| `wellmor/agents/notification-service.js` | `integrations/email.js` | Merge with AKA email |
| `wellmor/agents/buffer-publisher.js` | `integrations/buffer.js` | Merge with AKA publisher |
| `wellmor/agents/shared/supabase.js` | `db/client.js` + `db/queries/` | Split into client + typed queries |
| `wellmor/agents/shared/claude.js` | `integrations/claude.js` | Merge with AKA aiService |
| `wellmor/agents/shared/openai.js` | `integrations/openai.js` | Port (research queries) |
| `wellmor/agents/shared/logger.js` | `core/logger.js` | Port directly |
| `wellmor/mobile-app/src/` | `mobile/src/` | Merge with AKA mobile |
| `wellmor/n8n-workflows/` | Eliminated | Replaced by worker scheduler |
| `wellmor/supabase/` | `db/migrations/` | Merge schemas |
| `wellmor/benefitsiq/` | Eliminated | Unused, replaced by portal |

---

### Old Tables → New Schema

| Old Table | Old System | New Table | Changes |
|-----------|-----------|-----------|---------|
| `leads` | AKA | `leads` | + tenant_id, + RLS |
| `companies` | WellMor | `leads` | Merge (company_name field) |
| `clients` | WellMor | `leads` | Merge (was duplicate of companies) |
| `contacts` | WellMor | `contacts` | + tenant_id, + contact_type |
| `outreach_contacts` | AKA | `contacts` | Merge, contact_type='referral_partner' |
| `content_drafts` | AKA | `content_drafts` | + tenant_id, standardize columns |
| `content_queue` | WellMor | `content_drafts` | Merge into content_drafts |
| `social_posts` | WellMor | `content_drafts` | Merge (was duplicate tracking) |
| `outreach_campaigns` | WellMor | `outreach_campaigns` | + tenant_id |
| `emails` | WellMor | `messages` | Merge, channel='email' |
| `automation_logs` | AKA | `agent_activity_log` | Standardize, + tenant_id |
| `agent_activity_log` | WellMor | `agent_activity_log` | + tenant_id |
| `job_photos` | AKA | `job_photos` | + tenant_id |
| `meetings` | WellMor | `meetings` | + tenant_id |
| `meeting_briefings` | WellMor | `meetings` | Merge (briefing as JSONB column) |
| `marketing_performance` | WellMor | `marketing_performance` | + tenant_id |
| `income_entries` | AKA | `finance_entries` | entry_type='income' |
| `expense_entries` | AKA | `finance_entries` | entry_type='expense' |
| `crew_members` | AKA | `crew_members` | + tenant_id |
| `system_config` | WellMor | `tenant_config` + `system_config` | Split platform vs tenant |
| `pending_tasks` | WellMor | `agent_jobs` | Standardize |
| `users` | AKA | `tenant_users` | + tenant_id, link to auth.users |

---

### Old Env Vars → New Location

| Old Variable | System | New Location | Notes |
|-------------|--------|-------------|-------|
| `SUPABASE_URL` | Both | Platform env var | New Supabase project |
| `SUPABASE_SERVICE_KEY` | Both | Platform env var | New project key |
| `SUPABASE_ANON_KEY` | Both | Platform env var | New project key |
| `ANTHROPIC_API_KEY` | Both | Platform env var | Shared across tenants |
| `OPENAI_API_KEY` | Both | Platform env var | Shared |
| `GOOGLE_API_KEY` | WellMor | Platform env var | Shared |
| `GEMINI_IMAGE_MODEL` | WellMor | `system_config` or env var | Shared |
| `SERPER_API_KEY` | Both | Platform env var | Shared |
| `APOLLO_API_KEY` | WellMor | Platform env var or `tenant_integrations` | Shared for now |
| `TWILIO_ACCOUNT_SID` | AKA | `tenant_integrations.twilio.credentials` | Per-tenant |
| `TWILIO_AUTH_TOKEN` | AKA | `tenant_integrations.twilio.credentials` | Per-tenant |
| `TWILIO_PHONE_NUMBER` | AKA | `tenant_integrations.twilio.config.phone` | Per-tenant |
| `BUFFER_API_KEY` | Both | `tenant_integrations.buffer.credentials` | Per-tenant |
| `BUFFER_CHANNEL_LINKEDIN` | Both | `tenant_integrations.buffer.config.channels` | Per-tenant |
| `BUFFER_CHANNEL_INSTAGRAM` | Both | `tenant_integrations.buffer.config.channels` | Per-tenant |
| `BUSINESS_PHONE` | AKA | `tenant_config.phone` | Per-tenant |
| `BUSINESS_EMAIL` | AKA | `tenant_config.email` | Per-tenant |
| `BUSINESS_NAME` | AKA | `tenant_config.business_name` | Per-tenant |
| `GOOGLE_REVIEW_URL` | AKA | `tenant_config.review_url` | Per-tenant |
| `SMTP_HOST` | AKA | `tenant_integrations.smtp.credentials` | Per-tenant |
| `SMTP_PORT` | AKA | `tenant_integrations.smtp.config` | Per-tenant |
| `SMTP_USER` | AKA | `tenant_integrations.smtp.credentials` | Per-tenant |
| `SMTP_PASS` | AKA | `tenant_integrations.smtp.credentials` | Per-tenant |
| `SMTP_FROM` | AKA | `tenant_integrations.smtp.config` | Per-tenant |
| `AGENT_SECRET` | WellMor | Eliminated | Replaced by JWT auth |
| `TUNNEL_URL` | WellMor | Eliminated | Railway handles public URLs |
| `AIRTABLE_API_KEY` | WellMor | Eliminated | Not used in Growth OS |
| `HUNTER_API_KEY` | AKA | Platform env var | Email verification |
| `N8N_WEBHOOK_URL` | Both | Eliminated | n8n replaced by worker scheduler |
| `PORT` | Both | Platform env var | Railway assigns |

---

### Old Agents → New Modules/Workers

| Old Agent | System | New Worker | Module |
|-----------|--------|-----------|--------|
| SpeedToLeadAgent | AKA | `worker/agents/speed-to-lead.js` | `speed_to_lead` |
| FollowUpAgent | AKA | `worker/agents/follow-up.js` | `follow_up` |
| ReviewRequestAgent | AKA | `worker/agents/review-request.js` | `review_request` |
| ReferralRequestAgent | AKA | `worker/agents/referral-request.js` | `referral_request` |
| OutreachDripAgent | AKA | `worker/agents/outreach-drip.js` | `outreach_drip` |
| ProspectingAgent | AKA | `worker/agents/prospecting.js` | `prospecting` |
| EmailVerificationAgent | AKA | `worker/agents/enrichment.js` | `prospecting` |
| ContactEnrichmentAgent | AKA | `worker/agents/enrichment.js` | `prospecting` |
| ContentGenerationAgent | AKA | `worker/agents/content-generation.js` | `content_engine` |
| MissedCallAgent | AKA | `worker/agents/missed-call.js` | `missed_call` |
| prospecting-agent | WellMor | `worker/agents/prospecting.js` | `prospecting` |
| enrichment-agent | WellMor | `worker/agents/enrichment.js` | `prospecting` |
| scoring-agent | WellMor | `worker/agents/scoring.js` | `lead_scoring` |
| outreach-agent | WellMor | `worker/agents/outreach-drip.js` | `outreach_drip` |
| reply-classification-agent | WellMor | `worker/agents/reply-classification.js` | `outreach_drip` |
| meeting-prep-agent | WellMor | `worker/agents/meeting-prep.js` | `lead_capture` |
| content-agent | WellMor | `worker/agents/content-generation.js` | `content_engine` |
| social-content-agent | WellMor | `worker/agents/content-generation.js` | `content_engine` |
| image-agent | WellMor | `worker/agents/image-generation.js` | `image_generation` |
| approval-queue-agent | WellMor | `worker/agents/approval-queue.js` | `approval_queue` |
| publisher-agent | WellMor | `worker/agents/publisher.js` | `publishing` |
| campaign-orchestrator-agent | WellMor | `worker/agents/campaign-orchestrator.js` | `content_engine` |
| chief-of-staff-agent | WellMor | `worker/agents/digest.js` | `digest` |
| advertising-agent | WellMor | `worker/agents/advertising.js` | Future |
| clients-agent | WellMor | Eliminated | Merged into lead CRUD |
| schedule-agent | WellMor | Eliminated | Merged into scheduler |
| distribution-agent | WellMor | Eliminated | Merged into publisher |
| notification-push | WellMor | `integrations/expo-push.js` | Core utility |
| notification-service | WellMor | `integrations/email.js` | Core utility |
| buffer-publisher | WellMor | `integrations/buffer.js` | Core utility |

---

## 7. What Gets Reused vs Deprecated

### Reused from A Kut Above

- Lead CRUD and pipeline logic (best implementation)
- Speed-to-lead SMS pattern
- Follow-up sequence engine
- Review/referral request agents
- Outreach drip engine (7-stage, most mature)
- Portal UI components and pages
- Mobile app structure (Expo Router, cleaner than WellMor)
- Finance tracking logic
- Twilio SMS integration
- Supabase Auth integration

### Reused from WellMor

- Image generation pipeline (Gemini + Sharp — unique to WellMor)
- Content format templates (8 formats — more sophisticated)
- Approval queue workflow (production-tested with Morgan)
- Chief of Staff / digest agent (more comprehensive)
- Scoring agent (6-dimension AI scoring)
- Meeting prep agent (8-section briefings)
- Reply classification (sophisticated Claude-based)
- Prospecting via web search + enrichment
- Push notification system
- Campaign orchestrator pattern

### Deprecated (NOT migrated)

| Item | System | Reason |
|------|--------|--------|
| `benefitsiq/` | WellMor | Unused Next.js dashboard, replaced by portal |
| `clients-agent.js` | WellMor | Duplicate of lead management |
| `schedule-agent.js` | WellMor | Replaced by worker scheduler |
| `distribution-agent.js` | WellMor | Merged into publisher |
| All `.backup.*` files | WellMor | Dead code (~5K LOC) |
| n8n workflows (all) | Both | Replaced by worker scheduler |
| Cloudflare tunnel config | WellMor | Railway handles public URLs |
| Mac Mini infrastructure scripts | WellMor | Deploying to Railway, not local |
| Hardcoded auth (owner/Westwood1) | WellMor | Replaced by Supabase Auth |
| `AGENT_SECRET` auth | WellMor | Replaced by JWT |
| OpenAI image generation | WellMor | Replaced by Gemini |
| Airtable integration | WellMor | Never fully used |

---

## 8. Open Questions

| # | Question | Impact | Default |
|---|----------|--------|---------|
| 1 | Migrate data first or code first? | Chicken-and-egg | Code first (empty DB), then migrate data |
| 2 | Run agents in both systems during transition? | Duplicate actions risk | Disable agent in legacy before enabling in Growth OS, one module at a time |
| 3 | How to handle in-flight outreach campaigns? | Active drip sequences | Migrate with current step number. Agent picks up where it left off. |
| 4 | Keep both Supabase projects long-term? | Cost ($25/mo each) | Decommission legacy projects after 30 days of stable Growth OS |
| 5 | TypeScript or JavaScript? | Migration speed vs safety | JavaScript for Phase 3. Add TypeScript incrementally in Phase 4. |
