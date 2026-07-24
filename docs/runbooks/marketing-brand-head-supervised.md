# Marketing & Brand Department Head — supervised operation

Migration 091 adds a genuine, tenant-scoped Marketing & Brand Department Head.
It accepts immutable evidence and coordinates goals, work, decisions, and
exceptions. It is not a publisher, messaging worker, ad buyer, or causal
attribution engine.

## Mission and evidence contract

The Head protects brand quality and turns content evidence into accountable
follow-through without claiming delivery, audience response, conversion, or
causality that the evidence does not establish. Each tenant must register the
exact Head identity and define measurable KPIs for quality acceptance, delivery
receipt completeness, audience/reply/conversion observation, brand exception
SLA, and cohort size.

Accepted reports reference exact tenant-scoped records from migration 082:
artifact versions, calibrated quality evaluations, and delivery receipts. The
report stores content completion, derived quality, derived delivery, brand
compliance, and descriptive business observation as separate states.

Audience, reply, and conversion counts require an evidence digest. Counts must
fit the configured cohort limit. The only supported attribution model is
`descriptive_association_only`, and `causal_claim` is structurally false.

All caller metadata is minimized before it reaches durable evidence:

- evidence contains only `source_type`, `source_id`, `observed_at`, and an
  optional `evidence_digest`;
- the report contains exactly `content_quality.accepted`,
  `delivery_receipts.delivered`, `audience.observed`, `replies.observed`,
  `conversions.observed`, `brand_compliance_exceptions.open`, and `cohort.size`;
- a goal contract contains only `measure`, work only an `acceptance` array,
  decision only `decision_scope`, and exception only `resolution`.

Unknown keys fail closed. Safety-sensitive key matching lowercases names and
removes punctuation before comparison, so variants such as `Customer-Email`
and `Provider.Dispatch` cannot bypass the deny list. Metadata values are opaque
identifiers rather than free-form customer or credential content.

## Activation gate

The control row defaults to disabled with the kill switch engaged. Before
supervised use, an authorized tenant owner must provide non-empty activation
evidence, register the Head ID, keep every authority field false, and select
`shadow` or `supervised_read_only`. The caller must also supply the exact
registered ID, `department_head` authority tier, service-role authentication,
and an explicit feature gate.

This migration never enables:

- public or private content publication;
- provider dispatch or customer contact;
- paid advertising or spend;
- pricing or legal-policy changes;
- production writes to content or provider systems.

## Operational lifecycle

Reports can create durable goal, work, decision, and exception cases. Work is
assigned to the exact stored registered Head actor, with explicit acceptance,
an SLA deadline, overdue-only escalation, evidence-backed completion, and a
separately recorded outcome. Goals complete with a verified outcome, decisions
complete as approved or rejected, and exceptions resolve with a verified
outcome. Every command is revision checked, idempotent, and appended to
immutable audit history. Direct table mutation is denied even to
`service_role`.

## Containment and rollback

Call `marketing_brand_head_kill_switch_rpc` with a reason to atomically disable
the tenant Head. Only the reason digest is retained. The kill switch cannot be
reversed by updating the control row. A command holds a shared lock on its
tenant control row through its event append, so a concurrent disable waits for
the already-authorized command to finish and every later command fails closed.

The rollback disables all control rows and removes both RPC mutation paths. It
does not drop reports, source links, cases, or audit events. Re-enabling after
rollback requires a later reviewed migration; production activation remains a
separate approval-gated action.

For disposable PostgreSQL validation, run
`test/sql/marketing-brand-head-negative.sql`, then
`test/sql/marketing-brand-head-concurrency.sql`, before rollback 091.
