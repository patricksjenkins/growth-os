# Client Success & Support Department Head — supervised operation

Migration 089 adds an inert, tenant-scoped Client Success & Support Department
Head control plane. It coordinates accepted evidence, goals, internal work,
owner decisions, exceptions, SLA escalation, and follow-through. It does not
send customer communications, call providers, modify customer/support records,
issue credits or refunds, or write to production workflows.

## Mission and outcome contract

The charter records a written mission plus maximum first-response and
resolution time, maximum SLA-breach rate, minimum CSAT, and maximum open
critical tickets. Accepted reports bind:

- an exact tenant and customer;
- an authoritative client-health snapshot;
- an optional intervention sourced from that same snapshot;
- an immutable canonical support snapshot recorded by the tenant's registered
  support-evidence adapter;
- an opaque, globally non-rebindable support-ledger source and digest copied
  from that snapshot;
- aggregate support metrics copied from that snapshot; and
- a structured, PII-free evidence manifest.

`service_health` measures observed support execution against the charter.
It can be `healthy` only when the canonical support snapshot is `verified`.
An `unverified` snapshot always forces `service_health = unverified`, regardless
of its source label or apparently favorable metrics. Report callers cannot
submit or override the support source, digest, observation time, or metrics.
`client_outcome_state` separately records observed customer effect. Support
metrics, work completion, and `action_completed` interventions cannot establish
client outcome. An outcome is healthy only when service quality is healthy and
either an observed eligible stable snapshot exists without an intervention, or
a separately recorded verified intervention outcome is `improved`.

## Authority boundary

Controls default to disabled with the kill switch engaged. Supervised operation
requires an explicit tenant control row with:

- `enabled = true`;
- `execution_mode = supervised_read_only`;
- `kill_switch_engaged = false`;
- an exact `registered_agent_id`;
- a distinct exact `registered_support_adapter_id`;
- a tenant owner activation and non-empty activation evidence; and
- every production, communication, provider, finance, and refund/credit
  authority remaining `false`.

RPC calls additionally require the `service_role` claim and an explicit
feature-gate argument. The application planner always emits that gate as
`false`; activation tooling must make the supervised choice explicitly.
Department Head identity must exactly equal the registered agent. Human owner
decisions require a current owner-class tenant membership. Decision items
cannot be assigned to an agent.

Canonical support snapshots are accepted only from the exact registered
support adapter using `support_evidence_adapter` authority. Structured reports
are accepted only from the exact registered Client Success Head using
`department_head` authority. A service-role session without those tenant-bound
identities is insufficient. Both identities are durable on their evidence
records and cannot be the same identity.

## Workflow contract

Items are durable goals, work, decisions, or exceptions. Supported agent work
is limited to analyzing client health, recommending an intervention, and
verifying support evidence. Goals track client goals; exceptions raise internal
attention; decisions request an owner decision.

The lifecycle is:

`assigned → accepted → in_progress → completed`

Any non-completed state can be escalated after its SLA; an owner may escalate
earlier. Every transition requires the expected revision, structured evidence,
and a unique idempotency key. Exact retries replay; semantic changes conflict.
Events are append-only, and item identity is immutable.

Completion only stores a completion evidence digest. It never changes the
accepted report or its client outcome.

## Safe activation procedure

1. Apply migration 089 in a non-production database after migration 083.
2. Run the planner/static tests and the PostgreSQL negative proof.
3. Insert a control row as a database operator with the kill switch engaged.
4. Register distinct tenant-specific supervised Head and support-adapter
   identities plus owner activation evidence.
5. Only in a controlled shadow environment, set supervised read-only mode and
   disengage the initial kill switch. The guard makes later kill engagement
   irreversible for that row.
6. Register an owner-approved charter.
7. Have the registered adapter record immutable support snapshots. Mark them
   `verified` only after reconciliation to the authoritative support ledger.
8. Have the registered Head accept reports by canonical support snapshot ID;
   never pass support aggregates through the report path.
9. Review false-green, cross-tenant, stale-revision, owner-decision, and
   provider/communication denial evidence before any production proposal.

Migration 089 does not authorize production activation. Production write or
customer communication authority would require a separate implementation,
review, evidence gate, and consolidated approval.

## Kill and rollback

Call `client_success_head_kill_switch_rpc(tenant_id, reason_code)` as the
service role. It disables the head, engages the one-way kill switch, and stores
only a digest of the reason.

The rollback at
`db/rollbacks/089_client_success_department_head_supervised_rollback.sql`
disables every tenant control, removes all mutation RPCs and write triggers,
and retains controls, canonical support snapshots, charters, reports, items,
and events for audit. Verify that all controls are disabled and that retained
row counts match the pre-rollback evidence inventory.
