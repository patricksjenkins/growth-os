# Revenue and Sales Department Head — supervised foundation

Migration 086 implements the evidence and coordination boundary for a genuine
Revenue and Sales Department Head. It is not an outreach agent, report rename,
or production-authority grant.

## Mission and KPIs

Each tenant registers an immutable, owner-approved charter. Its written mission
must be at least 40 characters and its measurable KPI contract contains:

- qualification rate;
- qualified-lead to booked-appointment rate;
- booked to held-appointment rate;
- held-appointment to proposal rate;
- closed-decision win rate;
- maximum average sales-cycle days.

Targets use basis points for exact integer comparison. Updating a mission or KPI
contract creates a new charter version; prior versions remain immutable.

## Accepted input contract

The Head accepts only `sales_outcome_v1` reports through
`revenue_head_report_accept_rpc`. A report contains:

- exact tenant, charter, period, source-system, and source-report identity;
- monotonically consistent aggregate funnel counts;
- exact minor-unit pipeline and booked-revenue amounts plus currency;
- average sales-cycle days;
- a versioned evidence manifest containing 1–50 opaque, timestamped,
  SHA-256-addressed sources. Duplicate source identities are rejected.

The evidence contract rejects contact information, messages, provider payloads,
tokens, pricing, charges, refunds, and contracts. Source-report identity is
globally non-rebindable, preventing the same upstream report from being claimed
by another tenant.

## Honest outcome health

RPC execution and work-item completion never set funnel health. The database
derives qualification, appointment, held, proposal, and win rates from the
accepted aggregate counts and compares them to the named charter version.

Health is:

- `unverified` when fewer than two distinct evidence source types exist or a
  funnel denominator is absent;
- `critical` for severe target misses or a severely over-SLA sales cycle;
- `at_risk` for any target miss;
- `healthy` only when every funnel KPI and cycle target passes.

`outcome_healthy` is generated and can be true only when the derived health is
healthy and observed closed-decision evidence exists. Completing an analysis
task cannot turn an unhealthy report green.

## Durable operating contracts

Every goal, work item, owner decision, or exception links to an accepted report.
The allowed scopes are analysis, goal tracking, recommendations, owner decision
requests, exceptions, and evidence verification.

Items implement assignment, assignee acceptance, start, SLA, escalation,
evidence-backed completion, and owner decision recording. Identity, source
report, scope, assignee, and SLA are immutable. Every transition appends an
immutable, replay-safe event.

The registered Head has exact `department_head` authority and can coordinate
only its own tenant ledger. Owner decisions require a current tenant human with
owner authority. A Head cannot spoof owner authority.

## Safety boundary

Controls default to:

- disabled;
- kill switch engaged;
- no registered production authority;
- `production_write_authority=false`;
- `outreach_enabled=false`;
- `provider_dispatch_enabled=false`;
- `pricing_authority_enabled=false`;
- `financial_authority_enabled=false`.

The only enabled mode is `supervised_read_only`. These false authority columns
are database constraints, not configuration conventions. Migration 086 does
not alter leads, messages, campaigns, finance, pricing, contracts, or providers.

Every normal RPC requires `service_role`, an explicit feature-gate argument,
and the exact active tenant control. Direct writes are denied even to
`service_role`. Authenticated reads use JWT tenant identity and role.

## Activation and evidence gate

No production activation is authorized. Before requesting activation:

1. apply and replay migration 086 in an isolated environment;
2. pass its two-tenant negative proof and the broader three-tenant suite;
3. register an owner-reviewed mission and KPI charter;
4. reconcile accepted reports against source evidence in supervised mode;
5. prove identity, stale-revision, replay, SLA, and owner-decision contracts;
6. accumulate the required real evidence period without fabricating history;
7. include the exact tenant cohort and rollback in the consolidated approval.

Production write authority, outreach, provider dispatch, pricing, financial
actions, and contract changes require later migrations and separate approval.

## Emergency containment and rollback

`revenue_head_kill_switch_rpc(tenant_id, reason_code)` is service-role-only and
can only set the tenant to disabled with its kill switch engaged. The trigger
forbids an engaged-to-released transition. The RPC returns only outcome, tenant
ID, and revision; it stores only a reason digest.

Rollback with:

`db/rollbacks/086_revenue_department_head_supervised_rollback.sql`

Rollback first contains every control, then removes the charter, report, work,
and kill-switch RPCs. All charters, accepted reports, items, events, RLS, and
direct-write denial remain for investigation.

## Validation

```sh
node --test \
  test/revenue/department-head-planner.test.js \
  test/revenue/department-head-migration.test.js
```

After the standard synthetic bootstrap and migration 086:

```sh
psql "$SYNTHETIC_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f test/sql/revenue-department-head-negative.sql
```

Never run the synthetic proof against production.
