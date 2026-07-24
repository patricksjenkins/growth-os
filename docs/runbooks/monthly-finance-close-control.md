# Monthly finance-close control (G16)

Status: implemented as an additive, default-off shadow/supervised control plane.
It is not authorized for production use.

## Purpose and authority boundary

Migration 081 adds a durable monthly-close lifecycle without changing existing
finance calculations, `finance_entries`, provider behavior, or the deployed
`finance_period_locks` contract. The exact operating identity is:

`tenant_id + period_start (first day of month) + ISO-style currency`.

The terminal state is deliberately named `shadow_locked`. It records evidence
that the workflow passed its internal lock gate, while
`production_period_lock_applied` remains structurally false. It never inserts,
updates, or deletes `finance_period_locks`.

The pure planner at `core/finance/monthly-close-planner.js` performs no I/O and
always emits `p_feature_gate_enabled: false`. The database RPC also requires:

1. the database caller to be `service_role`;
2. an explicit true runtime feature gate;
3. an exact tenant control row enabled in `shadow` or `supervised` mode;
4. a disengaged tenant kill switch; and
5. both provider export and production period-lock controls to remain false.

No provider calls, customer messages, money movement, exports, or production
locks are performed by migration 081.

## State and evidence contract

The state path is:

`not_started → reconciling → review_ready → reviewer_approved → signed_off → exported → shadow_locked`

An exception moves the cycle to `exception_review`. Each exception creates a
durable resolution task with assignment, acceptance, due time, escalation, and
completion fields. Completing the last open exception task returns the cycle to
`reconciling`.

Every command:

- uses optimistic `expected_revision`;
- is serialized by exact tenant/period/currency identity;
- has a tenant-scoped idempotency key;
- stores caller and semantic fingerprints;
- emits an immutable event with structured evidence and a SHA-256 digest; and
- fails closed on missing identity, evidence, authority, or prerequisites.

`record_reconciliation` requires at least one distinct
`finance_attribution_records` ID. Every record must:

- belong to the exact tenant;
- use the exact currency;
- fall inside the exact month; and
- have `reconciliation_status = matched`.

Open exceptions or incomplete tasks block review readiness.

Reviewer approval requires a tenant human with finance/operator authority.
Signoff requires a different tenant human with owner authority. Export records
only an already-created artifact receipt. Shadow lock requires an owner decision
and records no legacy production lock.

## Safe validation order

Use synthetic fixtures only:

```sh
node --test \
  test/finance/monthly-close-planner.test.js \
  test/finance/monthly-close-migration.test.js
```

For the PostgreSQL proof, apply migrations through 081 to the disposable
harness, then run:

1. `test/sql/autonomous-os-tenant-negative.sql`
2. `test/sql/billing-attribution-negative.sql`
3. `test/sql/monthly-finance-close-negative.sql`

The database proof checks role denial, default-off behavior, direct-write
denial, cross-tenant evidence rejection, exception/task completion, stale
revision rejection, reviewer/signatory separation, shadow-only locking,
immutable evidence, kill-switch containment, and authenticated RLS isolation.

## Rollback

Run `db/rollbacks/081_monthly_finance_close_control_rollback.sql`.

Rollback engages every tenant kill switch, disables controls, drops both RPCs,
and revokes direct mutation privileges. It intentionally keeps all tables,
states, tasks, exceptions, and immutable events for audit and recovery. It
does not touch legacy finance data or production period locks.

## Activation gate

Do not enable a tenant in production until the consolidated approval packet
includes:

- successful migration apply/replay/rollback evidence;
- tenant-negative and released-shape upgrade results;
- proof that existing finance totals and APIs are unchanged;
- reviewer/signatory assignments and SLA ownership;
- a separately designed export adapter with receipt validation;
- a separately approved bridge to `finance_period_locks`; and
- exact rollback and kill-switch rehearsal evidence.

Until then, `provider_export_enabled`,
`production_period_lock_enabled`, and
`production_period_lock_applied` must remain false.
