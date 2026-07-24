# Lead-action evidence and cohort control

Migration 084 adds a default-off evidence plane for G20. It records assignment,
acceptance, SLA escalation, completion, and observed/unknown outcome receipts.
It does not contact a lead, dispatch through a provider, change lead status, or
backfill historical evidence.

## Safety model

- Every command carries exact `tenant_id`, `lead_id`, `lead_action_id`, and
  `action_type` identity.
- Only `service_role` can invoke commands. Direct table mutation is revoked,
  including for `service_role`.
- Both the caller feature-gate argument and the exact tenant control row must
  be enabled. Controls start disabled with the kill switch engaged.
- Activation is limited to `shadow` or `supervised`; outbound and provider
  dispatch columns are structurally constrained to `false`.
- Action identity, assignment attribution, SLA dates, and cohort membership are
  immutable. Each transition creates an append-only receipt.
- The planner accepts no recipient, message, provider payload, customer PII, or
  causal claim and performs no I/O.

## Honest cohort interpretation

`lead_action_conversion_cohorts` uses the server-recorded assignment month.
There is no command parameter for an assignment date or cohort month, so this
write path cannot fabricate a historical evidence window.

The view reports known outcomes in `observed_outcome_count`, explicitly expired
or unavailable evidence in `unknown_outcome_count`, and actions whose evidence
window is still open in `pending_outcome_count`. The
`observed_conversion_rate` denominator contains only observed converted and
not-converted outcomes. A null rate means there are no observed outcomes; it is
not zero performance.

Every row declares `attribution_model = descriptive_association_only` and
`causal_claim = false`. Treat the result as an association between an assigned
action cohort and later observed lead state, never as proof that the action
caused conversion.

## Activation gate

Keep every tenant disabled in production until:

1. Migration and rollback replay pass in an isolated database.
2. Two- and three-tenant negative proofs pass.
3. The exact tenant cohort is approved and a tenant member with owner authority
   supplies activation evidence.
4. The worker passes `p_feature_gate_enabled = true` only for that exact tenant.
5. Shadow receipts are reconciled to source evidence without outreach.

No production activation is authorized by this migration.

## Runtime verification

For an activated synthetic or staging tenant:

1. Assign an action and replay the same idempotency key. The first result must
   be `applied`; the second must be `replay`.
2. Verify the action revision advances exactly once for acceptance, escalation,
   completion, and outcome recording.
3. Verify stale revisions and conflicting idempotency keys fail closed.
4. Verify a tenant cannot reference another tenant's lead or action.
5. Verify receipt update/delete attempts fail.
6. Verify cohort observed plus unknown counts equal assigned count.
7. Verify authenticated cohort reads contain only the JWT tenant.

## Containment and rollback

Emergency containment uses:

`lead_action_kill_switch_rpc(tenant_id, reason)`

The kill switch disables the tenant and cannot be disengaged through an update.
Rollback
`db/rollbacks/084_lead_action_evidence_cohorts_rollback.sql` engages containment
for all control rows and removes both RPC write paths. It deliberately retains
actions, receipts, and the cohort view for evidence review.
