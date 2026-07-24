# Supervised Chief of Staff control

Migration 087 provides a default-off, read-only coordination foundation. It
stores accepted department reporting contracts and reports, then allows a
supervised Chief of Staff to organize company goals, dependencies, capacity
conflicts, decisions requiring authority, exceptions, and follow-through.

It cannot send messages, call providers, publish, charge, refund, transfer
funds, or mutate production business records.

## Dependency gate

A coordination cycle opens only when all of these match exactly:

1. Tenant.
2. Reporting-period start and end.
3. An accepted Reliability, Security, and Agent Operations report.
4. An accepted Revenue and Sales report.
5. An accepted versioned report contract behind each report.

The cycle pins both report IDs. Every later command repeats and revalidates
those IDs and the reporting window. Missing, draft, rejected, stale-window, or
cross-tenant evidence fails closed.

## Authority and evidence

- RPCs require `service_role`, a true caller feature gate, and an enabled exact
  tenant control.
- Controls can run only in `shadow` or `supervised`, remain read-only, and start
  disabled with the kill switch engaged.
- Contract and report acceptance requires a human tenant owner.
- Human actors and human follow-through owners must belong to the exact tenant.
- Commands use optimistic cycle or entity revisions and tenant-scoped
  idempotency keys.
- Events are append-only. Evidence requires source identity and observation
  time; production-bound payload keys are rejected recursively.

## Honest maturity

This is supervised coordination infrastructure, not production authority.
Accepted synthetic or staging reports prove the contract machinery, not
historical department performance. Production authority remains gated on the
real evidence periods defined by the operating requirements.

## Activation

Do not enable a production tenant until:

1. Both department report implementations independently pass their outcome and
   tenant-isolation suites.
2. A human owner accepts the exact contract versions.
3. Reports for the same period are accepted with source evidence.
4. Migration replay, rollback, and two-/three-tenant negative proofs pass.
5. The exact tenant is explicitly included in the feature cohort.

No production activation is authorized by this migration.

## Containment and rollback

`cos_kill_switch_rpc(tenant_id, reason)` atomically disables the tenant,
engages the one-way kill switch, increments revision, and stores only a SHA-256
reason digest.

Rollback
`db/rollbacks/087_chief_of_staff_supervised_control_rollback.sql` engages
containment and removes all RPC write paths. Tables and immutable evidence are
retained for audit.
