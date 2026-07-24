# Autonomous OS Phase 0 baseline

**Snapshot date:** 2026-07-24

**Audited source baseline:** `1dbf92b`

**Scope:** repository structure, local tests, configuration, migrations, deployment shape, recovery controls, and aggregate operating evidence

**Excluded:** production writes, live deployment changes, database migrations, secret validation, customer-level records, and autonomy activation

## Executive conclusion

The repository contains substantial automation machinery, but machinery is not the same as a safely autonomous company. The root regression suite is green and the agent registry is internally consistent. However, migration safety, credential hygiene, image-build isolation, environment validation, release recovery, and outcome evidence are not strong enough to support broader production autonomy.

The canonical operating-roadmap Phase 0 is **Reliability foundation**: define outcome contracts; split execution, result, and outcome; deduplicate attention; validate tenant configuration; and audit safety enforcement. Its success criterion is two consecutive weeks with no undetected zero-output condition and a diagnosis, owner, SLA, and verification for every critical incident.

Repository containment and reproducibility are prerequisites to crossing the production boundary during or after that phase. Phase 0 does not authorize new schedules, agent prompts, Department Heads, customer communications, database changes, or feature activation.

## Audited inventory

| Surface | Aggregate evidence | Interpretation |
|---|---:|---|
| Registered worker handlers | 63 | Broad machinery exists; registration does not establish autonomy or effectiveness. |
| Handler files | 63 | Registry and implementation counts align. |
| Cron entries | 63 | Scheduling breadth creates operational and duplicate-execution risk. |
| Unique scheduled handler names | 51 | Twelve registered handlers are event-driven or on demand. |
| API route modules | 45 | Large application surface with centralized runtime coupling. |
| Webhook modules | 4 | External event ingestion exists but needs fail-closed verification. |
| Integration modules | 20 | Provider breadth increases configuration and recovery obligations. |
| Migration SQL files | 68 | The migration path is not yet deterministic or safely replayable. |
| Root test files | 44 | Useful regression coverage, but not full live-system validation. |
| Root tests | 341 passed, 0 failed | Strong local signal at the audited commit; not a deployment guarantee. |
| Jobs observed over 30 days | 8,732 | High activity volume. |
| Replies observed | 1 | Activity has not translated into a demonstrated engagement engine. |
| Meetings observed | 0 | No verified meeting outcome in the measured period. |
| Content decisions observed | 15 posted, 15 rejected | A review loop exists, but the sample is too small to establish autonomous quality. |

## What is currently reliable

- The audited Git baseline was clean and aligned with its upstream source.
- All 63 discovered handler files were registered.
- The root test command completed with 341 passes and no failures.
- Safety, outreach, content, reconciliation, tenant-scope, communications, and operations behavior have meaningful unit or static-regression coverage.
- Autonomous outreach is tenant-gated rather than globally enabled.
- AI observability defaults on, allowing evidence collection before enforcement.
- Several workflows preserve configuration snapshots or a local restoration path.

These are useful controls. They do not prove live provider compatibility, database equivalence, deploy topology, webhook behavior, business outcomes, or recoverability.

## Phase 0 blockers

### Credential containment

One tracked utility contains a literal service-role credential. Its value must never appear in documentation, logs, CI output, or issues. The credential must be treated as compromised until rotation or revocation is independently confirmed. Automated secret scanning is a release gate, not a substitute for rotation.

### Migration safety

The current migration command:

- discovers all SQL files by filename,
- includes a destructive rollback in the forward directory,
- has no immutable applied-migration ledger,
- splits procedural SQL on semicolons,
- has no per-migration transaction boundary,
- can reduce statement failures to warnings,
- and can still report overall completion.

No repository migration command is approved for production use until the forward chain is quarantined, ledgered, transactional, and restore-tested.

### Build-context isolation

The container build copies the repository context without a committed ignore policy. Ignored local environment files, dependency trees, build output, signing metadata, or data artifacts can therefore enter a local image context or layer. A build-context denylist and image-content verification are required.

### Schema reproducibility

Static extraction found 20 table definitions in the base schema and 106 table names created across forward migrations, leaving 86 migration-created names absent from the base schema. The repository cannot currently demonstrate a faithful fresh database build.

### Runtime topology

The HTTP process also starts the scheduler and queue processor. Scheduler and processor controls default on unless explicitly disabled. The deprecated worker entry point imports the API server, and the local development command starts both entry points. This can create port collisions, duplicate scheduling, or competing processors.

### Configuration contract

Static analysis identified approximately 150 environment-variable names in use. The example manifest documents 55, with 119 used names absent from it; overlap between aliases means the figures are not a simple subtraction. Production configuration does not yet fail fast against a single typed, per-service contract. CORS also falls back to allowing all origins when its allowlist is absent.

### Recovery and release provenance

Git history provides code-level reversal, but the repository has no release tags, verified database restore drill, current schema snapshot tied to a release, queue-drain procedure, customer-data reconciliation procedure, or documented one-path service rollback. External platform history is not an in-repository recovery plan.

### Outcome evidence

The observed 30-day aggregate shows 8,732 jobs, one reply, and no meetings. This is evidence of execution volume, not business autonomy. Until attribution, funnel definitions, denominator quality, delivery state, and conversion events are reconciled, run counts must not be used as a maturity score.

## Phase 0 control posture

| Control domain | Current posture | Phase 0 requirement |
|---|---|---|
| Secrets | Blocked | Rotate or revoke exposed credentials; remove tracked literals; enforce scanning. |
| Migrations | Blocked | Deterministic forward-only chain, ledger, locks, transactions, verified restore. |
| Container build | Blocked | Exclude local secrets, signing material, data, dependencies, and build output. |
| Schema | Blocked | Versioned schema snapshot and fresh-restore equivalence test. |
| CI | Partial | Root tests exist locally; repository enforcement and secret scanning are being added. |
| Runtime topology | Blocked | One scheduler authority, explicit processors, API-only replicas, safe local command. |
| Configuration | Blocked | Typed manifest, explicit defaults, required-by-feature validation, fail-closed production. |
| Recovery | Blocked | Tagged releases, backup evidence, restore drill, queue/data recovery runbooks. |
| Autonomy governance | Blocked | Approval boundary, measurable entry/exit gates, kill switches, named accountable owner. |
| Business outcomes | Unproven | Reconciled outcome telemetry and threshold history before autonomy expansion. |

## Required repository-safety evidence

The canonical Reliability foundation gate above must be met from operating evidence. In addition, no production activation may proceed unless every applicable repository-safety item below is attached to the implementation ledger:

1. Credential rotation or revocation is confirmed without recording the replacement value.
2. Secret scanning passes on the current tree and relevant Git history.
3. A container-content test proves excluded artifacts are absent.
4. The production migration path is forward-only, transactional, locked, ledgered, and fails closed.
5. A non-production database can be created from the release artifacts and compared to the expected schema.
6. A backup can be restored in a timed drill with documented recovery objectives.
7. Runtime roles are explicit and duplicate scheduler execution is tested.
8. Production configuration validation rejects missing or ambiguous critical settings.
9. Root and in-scope tenant validation run in CI on the supported Node version.
10. A tagged release can be rolled back without silently reversing database changes.
11. Outcome events are reconciled end to end and distinguish attempts, deliveries, replies, qualified replies, meetings, and revenue.
12. The production activation checklist has an accountable approver, bounded cohort, kill switch, observation window, and rollback trigger.

## Non-goals

Phase 0 does not:

- activate a Department Head,
- increase agent authority,
- change an agent prompt or model,
- change a schedule,
- send a message,
- run a migration,
- deploy a release,
- change a customer-facing page,
- infer maturity from code count,
- or certify the current production database from static repository evidence.

The detailed work sequence and evidence gates are maintained in [implementation-ledger.md](./implementation-ledger.md). The authorization boundary is defined in [production-activation-boundary.md](./production-activation-boundary.md).

## Implementation-branch checkpoint

The audited figures above remain the immutable starting baseline. On
`codex/fga-autonomous-os`, the unsafe migration executor and forward-path
rollback discovery have been removed, build-context exclusions and secret
scanning have been added, and migrations 067–071 now have an ephemeral
PostgreSQL apply/replay and tenant-negative CI harness. The local root suite
passes 418 tests as of this checkpoint.

These changes move repository safety forward but do not clear the production
gate. The database harness must pass in CI, the full historical schema still
needs reproducible fresh-build coverage, credential rotation remains an
approval item, and no migration has been applied.

The active-client surface is tracked in
[three-client-regression-inventory.md](./three-client-regression-inventory.md).
