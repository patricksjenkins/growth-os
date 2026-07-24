# AI safety fail-closed cohort

This control closes the guard-integrity gap without changing existing tenant
traffic by default. It is additive and inactive unless the activation flag is
explicitly enabled.

## Scope

Only an automated AI provider call that satisfies every condition can fail
closed when the safety store or guard is unavailable:

- its tenant id is in the exact activation cohort;
- its `actionClass` is one of `analysis`, `classification`, `draft`, or
  `retrieval` and is in the configured action-class allowlist;
- its `sideEffect` is exactly `none`;
- usage tracking, monitor mode, and strict metadata are enabled.

Human calls, unclassified calls, non-cohort tenants, and calls with a side
effect are not silently promoted into this policy.

## Activation sequence

1. Keep `AI_FAIL_CLOSED_GUARD_ERRORS_ENABLED=false`.
2. Confirm the AI safety tables and switches are available in the target
   environment.
3. Select synthetic or read-only operations that emit `tenantId`,
   `actionClass`, and `sideEffect=none`.
4. Set `AI_STRICT_METADATA_REQUIRED=true`.
5. Set exact UUIDs in `AI_FAIL_CLOSED_TENANT_IDS`.
6. Set the smallest required subset in `AI_FAIL_CLOSED_ACTION_CLASSES`.
7. Enable `AI_FAIL_CLOSED_GUARD_ERRORS_ENABLED=true` in staging or shadow
   first. Startup must refuse an incomplete configuration.
8. Exercise a safety-store failure and prove eligible calls return
   `ai_safety_guard_unavailable`, while other tenants and human calls retain
   their existing behavior.

## Rollback

Set `AI_FAIL_CLOSED_GUARD_ERRORS_ENABLED=false` and restart the service. This
restores the compatibility fail-open path without a database change. Do not
remove the cohort metadata until the post-rollback verification is complete.
