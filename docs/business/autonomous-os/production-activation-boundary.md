# Autonomous OS production activation boundary

## Purpose

This document separates building and validating the Autonomous OS from activating autonomous behavior in production. Code availability is not authorization. A merged change, a green test suite, or an existing feature flag does not by itself permit production activation.

The default state is **no new production authority**.

## Boundary statement

Work may cross into production only when:

1. the change is classified,
2. every applicable G01–G20 gate is `Verified`,
3. the accountable human approves the exact activation,
4. the cohort, authority, duration, spend, and communication channels are bounded,
5. a tested kill switch and rollback path exist,
6. monitoring covers both system health and business harm,
7. and a post-activation review is scheduled.

Silence, prior deployment, an undocumented operator convention, or the absence of a failing test is not approval.

## Change classes

| Class | Examples | Production effect | Required authorization |
|---|---|---|---|
| A — Evidence only | Documentation, read-only analysis, local tests, static checks | None | Normal code review |
| B — Dormant implementation | Code behind a confirmed-off flag, tests, dashboards, non-executing schemas | No runtime authority if isolation is proven | Code review plus applicable safety gates |
| C — Operational configuration | Environment values, runtime roles, provider routing, queue concurrency, allowlists | Alters live behavior without changing code | Accountable owner approval and change record |
| D — Data or schedule mutation | Database migration, backfill, cron change, replay, cleanup, bulk correction | Changes persistent state or execution timing | Owner approval, backup/restore evidence, bounded runbook |
| E — External action | Email, SMS, voice, publishing, ad spend, payment, customer-facing content | Acts outside the system or creates cost/reputation risk | Explicit channel owner approval, consent/policy proof, cohort limit, kill switch |
| F — Authority expansion | Department Head activation, autonomous approval, budget authority, self-directed workflow creation | Delegates decisions previously held by a human | Executive approval after G18–G20 evidence and an observation phase |

If a change fits more than one class, the highest-risk class governs.

## Activities that do not authorize activation

The following work can prepare a release but cannot approve it:

- merging a pull request,
- adding or changing a feature flag,
- adding an environment variable,
- creating a migration,
- adding a cron entry,
- changing an agent prompt or model,
- adding a provider integration,
- displaying a KPI,
- recording successful job runs,
- or documenting a rollback command that has not been exercised.

## Hard stops

Activation is prohibited when any of the following applies:

- a relevant ledger item is `Blocked`,
- a service credential is known or suspected to be exposed,
- the database cannot be restored to a verified point,
- the change requires the unsafe migration path,
- the release artifact may contain local environment, signing, or data artifacts,
- the executing tenant or sender identity is ambiguous,
- an ingress verification setting fails open,
- more than one scheduler can enqueue the same work without a tested lock,
- an external action lacks consent, policy, rate, or spend controls,
- the outcome event cannot be distinguished from an attempt,
- the kill switch is untested or inaccessible to the on-call owner,
- or the rollback would destroy evidence needed for reconciliation.

## Approval packet

Every Class C–F activation must record:

| Field | Required content |
|---|---|
| Change | Exact commit, artifact digest, configuration delta, and affected runtime role |
| Purpose | Business outcome, current baseline, and falsifiable success threshold |
| Scope | Tenant cohort, channel, geography if relevant, volume, spend, and duration |
| Authority | Decisions the automation may make and explicit decisions it may not make |
| Dependencies | Applicable G01–G20 items and their evidence references |
| Safety | Authentication, consent, tenant scope, content policy, rate/spend caps, idempotency |
| Observability | Attempts, deliveries, failures, outcomes, latency, cost, exceptions, and owner alerts |
| Kill switch | Exact disable mechanism, propagation time, access owner, and last test |
| Rollback | Code/config/data/queue steps, backup point, and reconciliation plan |
| Decision | Named accountable approver, timestamp, expiry, and any conditions |
| Review | Observation window and scheduled go/no-go review |

No secret values or customer-level data belong in the packet.

## Activation stages

These lettered activation stages describe how any one capability crosses the production boundary. They are distinct from the numbered organizational roadmap phases below.

### A. Offline

Use fixtures, mocks, static checks, and isolated local execution. External side effects are disabled.

Exit evidence:

- safety and regression tests pass,
- negative paths are exercised,
- identity and tenant scope are explicit,
- cost and rate bounds are modeled,
- and the kill switch is testable.

### B. Shadow

Production inputs may be observed, but the new system cannot send, publish, charge, mutate customer state, or decide an approval. Outputs are compared with the existing path or human decision.

Exit evidence:

- a predefined sample and observation period are complete,
- false-positive and false-negative rates are reviewed,
- outcome events reconcile,
- and no unresolved high-severity exception remains.

### C. Recommend

The system can prepare a recommendation or draft. A human makes the consequential decision and performs or explicitly approves the external action.

Exit evidence:

- acceptance and rejection reasons are captured,
- quality is measured separately from volume,
- escalation and handoff SLAs are met,
- and the human override path works.

### D. Bounded execute

The system may act only inside the approved tenant cohort, channel, volume, spend, time window, and authority policy. Anything outside the envelope stops or escalates.

Exit evidence:

- system, safety, quality, and business thresholds hold for the full window,
- the kill switch and alert routing are verified,
- aggregate outcomes reconcile,
- and rollback/recovery evidence remains current.

### E. Expand or hold

Expansion is a new activation decision, not an automatic consequence of success. Reassess the cohort, limits, failure modes, business outcomes, and residual human work. Failed or ambiguous evidence results in hold, rollback, or a return to an earlier stage.

## Department Head boundary

A Department Head is not a renamed handler or a bundle of schedules. It is a governed decision role with:

- a clear mission and accountable human owner,
- bounded decision rights,
- trusted inputs and measurable outcomes,
- explicit handoff contracts,
- exception and escalation policy,
- budget and channel limits,
- audit history,
- a kill switch,
- and demonstrated reliability across an agreed observation period.

No Department Head may activate while outcome telemetry is unverified or while its required recovery and safety gates remain blocked. Cross-department authority requires separate approval for every new handoff or decision right.

The canonical organizational order is:

1. Reliability foundation
2. Revenue remediation, then Head of Revenue
3. Chief of Staff
4. Onboarding Head
5. Client Success Head
6. Finance & Data Governance Head
7. Marketing Head
8. Product & Engineering Head

These correspond to roadmap phases 0–7. Each phase remains dependency-gated as recorded in the implementation ledger. The sequence does not authorize automatic promotion from one phase to the next.

## Monitoring and automatic stop conditions

Every bounded activation must define numeric or categorical stop conditions before launch. At minimum, stop on:

- authentication, tenant-scope, consent, or policy verification failure;
- unexpected sender, channel, recipient class, or environment;
- duplicate or non-idempotent external action;
- rate or spend cap breach;
- unreconciled persistent write;
- queue backlog or error rate outside the approved envelope;
- material quality regression;
- missing outcome telemetry;
- kill-switch failure;
- or an incident classified above the approved risk tolerance.

Job volume is a diagnostic metric, not a success condition.

## Emergency containment

The on-call owner may always reduce authority without waiting for expansion approval:

1. disable the narrowest reliable execution flag or runtime role;
2. stop new enqueue or external dispatch;
3. preserve logs, queue state, configuration, and affected record identifiers;
4. rotate exposed credentials if relevant;
5. identify the bounded impact using aggregate counts;
6. reconcile in-flight and persistent writes;
7. communicate through the incident process;
8. resume only through a new approval decision.

Emergency containment must not use an unverified destructive rollback that removes audit evidence.

## Relationship to the ledger

[implementation-ledger.md](./implementation-ledger.md) is the source for G01–G20 readiness. [phase-0-baseline.md](./phase-0-baseline.md) records the audited starting point. This document governs whether completed implementation may affect production.

When these documents disagree, the more restrictive control applies until the accountable owner resolves the discrepancy.
