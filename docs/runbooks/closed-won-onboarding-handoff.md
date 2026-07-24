# Closed-Won to Acknowledged Onboarding Handoff

Status: implementation foundation only; disabled by default; no production
activation authorized.

## Purpose

Migration 076 records the handoff between an FGA sales outcome and the newly
provisioned client tenant's onboarding workflow. It does not provision tenants,
start onboarding, send communications, charge a customer, or activate a
production feature.

The deployed schema has two distinct tenant identities:

- `source_tenant_id` owns the authoritative `leads` row whose status is `won`.
  An optional `customers` link must belong to this same source tenant and is
  accepted only by exact UUID.
- `client_tenant_id` owns the `onboarding_workflows` row. This is the newly
  provisioned client's tenant and may differ from the sales/source tenant.

The database verifies both sides under locks. It never guesses an identity from
name, email, phone number, or other customer data.

## Lifecycle

1. `initiate`: verifies the won lead, optional customer, active client tenant,
   optional workflow, and SLA deadlines; records one immutable source event and
   one handoff.
2. `accept`: records explicit current-owner acceptance or identified supervised
   service acceptance evidence. Anonymous system actors cannot accept.
3. `acknowledge`: requires an exact onboarding workflow owned by the client
   tenant and digest-bound workflow evidence.
4. `record_retry`: schedules a bounded retry or moves the handoff to an
   exception when attempts are exhausted.
5. `raise_exception`: records a machine-readable exception and immutable
   evidence.
6. `complete`: closes only an acknowledged handoff with completion evidence.

Every transition uses optimistic revision checking and an idempotency key.
Same-key semantic retries replay; same-key conflicts fail closed.

## Activation gate

The RPC requires all of the following:

- a caller-provided `p_feature_gate_enabled = true` (default is false);
- a verified `service_role` invocation;
- exact source tenant, record, and client tenant relationships;
- an immutable SHA-256 request fingerprint;
- typed, digest-bound evidence for every transition after initiation.

The existing verified Stripe checkout path now has a default-off runtime
adapter. It does not replace or block deployed onboarding. It runs only when:

- `FGA_OS_CONNECTED_WORKFLOW_WRITES_ENABLED=true`;
- `FGA_OS_CLOSED_WON_ONBOARDING_WRITES_ENABLED=true`;
- `FGA_OS_STRICT_WEBHOOK_VERIFICATION=true`;
- the exact source tenant is in
  `FGA_OS_CLOSED_WON_SOURCE_TENANT_ALLOWLIST`;
- the exact client tenant is in
  `FGA_OS_CLOSED_WON_CLIENT_TENANT_ALLOWLIST`; and
- signed Stripe metadata supplies `source_tenant_id`, `tenant_id`, `lead_id`,
  and optional `source_customer_id`, while the created onboarding workflow
  belongs to the client tenant.

The adapter creates, service-accepts, and acknowledges the handoff using only
stable UUIDs and digest-bound provider evidence. It excludes customer name,
email, phone, and raw webhook payload. Same-event retries resume from the
committed state.

Before activation, complete a monitored shadow run and three-client end-to-end
test, prove the checkout-creation surface writes the required immutable
metadata, drill the evidence-preserving rollback, and obtain consolidated
production approval. The PostgreSQL safety suite already exercises
disabled/authenticated/direct-write denial, exact tenant relationships, replay,
lifecycle advancement, system-acceptance rejection, service acknowledgment,
completion, and cross-tenant rejection.

## Rollback

Run `db/rollbacks/076_closed_won_onboarding_handoff_rollback.sql` to revoke and
remove the command RPC. The handoff, closed-won event, and immutable transition
evidence tables remain intact. Restoring the migration recreates the command
boundary without deleting or rewriting evidence.
