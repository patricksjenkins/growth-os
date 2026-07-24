# Reliability, Security, and Agent Operations Department Head

Migration `085_reliability_department_head.sql` adds a supervised executive
control plane. It does not replace the system monitor, Operations Guardian,
canonical work items, incident reconciliation, or outcome records. Instead, it
accepts structured evidence from those systems and coordinates durable goals,
work, recommendations, and exceptions.

## Mission and KPIs

Each tenant control contains the written mission and contracts for:

- Incident detection-to-acknowledgment time.
- Tenant-isolation release-gate pass rate.
- Verified recovery rate.
- Agent business-outcome rate.
- Audit-evidence completeness.
- SLA compliance rate.

Reports are accepted only for `reliability`, `security`, or
`agent_operations`. Execution health and outcome health are separate. A
successful job cannot produce a healthy outcome status unless every included
KPI is verified and carries an evidence reference.

## Authority boundary

The Head can analyze, recommend, record supervised work, and escalate. The
following fields are structurally fixed to `false`:

- Operational write authority.
- Production change authority.
- Provider action authority.
- Customer communication authority.
- Money movement authority.

The default mode is `disabled` with the kill switch engaged. The only active
modes are `shadow` and `supervised_readonly`. Enabled activation requires a
same-tenant owner/admin-equivalent member and structured activation evidence.
The configured `department_head_id` is checked on every agent report or
command.

Recommendations are not decisions. Only a same-tenant, owner-authorized human
can approve or reject a recommendation. Agents cannot self-approve or claim
owner authority.

## Work and outcome semantics

Supervised work uses explicit owner, assignee, assignment time, acceptance,
SLA, escalation, completion receipt, and business-outcome receipt fields.

Completing work sets the outcome to `unproven`. Only a later
`business_outcome_receipt` can record `achieved` or `not_achieved`. Reports,
case events, and their evidence are immutable.

## Validation

Use synthetic data in a disposable PostgreSQL database:

```sh
psql -v ON_ERROR_STOP=1 -d autonomous_os_test \
  -f test/sql/reliability-department-head-negative.sql
```

The proof covers activation identity, prohibited authority, authenticated and
direct-write denial, disabled gates, Head identity mismatch, false-green
rejection, cross-tenant report linkage, stale revisions, assignment acceptance,
completion/outcome separation, agent self-approval denial, tenant RLS,
immutable evidence, and kill-switch containment.

No provider credentials are required. Never use an active client as a test
subject.

## Activation gate

Implementation does not authorize production activation. Before consolidated
approval:

1. Apply migration 085 and the full regression suite in staging.
2. Verify the exact-tenant RLS and service RPC negative suite.
3. Insert an approved tenant control in `shadow` mode with the documented
   mission, KPI and authority contracts.
4. Keep every operational authority field false.
5. Accumulate the required supervised evidence period.
6. Review false-green, SLA, escalation, outcome, and audit evidence.
7. Include activation and rollback in the consolidated production packet.

## Kill switch and rollback

`reliability_head_kill_switch_rpc` requires `service_role`, the exact control
revision, and a non-sensitive reason. It disables the tenant, engages the kill
switch, and increments the revision. An engaged switch cannot be cleared by an
ordinary update.

Rollback:

```sh
psql -v ON_ERROR_STOP=1 -d autonomous_os_test \
  -f db/rollbacks/085_reliability_department_head_rollback.sql
```

The rollback disables controls, engages kill switches, removes all RPC command
paths, and preserves accepted reports, goals, work, decisions, exceptions,
events, and evidence.
