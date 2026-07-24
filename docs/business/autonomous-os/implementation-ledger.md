# Autonomous OS implementation ledger

**Ledger version:** 1

**Established:** 2026-07-24

**Scope:** canonical G01–G20 capability gaps and their implementation gates

## Status vocabulary

| Status | Meaning |
|---|---|
| `Blocked` | A release or activation must not cross this gap. |
| `Planned` | Scope is defined; implementation evidence is not yet accepted. |
| `In progress` | Work exists on the implementation branch but the exit gate is not complete. |
| `Partial` | Some control exists, but it does not satisfy the full gate. |
| `Verified` | Evidence has been reviewed against the exit gate. |
| `Deferred` | Explicitly outside the current release and unable to block a narrower approved release. |

`Verified` requires evidence. A merged file, a passing unit test, or an operator assertion alone is not sufficient when the gate requires live reconciliation, delivery proof, or business outcomes.

The title, department, severity, maturity level, and priority below are canonical to the command-center capability-gap model. `Implementation` is the delivery state maintained by this ledger; it does not replace those canonical fields.

## Gap ledger

| ID | Canonical capability gap | Department | Canonical status | Implementation | Dependencies | Exit gate |
|---|---|---|---|---|---|---|
| G01 | No canonical owner decision queue | Executive | Critical · L-B · P0 | `In progress` | Canonical item schema; action protocol; reconciliation; SLA; target registry | All owner-decision surfaces read one uncapped durable queue; dismiss remains distinct from action; completion transactionally verifies the target record and records evidence. |
| G02 | Chief of Staff layer is absent | Executive | Critical · L-A · P3 | `Deferred` | Two trustworthy department reports; goals; authority; G01; accepted handoffs | At least two supervised department loops produce accepted reports; a goal and dependency registry exists; the Chief of Staff is shadow-tested before any decision authority. |
| G03 | Green health does not mean business health | Platform Ops | Critical · L-B · P0 | `In progress` | Per-agent outcome contracts; quality evaluation; freshness; business KPIs | Health separately reports execution, output, quality, delivery, and outcome; a completed no-op cannot appear business-healthy. |
| G04 | Recovered incidents remain unresolved attention | Platform Ops | High · L-B · P0 | `In progress` | Shared incident ID; recovery transaction; reconciliation worker | Incident recovery closes or supersedes linked attention transactionally; a short-window reconciler proves no recovered incident remains falsely open. |
| G05 | Closed-won does not start onboarding | Sales | Critical · L-B · P1 | `Planned` | Authoritative customer identity; idempotent handoff; onboarding state machine | A closed-won event creates one acknowledged onboarding workflow with owner, due dates, evidence, retries, SLA, and exception routing. |
| G06 | Sales call state conflicts with orchestration output | Sales | High · L-B · P1 | `In progress` | Call-event schema; calendar linkage; preparation and follow-up state | Call requirements persist at record level and link event, preparation, owner, due date, completion, follow-up, and outcome in one authoritative workflow. |
| G07 | Task page is operational but has no managed work | Executive | Medium · L-C · P2 | `Planned` | Handoff/SLA model; producers; owners; outcome linkage; G01 decision | A recorded architecture decision either makes G01 the work ledger or connects tasks without duplication; generated tasks have owner, priority, SLA, completion, and outcome evidence. |
| G08 | Content pipeline completes without publication | Marketing | High · L-B · P2 | `Partial` | Delivery receipt; stuck-state SLO; retry; external reconciliation | Completed no-op is a distinct state; every claimed publication has an external delivery ID; stuck work retries or enters the owner queue with evidence. |
| G09 | Content quality depends on heavy owner review | Marketing | High · L-C · P2 | `Partial` | Rubric; evaluation store; sampled calibration; prompt/version lineage | Quality evaluations are versioned and calibrated to owner decisions; routine-class rejection remains below the approved threshold for the required observation window. |
| G10 | Marketing lacks outcome attribution | Marketing | High · L-A · P3 | `Deferred` | Identity lineage; campaign taxonomy; revenue attribution | Content and campaigns carry durable lineage through delivery, engagement, qualified lead, win, and reconciled revenue; attribution is tested before optimization authority. |
| G11 | Onboarding is a tracker, not an owned workflow | Onboarding | Critical · L-B · P1 | `Planned` | Authoritative identity; G05; workflow state machine; SLA | One authoritative seven-day workflow owns prerequisites, automated steps, human moments, blocks, SLAs, acceptance, and exception routing. |
| G12 | Client health is heuristic without intervention proof | Client Success | High · L-B · P2 | `Partial` | Backtesting; action plan; SLA; outcome labels | Health signals are backtested; every material risk creates an owned intervention plan; retention outcomes measure whether intervention changed the result. |
| G13 | No monthly client value-report workflow | Client Success | High · L-A · P3 | `Deferred` | Client identity; accepted attribution; approved value metrics | A recurring report instance is generated from evidence, reviewed, delivered, and acknowledged; delivery and client response are durable states. |
| G14 | Finance totals are not reconciled | Finance | Critical · L-B · P0 | `In progress` | Canonical ledger rules; period controls; reconciliation; sign-off | All finance surfaces use one calculation contract; source totals reconcile for a closed test period; differences block sign-off and route with evidence. |
| G15 | Paying-client and margin truth is incomplete | Finance | Critical · L-B · P1 | `Blocked` | Authoritative billing mapping; customer master; entity attribution | Billing, customer identity, revenue, cost, and margin reconcile to authoritative sources; unattributed entries cannot produce authoritative client metrics. |
| G16 | Monthly close lacks an operating state machine | Finance | High · L-C · P2 | `Planned` | G14; close model; audit trail | Each period tracks reconciliations, exceptions, evidence, reviewer, lock, export, and sign-off; incomplete work cannot appear closed. |
| G17 | Admin role contract disagrees across tiers | Administration | High · L-B · P0 | `In progress` | Shared roles; metadata hygiene; positive and negative tests | One role/authority contract drives web, mobile, routing, and backend authorization; cross-tier integration tests prove matching allow and deny decisions. |
| G18 | Cross-tenant isolation is not runtime-proven | Administration | High · L-B · P0 | `In progress` | Seeded isolated tenants; CI identities; negative assertions; cache-transition tests | Automated two-tenant release tests prove isolation for direct URLs, APIs, cache transitions, exports, files, messages, search, notifications, and mobile. |
| G19 | Mobile notifications mostly do not deep-link | Mobile | High · L-B · P1 | `Planned` | Typed notification registry; tenant context; route tests | Every actionable type resolves to the authorized tenant, screen, record, and action; unknown types fall back to evidence detail; route tests cover allow and deny paths. |
| G20 | Owner next-action fields are strong but outcomes are weak | Sales | Medium · L-C · P2 | `Partial` | Action completion evidence; forecasting; call/reply handoffs | Strong owner/action/due invariants remain; completion is recorded; conversion cohorts show whether actions improve replies, calls, qualified opportunities, and wins. |

## Dependency map

```text
G03 -> G04 -> G01 -> G02
             ├-> G07
             └-> accepted department handoffs

G20 -> G06 -> G05 -> G11 -> G12 -> G13

G08 -> G09 -> G10

G14 -> G15 -> G16

G17 -> G18 -> G19
```

Cross-cutting release-safety work in the Phase 0 baseline—credential containment, migration safety, build isolation, configuration validation, recovery, and required CI—remains a prerequisite for any production activation even though it is not renumbered into the canonical G01–G20 product-capability set.

## Current implementation evidence

| Evidence | Supports | Result |
|---|---|---|
| Root regression run on implementation branch | Cross-cutting safety | 495 passed, 0 failed locally on 2026-07-24; the repository CI gate also performs secret scanning and real PostgreSQL migration execution. |
| Handler registry inventory | G03 | 63 handler files and registrations; 51 uniquely scheduled names and 12 event/on-demand handlers. Machinery breadth does not prove outcomes. |
| Aggregate operating evidence | G03, G08–G10, G20 | 8,732 jobs, one reply, no meetings; 15 content items posted and 15 rejected. Outcome readiness remains unproven. |
| Static repository and migration audit | Cross-cutting safety | Migration, schema, configuration, container, and recovery blockers remain open as documented in the baseline. |
| Safety workflow on this branch | Cross-cutting safety | Adds clean install, root tests, and `npm run security:secrets`; verification requires the script, a passing workflow, and required branch protection. |
| Production activation boundary on this branch | G02 and all Head activations | Defines change classes, approval, evidence, rollback, and observation requirements; operational adoption is still required. |
| `067_agent_job_outcomes.sql` plus recorder contract | G03 | Separates execution, result, output, quality, delivery, and business outcome. Application recording is best-effort and the migration remains unapplied. |
| `068_work_items_control_plane.sql`, `072_work_item_atomic_rpcs.sql`, `073_work_items_read_compatibility.sql`, pure planners, and gated read API | G01, G07, G17, G18 | Adds a tenant-bound, append-only ledger, atomic service-role command boundary, optimistic transitions, deployed owner-role compatibility, deterministic grants, and an explicit-projection API restricted by a global flag plus exact tenant cohort. Writes and production migration remain disabled. |
| `069_document_control.sql`, access contract, and gated read/search API | Document-management requirement, G17, G18 | Adds private canonical metadata, immutable versions, search chunks/citations, links, audit events, explicit grants, classification-aware RLS, safe storage-path parsing, and an explicit-projection metadata/search API. Supabase Storage is the confirmed current cloud provider. Upload, malware scan, ingestion worker, signed retrieval, web/mobile UI, and production migration remain unimplemented. |
| `070_scheduling_control.sql` plus workflow helpers | G06 | Adds a tenant-guarded scheduling state machine, policies, events, window validation, owner binding, and collision-resistant idempotency. It is not connected to Calendly or any outbound calendar write. |
| `071_referral_tenant_integrity.sql` plus unconditional route validation | G18, G20 | Blocks new cross-tenant referral relationships at both API and database boundaries. Migration remains unapplied. |
| `074_incident_recovery_reconciliation.sql`, typed planner, and gated Operations Guardian adapter | G04, G01, G03 | Resolves recovery citations against tenant-bound authoritative `agent_jobs` or prospecting `leads` evidence, then atomically links canonical work, verifies it, recovers the incident, supersedes its attention row, and appends immutable evidence. The Guardian uses this path only when three write flags and three exact tenant cohorts agree; failure cannot fall back to a direct recovery update. The required short-window production observation remains unproven. |
| `075_work_item_identity_hardening.sql` plus command-boundary validation | G01, G17, G18 | Requires current tenant-owner membership for human-created work and human events, tenant membership for new human assignment, and tenant ownership for new supported entity links. It fails closed for new agent/service identities until registries exist, preserves updates to unchanged legacy fields, and forces service mutations through atomic RPCs. HTTP commands reject direct relationships and assignment spoofing; RPC results require a complete typed contract and explicit projection. |
| Ephemeral PostgreSQL CI harness | G01, G04, G17, G18 and cross-cutting safety | Applies and reapplies migrations 067–075, proves atomic command denial/replay/conflict/cross-tenant behavior, exercises role/classification document RLS and incident reconciliation, upgrades a simulated released migration-068 database through 075 without freezing legacy rows, and executes containment rollbacks on an evidence-empty upgrade database. CI execution for migrations 074–075 is pending branch push. |
| Webhook route manifest/readiness and strict handler gates | Cross-cutting safety | Every mounted provider remains a strict-mode requirement even if labelled legacy or retired; strict mode fails closed while default-off compatibility preserves production behavior. |
| Shared action authority contract | G01, G02, G17, G18 | Tenant, role, identity type, and action are evaluated in one fail-closed contract for the new work and document surfaces. Every production-boundary action is represented as approval-required and can never be granted by this evaluator. Existing route-by-route convergence remains in progress. |
| Canonical integer finance calculation contract | G14, G15, G16 | Calculates exact minor-unit totals, preserves authority and attribution as separate dimensions, reports missing evidence as unknown, and blocks close/signoff for any difference or incomplete evidence. It is deliberately shadow-only and not yet wired to client-visible totals. |

## Canonical activation roadmap

| Phase | Exact title | Entry dependency | Exit gate |
|---:|---|---|---|
| 0 | Reliability foundation | First; no new production behavior required for a read-only reliability role | Two consecutive weeks with no undetected zero-output condition; every critical incident has diagnosis, owner, SLA, and verification. |
| 1 | Revenue remediation, then Head of Revenue | Phase 0 success; canonical funnel; department reports store | Repeatable qualified-reply and demo signal; the Head reports KPIs, assigns accepted work, and escalates exceptions. |
| 2 | Chief of Staff | Revenue Head has delivered decision-ready reports for two weeks | The owner receives only decisions, relationship moments, commitments, and high-risk escalations. |
| 3 | Onboarding Head | At least one accepted new-customer handoff; checklist and acceptance contract | No step stalls silently; every human action is scheduled with context. |
| 4 | Client Success Head | Stable identity/routing; support knowledge base; SLA policy | SLA is measured; value evidence is delivered; a risk plan is accepted before owner escalation. |
| 5 | Finance & Data Governance Head | Reconciled metric contracts and close checklist | Every executive metric reconciles to source; monthly close becomes review rather than repair. |
| 6 | Marketing Head | Routine content rejection below 10% for eight weeks; case-study evidence; revenue attribution | Content delivers accepted proof and attributable opportunities. |
| 7 | Product & Engineering Head | Structured feedback, release evidence, rollback, and incident contracts | The Head coordinates planning and QA; deploy and migration authority remains human. |

The roadmap is sequentially constrained, not calendar-promised. A later phase does not activate because code exists or time has elapsed.

## Gate-change protocol

Every status change must add:

1. the commit, artifact, or runbook reference;
2. the validation command or review record;
3. the environment and date;
4. aggregate results with no secrets or customer-level data;
5. the accountable reviewer;
6. known residual risk;
7. rollback or containment evidence.

Statuses must not be advanced by editing this table alone. If evidence later regresses, change the status back to `Blocked` or `Partial` and record the reason in the implementing pull request or incident record.
