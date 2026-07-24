# Product and Engineering Department Head — supervised foundation

Migration `092_product_engineering_head_supervised.sql` adds an additive,
tenant-scoped executive control plane for product and engineering. It accepts
structured engineering evidence and coordinates supervised goals, work,
decisions, and exceptions. It cannot merge code, deploy, apply a database
migration, activate a feature, release TestFlight/App Store builds, contact a
provider or customer, move money, change pricing, or change legal policy.

## Mission and measurable KPIs

The written mission is to protect product quality while proving that
engineering work creates measured outcomes. Every tenant control must define
contracts for:

- reliability and quality pass rate;
- change lead time and throughput;
- regression escape rate;
- tenant-isolation gate pass rate;
- incident escape rate;
- rollback readiness;
- accessibility debt;
- security debt;
- measured product-outcome achievement.

Accepted report classes are:

- `reliability_quality`;
- `change_throughput`;
- `regression_isolation`;
- `incident_rollback`;
- `accessibility_security`;
- `product_outcome`.

Reports preserve execution health separately from product outcome. A healthy
build, successful test run, completed work item, or release-ready assessment
does not prove adoption, customer value, revenue, retention, or another
business effect.

## Evidence contract

Every report has a bounded manifest of 1–50 sources. Each source includes:

- an allowed source type;
- a stable source identity;
- the exact tenant identity;
- a SHA-256 digest;
- an observation timestamp.

Duplicate source identities and cross-tenant sources are rejected. The
manifest must contain the report's declared source identity and any declared
run identity. Report-specific minimum evidence is:

| Report | Required evidence |
| --- | --- |
| Reliability and quality | Automated test run |
| Change throughput | Deployment-readiness check |
| Regression and isolation | Automated test run and tenant-isolation gate |
| Incident and rollback | Rollback drill |
| Accessibility and security | Accessibility audit and security scan |
| Product outcome | Product-outcome receipt |

A verified `achieved` or `not_achieved` product outcome is accepted only after
`product_engineering_outcome_receipt_rpc` records an immutable canonical
receipt. It is executable only in the authenticated owner's JWT context;
`service_role` cannot impersonate the verifier. The verifier must be a current
same-tenant owner human whose identity is distinct from the registered
Department Head. The
report must use that receipt as its declared source, match its outcome state,
digest, tenant, and observation time, and bind every verified KPI
`evidence_ref` to `product_outcome_receipt:<receipt UUID>`. A caller-supplied
source label is never sufficient.

Persisted JSON is intentionally minimal:

- report bodies contain `summary` and optional string-array `findings`,
  `exceptions`, and `recommendations`;
- report manifests and each source accept only their documented identity,
  digest, tenant, and time fields;
- case contracts use type-specific objective/criteria/options fields whose
  values are bounded strings or string arrays;
- case event evidence contains only `source_type`, `source_id`, and
  `observed_at`.

Unknown, mixed-case, contact, credential, secret, token, and raw-payload keys
fail closed before persistence. The migration does not invent historical
results or maturity.

## Supervised work contract

Goals, work, decisions, exceptions, and their immutable evidence are durable.
Work includes:

- owner and assignee;
- assignment and human acceptance;
- SLA due time;
- escalation state and code;
- evidence-backed engineering completion;
- a separate product-outcome receipt.

`complete_work` always leaves the outcome `unproven`. Only a later
`record_product_outcome` transition can record `achieved` or `not_achieved`.
The registered Department Head can recommend but cannot approve its own
decision.

## Authority and tenant boundary

Controls default to disabled with the kill switch engaged. Enabled operation is
limited to `shadow` or `supervised_read_only` and requires a current
same-tenant owner/admin-equivalent membership plus structured activation
evidence.

The database permanently constrains all of these fields to `false`:

- code merge;
- deployment;
- migration apply;
- feature activation;
- TestFlight/App Store or other release;
- external provider action;
- customer communication;
- money movement;
- pricing;
- legal policy.

Every report/case service RPC requires an explicit feature gate, exact control
revision, stable idempotency key, request fingerprint, valid actor authority,
and the registered Head identity for agent actions. The canonical outcome
receipt RPC instead derives the human verifier from `auth.uid()` and requires
an exact JWT tenant plus current live owner membership. Authenticated users can
read only their exact tenant through RLS. Direct table writes are denied to
authenticated and service roles.

## Validation

Run the focused tests:

```sh
node --test \
  test/product-engineering/product-engineering-head-planner.test.js \
  test/product-engineering/product-engineering-head-migration.test.js
```

After the standard synthetic bootstrap, migrations 067–092, and the base
tenant-negative proof:

```sh
psql "$SYNTHETIC_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f test/sql/product-engineering-head-negative.sql
```

The PostgreSQL proof covers cross-tenant activation and reports, prohibited
authority, direct-write and authenticated-RPC denial, disabled gates, exact
registered Head identity, report-specific isolation evidence, false product
outcomes, idempotent replay, revisions, assignment and acceptance, engineering
completion versus measured outcome, agent self-approval, exact-tenant RLS,
immutable evidence, and kill-switch containment.

Use only synthetic data in a disposable database. No production deployment,
release, migration, provider/customer action, or client experimentation is
part of validation.

## Activation gate

Migration 092 does not authorize production activation. Before inclusion in
the consolidated production approval:

1. Apply and replay migration 092 in staging.
2. Pass the full regression, security, accessibility, and two-/three-tenant
   isolation suites.
3. Validate manifest producers and source digests against authoritative CI,
  incident, rollback, and product analytics systems, including independent
  owner verification of canonical product-outcome receipts.
4. Register an owner-reviewed mission, KPI contract, and authority contract.
5. Operate only in `shadow` or `supervised_read_only` with every production
   authority false.
6. Accumulate the required real evidence period without fabricating history.
7. Review false-green, SLA, rollback, accessibility/security debt,
   product-outcome, audit, and containment evidence.

Activation remains disabled when tenant identity, evidence provenance,
authority, rollback readiness, or outcome verification is inconclusive.

## Kill switch and rollback

`product_engineering_head_kill_switch_rpc` requires `service_role`, the exact
control revision, and a non-sensitive reason. It disables the tenant, engages
the kill switch, increments the revision, and cannot be reversed by an
ordinary update.

Rollback:

```sh
psql -v ON_ERROR_STOP=1 -d autonomous_os_test \
  -f db/rollbacks/092_product_engineering_head_supervised_rollback.sql
```

Rollback first contains every control, removes the outcome-receipt,
report/case, and kill command RPCs, and revokes direct writes. Accepted
canonical outcome receipts, reports, goals, work, decisions, exceptions,
events, and immutable evidence remain available for investigation and audit.
