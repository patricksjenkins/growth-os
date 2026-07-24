# Three-client regression inventory

**Established:** 2026-07-24

**Scope:** the three active client tenants. The platform tenant is tested as a
fourth administrative identity but is not counted as a client.

**Data handling:** tenant names, contacts, messages, document names, phone
numbers, financial amounts, and other customer-level values are intentionally
excluded. Tests use synthetic tenant UUIDs only.

This is a living release-blocker inventory. A route appearing here does not
prove it is safe; the associated positive and negative evidence must pass for
all applicable clients before activation.

| Capability | Existing route/runtime | Persistent dependencies | External dependency | Required regression behavior | Current evidence |
|---|---|---|---|---|---|
| Authentication and tenant resolution | `api/middleware/auth.js`, `tenant.js`, `admin.js` | Auth users, tenants, tenant_users | Supabase Auth | Valid users retain their tenant; missing/conflicting identity fails closed; logout/login and tenant switch cannot reuse stale state. | Shadow-compatible authoritative claim tests pass; production metadata audit is not enforcement-ready. |
| Tenant dashboard and summaries | `/api/tenant/dashboard-summary`, `/api/admin/dashboard-summary` | leads, jobs, attention_queue, agent_jobs, finance tables | None | Existing cards and counts remain available and never contain another tenant’s row-level content. | Static bounded-query and tripwire tests pass; authenticated three-tenant browser test pending. |
| Leads and pipeline | `/api/leads`, `/api/admin/pipeline`, `/api/tenant/pipeline` | leads, contacts, lead_tasks, activity_log | Apollo, Hunter, Serper where enabled | CRUD, status, owner action, and attribution remain tenant-bound and backward compatible. | Existing route/unit tests pass; full three-tenant E2E pending. |
| Public lead capture and referrals | `/api/leads/capture` | tenants, leads, referral_credits, tenant_config | Customer websites | Existing forms continue while enforcement is off; every referral must belong to the captured tenant. | Unconditional same-tenant lookup and migration 071 guard implemented; token rollout not activated. |
| SMS and messaging | `/webhooks/telnyx`, messaging workers | messages, contacts, leads, tenant integrations/config | Telnyx | Sender/recipient number resolves exactly one tenant; FGA identity never leaks to a client; retries remain idempotent. | Telnyx identity tests pass; signed strict-mode route tests added; live callback proof pending. |
| Voice and receptionist | `/webhooks/voice-receptionist/*` | voice_calls, leads, tenant config | Telnyx, Vapi; legacy Twilio routes | Existing routing remains unchanged while strict mode is off; strict mode requires verified callbacks and tenant-bound call identity. | Default compatibility preserved; legacy/mounted route inventory is blocking strict activation. |
| Email and deliverability | Resend routes/workers, Gmail connections | messages, email_events, suppressions, drip tables | Resend, Gmail | Tenant sender identity, suppression, bounce/complaint handling, and retries remain intact. | Existing identity/suppression tests pass; production lacks Resend signing secret. |
| Onboarding | `/api/onboarding`, onboarding workers | onboarding records/workflows, tenant config | Email and configured providers | Existing onboarding state and credentials remain readable; new workflow is additive and idempotent. | Legacy tests pass; authoritative new state machine and three-client E2E pending. |
| Finance and customer attribution | finance/customer routes and workers | finance_entries, customers, jobs, Stripe mapping | Stripe | Existing totals cannot change from code-only work; all reads are tenant-bound; reconciliation differences block authority. | Existing calculation tests pass; G14/G15 remain blocked. |
| Notifications and mobile deep links | push integration, mobile notification handler | notifications, user/device identity | Expo Push | Notification resolves the authorized tenant and record; stale tenant context and unknown types fail to safe detail. | Existing content route only; complete typed registry pending under G19. |
| Background agents and queues | scheduler, processor, agent registry | agent_jobs and domain tables | Multiple configured providers | Claim/retry is idempotent; agent context contains one tenant; disabled agents cannot write. | Conditional claim regression passes; atomic database lease and three-tenant agent-context tests pending. |
| Documents and files | `/api/documents` behind global and exact-tenant cohort flags; existing storage paths | documents, versions, chunks, links, events, grants, storage | Supabase Storage; no second cloud adapter is currently configured | No direct client writes; role/classification/grant reads remain tenant-bound; paths, parent links, search, and citations never cross tenant. | Read/search route, explicit projections, private storage policy, and database role/tenant negative tests implemented. Ingestion, scanning, signed retrieval, UI, and activation remain pending. |
| Scheduling and meetings | legacy Calendly webhook/meetings; new scheduling foundation | meetings, appointment workflows/events/policies | Calendly and calendar provider | Legacy bookings and meeting prep remain unchanged; shadow projection is idempotent; no outbound booking until authorized. | State machine and cross-tenant guards implemented; shadow adapter and provider credentials pending. |

## Required transition tests

Before any production activation, the release evidence must cover:

1. client A → logout → client B in the same browser profile;
2. client A cached query hydration after client B login;
3. direct URL navigation to a client A record while authenticated as client B;
4. mobile notification for a stale or different tenant;
5. background job carrying a mismatched tenant and entity ID;
6. webhook provider event claiming the wrong tenant identity;
7. storage and document search attempts using another tenant’s IDs or paths;
8. exports, finance views, messages, and search with two and three synthetic tenants;
9. service-role writes with deliberately mismatched parent and child tenants;
10. disabled feature flags, kill switches, rollback containment, and legacy API compatibility.
