# Onboarding and Implementation Department Head — supervised foundation

Migration `088_onboarding_department_head_supervised.sql` adds an additive,
tenant-scoped executive control plane for onboarding and implementation. It
does not replace closed-won handoffs or the authoritative onboarding workflow,
and it grants no production, provisioning, provider, customer-communication,
or financial authority.

## Mission and KPIs

The written mission is to deliver acknowledged implementations with evidence
and proven customer outcomes. Each tenant control must define measurable
contracts for:

- closed-won to handoff acceptance time;
- acceptance to onboarding acknowledgment time;
- evidence-complete handoff rate;
- implementation completion rate;
- onboarding SLA compliance rate;
- exception resolution rate;
- time to first value;
- customer-outcome receipt rate.

The Head accepts only `handoff`, `implementation`, and `customer_outcome`
reports. Report acceptance is tied by composite foreign keys and runtime checks
to the exact source tenant, client tenant, closed-won handoff, and onboarding
workflow. Handoff reports require accepted handoffs. Implementation and
customer-outcome reports require acknowledged workflows. Customer-outcome
reports additionally require a completed handoff, an authoritative outcome
receipt, and a complete verified KPI set.

## Honest outcome semantics

Execution health and customer outcome are separate fields. Completing
implementation work sets the case outcome to `unproven`; it cannot claim that
the customer achieved an outcome. A separate evidence-backed
`record_customer_outcome` transition is required to record `achieved` or
`not_achieved`.

Reports, events, accepted evidence, and their digests are immutable. Durable
cases cover goals, work, decisions, and exceptions with assignment,
acceptance, SLA, escalation, completion, and customer-outcome receipts.

### Canonical customer-outcome receipt

A caller-provided outcome, `source_type`, or evidence label is never sufficient
to verify customer success. An `achieved` or `not_achieved` report or case
transition must reference an immutable
`onboarding_customer_outcome_receipts` record.

Only an authenticated same-tenant owner/admin-equivalent human can create that
receipt. The authenticated JWT subject must match a live tenant membership and
cannot match the registered Onboarding Head. The receipt is bound to the exact:

- source tenant;
- client tenant;
- authoritative completed and acknowledged onboarding workflow;
- measured outcome state and code;
- opaque evidence reference and SHA-256 digest;
- human verifier identity and role.

The database recomputes the receipt digest on insert, rejects identity or
workflow mismatches, and makes the receipt immutable. The Head, another agent,
service role, or system actor cannot execute the receipt RPC. Goal/work outcome
transitions persist a foreign key to the canonical receipt and its workflow.

### Minimized evidence

Head reports and events accept exactly three evidence fields:
`source_type`, `source_id`, and `observed_at`. Source identities must be opaque
machine references. Recursive JSON keys are normalized case-insensitively
before validation; contact, credential, message, and raw-payload keys such as
`CustomerEmail`, `customer_email`, or casing variants are rejected. KPI,
report-body, contract, and activation JSON also pass the recursive
sensitive-key guard.

## Authority and tenant boundary

Controls default to disabled with the kill switch engaged. The only enabled
modes are `shadow` and `supervised_read_only`. Activation requires a current
same-tenant owner/admin-equivalent membership and structured activation
evidence. Every service RPC also requires:

- the exact tenant;
- an enabled feature gate;
- the current control revision;
- a permitted actor type and authority tier;
- the exact registered Onboarding Head identity for Head actions;
- a non-empty evidence object;
- a stable idempotency key and request fingerprint.

The database permanently constrains these authorities to `false`:

- operational writes outside the supervised ledger;
- provisioning;
- provider actions;
- customer communications;
- production changes;
- money movement.

Authenticated users can read only their exact tenant through RLS. Direct
table writes are denied to authenticated and service roles. Mutation is
available only through the narrowly scoped, service-role RPCs. Owner decisions
require a current same-tenant human owner; the Head cannot approve its own
recommendation.

## Validation

Run the focused planner and structural tests:

```sh
node --test \
  test/onboarding/onboarding-department-head-planner.test.js \
  test/onboarding/onboarding-department-head-migration.test.js
```

After the standard synthetic bootstrap, migrations 067–088, and the base
tenant-negative proof, run:

```sh
psql "$SYNTHETIC_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f test/sql/onboarding-department-head-negative.sql
```

The PostgreSQL proof covers cross-tenant activation, restricted-role RPC
denial, disabled gates, exact Head identity, prohibited authority, authoritative
handoff/workflow linkage, false customer outcomes, evidence requirements,
revision checks, idempotent replay, assignment and acceptance, completion
versus outcome, independent owner verification, Head/service self-certification
denial, exact receipt tenant/workflow binding, `synthetic-achieved` spoofing,
recursive `CustomerEmail` rejection, agent self-approval, exact-tenant RLS,
immutable evidence and receipts, and kill-switch containment. Use only
synthetic data in a disposable database.

## Activation gate

Migration 088 does not authorize production activation. Before inclusion in
the consolidated production approval:

1. Apply and replay migration 088 in staging.
2. Pass the full regression and two-/three-tenant negative suites.
3. Reconcile authoritative handoff and workflow projections against their
   sources.
4. Register an owner-reviewed KPI and authority contract.
5. Operate in `shadow` or `supervised_read_only` mode with every external
   authority false.
6. Accumulate the required real evidence period without inventing history.
7. Review false-green, SLA, escalation, customer-outcome, audit, and rollback
   evidence.

No client is an experimental test subject. Activation remains disabled if
tenant identity, evidence, authority, or outcome verification is inconclusive.

## Kill switch and rollback

`onboarding_head_kill_switch_rpc` requires `service_role`, the exact control
revision, and a non-sensitive reason. It disables the tenant, engages the kill
switch, increments the revision, and cannot be reversed by an ordinary update.

Rollback:

```sh
psql -v ON_ERROR_STOP=1 -d autonomous_os_test \
  -f db/rollbacks/088_onboarding_department_head_supervised_rollback.sql
```

Rollback first contains all controls, then removes every command RPC and
revokes direct writes. Accepted reports, goals, work, decisions, exceptions,
canonical customer-outcome receipts, events, and evidence remain available for
investigation and audit.
