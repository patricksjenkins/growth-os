# Content delivery and quality control (G08/G09)

Migration 082 adds an inert evidence boundary around the existing content
planner/publisher. It does not modify `content_drafts`, call Buffer or another
provider, or publish content.

## Safety posture

- Every tenant starts disabled with its kill switch engaged.
- Once engaged, the database trigger forbids clearing a kill switch. Releasing
  it requires a separately reviewed forward migration, not an operational RPC.
- The database permanently constrains `provider_dispatch_enabled` to `false`.
- The pure planner always emits `p_feature_gate_enabled: false`; a supervised
  caller must make a separate, explicit gate decision.
- Only `service_role` may execute command RPCs. Direct table writes are denied
  even to `service_role`.
- Artifact versions, rubric versions, calibrations, evaluations, and delivery
  receipts are append-only.
- Provider delivery identity is globally non-rebindable across tenants sharing
  a provider account.
- Failed, stuck, and exception receipts require a tenant-matched owner-tier
  `work_items` link.

The service boundary may call
`content_delivery_kill_switch_rpc(tenant_id, reason_code)` without a feature
gate. It atomically sets `enabled=false`, `execution_mode='disabled'`, and
`kill_switch_engaged=true`; the trigger advances the revision. The return value
contains only outcome, tenant ID, and revision. The supplied reason is retained
only as a SHA-256 digest in control evidence.

## Evidence model

The ledger records five independent outcome dimensions:

1. handler execution;
2. useful output;
3. calibrated quality;
4. external delivery;
5. measured business effect.

A completed no-op or no-output attempt cannot be marked quality-accepted,
delivered, or business-achieved. A `delivered` receipt requires a version-bound,
accepted quality evaluation. Business effect remains `unverified` until a
separate evidence digest exists.

Quality evaluations name an immutable rubric version and calibration record.
Calibration evidence includes the benchmark-set digest, scorer-config digest,
sample count, and agreement basis points. These records do not claim that a
production evidence period has passed.

## Activation gate

Keep the control absent or disabled until all of these are proven in a
non-production environment:

1. migration apply and replay succeed;
2. rollback removes every RPC while preserving evidence;
3. the synthetic two-tenant proof passes;
4. provider account and destination mapping are verified without customer data;
5. receipt ingestion verifies provider authenticity outside this migration;
6. an owner work-item creation path exists for failures and stuck attempts;
7. the quality rubric has a reviewed calibration set;
8. the production approval packet authorizes the exact tenant cohort.

Even after approval, use `shadow` first. Migration 082 cannot dispatch, so
provider receipts must describe externally observed facts only.

## Validation

Run the focused static and planner tests:

```sh
node --test \
  test/content/delivery-quality-planner.test.js \
  test/content/delivery-quality-migration.test.js
```

For database validation, apply the standard synthetic bootstrap, migrations
through 082, then:

```sh
psql "$SYNTHETIC_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f test/sql/content-delivery-quality-negative.sql
```

Never run the synthetic proof against production.

## Rollback

First stop all migration-082 callers. Apply
`db/rollbacks/082_content_delivery_quality_control_rollback.sql`. The rollback
revokes and drops the command and kill-switch RPCs, but intentionally retains
all immutable evidence tables, RLS, direct-write denial, and the engaged
one-way control state. The legacy publisher remains unchanged.
