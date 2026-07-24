# Client-health intervention control (G12)

Migration `083_client_health_interventions.sql` adds an evidence-backed,
tenant-scoped intervention control plane. It is additive and does not change
the deployed heuristic scoring jobs, customer workflows, or communications.

## Safety posture

- Every tenant starts disabled with its kill switch engaged.
- The only execution modes are `shadow` and `supervised`.
- Enabling a control requires a same-tenant owner/admin-equivalent membership
  for `activated_by` and a non-empty structured activation-evidence object.
- Customer communications and provider actions are structurally fixed to
  `false`.
- Service-role callers must provide both an explicit feature-gate value of
  `true` and the exact current control revision.
- Direct inserts, updates, and deletes are denied, including to `service_role`.
- Signal and event evidence is immutable.
- All customer, signal, intervention, owner, and assignee references are
  checked against the exact tenant.
- Legacy `client_health_scores` rows are neither modified nor treated as
  intervention outcomes.

## Outcome semantics

An intervention begins with `outcome_state = unknown`. Assignment acceptance,
escalation, and action completion can move it only to `unproven`. Completing an
action is not proof that the client result improved.

Only `record_outcome` with a `client_outcome_receipt` can set `improved`,
`unchanged`, or `worsened`. The generated `outcome_healthy` value is true only
for an evidence-backed `improved` outcome. Heuristic signals cannot assert
`stable` and are always marked ineligible as outcome evidence.

## Controlled validation

Use synthetic identities only. Apply migrations through 083 to a disposable
PostgreSQL database, seed `test/sql/autonomous-os-tenant-negative.sql`, then
run:

```sh
psql -v ON_ERROR_STOP=1 -d autonomous_os_test \
  -f test/sql/client-health-interventions-negative.sql
```

The proof covers authenticated and direct-write denial, disabled gates,
cross-tenant customer and signal rejection, false-green containment, stale
revision rejection, premature outcome rejection, verified outcome recording,
immutable evidence, and the kill switch.

Do not use an active client as a test subject. No provider credential is
required for this migration or proof.

## Activation gate

Activation is a production change and is not authorized by implementation.
Before requesting consolidated approval:

1. Apply the migration and regression suite in staging.
2. Confirm exact tenant/customer identity and RLS negative tests.
3. Create an explicit control row for an approved test tenant in `shadow`
   mode, with activation evidence and the kill switch disengaged.
4. Pass the current control revision and explicit feature gate on every RPC.
5. Accumulate a supervised evidence period; do not infer historical maturity.
6. Review outcomes for evidence quality and false-green behavior.
7. Keep customer communications and provider actions disabled.

## Kill switch

Call `client_health_kill_switch_rpc` as `service_role` with the exact control
revision and a non-sensitive reason. The command disables the tenant, changes
its mode to `disabled`, engages the kill switch, increments the revision, and
returns only a reason digest. A tripped kill switch cannot be cleared by an
ordinary update.

## Rollback

Run:

```sh
psql -v ON_ERROR_STOP=1 -d autonomous_os_test \
  -f db/rollbacks/083_client_health_interventions_rollback.sql
```

The rollback disables all controls, engages every kill switch, removes command
and kill-switch RPCs, and reasserts direct-write denial. It deliberately keeps
signal snapshots, interventions, events, and outcome evidence for audit and
recovery.
