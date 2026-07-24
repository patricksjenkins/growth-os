# Shadow billing attribution

## Purpose and safety state

Migration 079 adds an isolated evidence ledger for G15. It does not replace or
backfill `finance_entries`, change any existing total, call Stripe, or alter a
billing webhook. Both command planners return `p_feature_gate_enabled: false`,
and both database RPCs reject disabled calls. The tables have RLS enabled, no
authenticated policies, service-role read access only, and no direct
service-role insert, update, or delete grants.

The ledger binds a provider identity chain to an exact tenant and customer:

1. An authoritative tenant mapping names the provider-side tenant object.
2. An authoritative customer or subscription mapping names a provider-side
   customer object and references a customer belonging to the same tenant.
3. An attribution record requires both mappings, the same provider account,
   and the same tenant/customer relationship.
4. Revenue, direct cost, and generated margin use signed integer minor units.
5. Reconciliation is fail-closed: pending has no claimed authoritative totals;
   matched totals must agree exactly; an exception must contain an exact
   non-zero difference.

Mappings and attribution rows are immutable. Corrections must be represented by
new provider evidence and a new attribution event; operators must never rewrite
history.

## Activation prerequisites

Keep all callers absent or disabled until one consolidated production approval
confirms:

- a versioned Stripe webhook adapter has verified signatures before parsing;
- an exact tenant allowlist is configured (never a global boolean cohort);
- authoritative provider-account, tenant, customer, and subscription metadata
  conventions are documented and tested against non-customer fixtures;
- webhook event IDs and object IDs contain no email, name, address, payment
  method, token, secret, or raw payload;
- a cost source of record and currency/minor-unit exponent are approved;
- two-tenant and three-tenant database tests prove provider object IDs and
  events cannot be rebound across tenants or customers;
- the shadow totals reconcile for the evidence period without changing legacy
  totals, invoices, subscriptions, charges, refunds, or customer behavior;
- the migration apply/replay and rollback path pass against the released
  database shape.

An approved runtime caller must set the RPC gate to true only after its own
default-off flag, exact tenant allowlist, verified webhook evidence, and provider
account lookup all pass. Never derive tenant identity from request parameters,
customer-supplied metadata, names, or email addresses.

## Shadow verification

For each enabled staging tenant:

1. Register the tenant identity and customer identity through
   `billing_identity_register_rpc`.
2. Record one provider event through `finance_attribution_record_rpc`.
3. Replay the same idempotency key and verify the outcome is `replay`.
4. Attempt the same external object and event under a second tenant and verify a
   conflict with no row created.
5. Attempt direct table writes as authenticated and service roles and verify
   denial.
6. Compare revenue, cost, and margin minor-unit sums to authoritative evidence.
7. Confirm all existing finance API responses and totals are byte-for-byte
   unchanged.

No production activation is authorized by this runbook.

## Rollback

1. Disable the runtime feature flag and remove every tenant from its allowlist.
2. Stop the shadow consumer and drain no further provider events.
3. Apply
   `db/rollbacks/079_billing_customer_attribution_rollback.sql`.
4. Verify both RPCs are absent, direct writes remain denied, and existing
   finance APIs and totals remain unchanged.
5. Retain the immutable shadow tables for investigation and audit.

Dropping the retained evidence tables is a separate destructive action and is
not part of this rollback.
