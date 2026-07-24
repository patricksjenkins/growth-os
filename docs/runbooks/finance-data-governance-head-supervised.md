# Supervised Finance & Data Governance Head

Migration 090 adds an evidence-only Finance & Data Governance Department Head.
It reads canonical integer attribution from migration 079 and monthly-close
state from migration 081 without mutating either source.

## Mission and KPIs

The tenant control requires a written mission and measurable contracts for:

- Reconciliation match rate.
- Monthly-close SLA.
- Exception-resolution SLA.
- Data-quality pass rate.
- Evidence completeness.
- Tenant-isolation gate pass rate.

## Financial truth

Accepted reports pin exact tenant, month, currency, close cycle, attribution
record IDs, and data-governance evidence. Revenue, cost, and margin are computed
inside PostgreSQL from canonical integer records.

The supplied attribution IDs must exactly equal the entire canonical
tenant-period-currency set, and that set must match both the close cycle's
authoritative reconciliation record count and recorded manifest. Missing,
extra, duplicate, ambiguous, or mismatched records fail closed.

`execution_health` is deliberately separate from `financial_truth_state`. A
successful agent run remains `unverified` unless every attribution record is
matched, the exact close cycle is `shadow_locked`, and data-governance evidence
is verified. Never present execution success as reconciled finance truth.

## Supervised authority

Only the exact registered Head identifier with `department_head` authority can
invoke commands. Controls start disabled with the kill switch engaged and can
run only in shadow or supervised read-only mode.

Production writes, money movement, charge/refund, provider dispatch, pricing,
period locking, export, and customer communications are structurally false.
Payloads attempting those actions fail closed.

## Work contracts

Goals, work, decisions, and exceptions are durable tenant-scoped cases. Work
is explicitly assigned to the registered Head identity at creation. Acceptance,
escalation, completion, and outcome recording must use that stored assignee
identity even if the tenant later registers a different Head. Work requires
acceptance, SLA, escalation, completion evidence, and an evidence-backed
outcome. Goals support evidence-backed achieved/not-achieved completion;
decisions support approved/rejected completion; exceptions support
evidence-backed resolution.

Every command takes a shared lock on its tenant control row for the full
transaction. Disable and kill-switch updates take an exclusive row lock, so
containment waits for a command already admitted to commit and no admitted
command can finish after containment commits.

Metadata is intentionally minimal and case-sensitive:

- report metadata: exactly non-negative integer `controls_tested` and
  `exceptions`;
- goal contract: exactly an opaque `measure`;
- work contract: exactly 1–20 opaque `acceptance` codes;
- decision contract: exactly an opaque `decision_scope`;
- exception contract: exactly an opaque `resolution`;
- command evidence: exactly `source_type`, `source_id`, `observed_at`, and an
  optional SHA-256 `evidence_digest`.

Nested or mixed-case aliases are unsupported. Sensitive keys are normalized
recursively before rejection so casing or punctuation cannot bypass the
authority boundary. Every command also uses optimistic revision and
tenant-scoped idempotency; events and report evidence are append-only.

## Activation and rollback

Keep production disabled until canonical reconciliation and close proofs,
tenant-negative tests, a real evidence period, migration replay, and rollback
all pass. This migration does not authorize production activation.

The kill-switch RPC stores only a SHA-256 reason digest. Rollback engages
containment, removes both RPC write paths, and preserves reports, attribution
links, cases, and immutable events.
