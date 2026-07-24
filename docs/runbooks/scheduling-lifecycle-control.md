# Scheduling lifecycle control

## Scope

Migration 078 adds a default-off, tenant-bound lifecycle ledger for appointment
invitation readiness, delivery receipts, reminders, rescheduling, preparation,
completion, follow-up, and exceptions. It does not call Telnyx, Calendly, Google
Calendar, email, or any other external provider.

The existing `appointment_workflows.status` remains the canonical booking state.
`appointment_lifecycle_controls.lifecycle_state` is the automation checkpoint;
all changes pass through one atomic service-role RPC and append immutable evidence.

## Safety properties

- No automation-control row exists by default.
- New control rows default to disabled with the kill switch engaged.
- A database constraint keeps provider dispatch disabled.
- The runtime feature gate and exact tenant control must both allow a command.
- Authenticated and service roles have read-only table grants; service mutations
  are possible only through `appointment_lifecycle_command_rpc`.
- Every command binds tenant, appointment, optimistic revision, idempotency key,
  semantic fingerprint, actor authority, and source evidence in one transaction.
- Human actors must be current owner-class members of the same tenant.
- Agent actors are intentionally unsupported until the agent identity registry
  and supervised authority grants exist.
- Provider delivery states require authoritative provider receipts. A clock can
  make a reminder or follow-up due, but can never claim it was delivered.
- The pure planner produces database command recommendations only and has no
  network or provider dependency.

## Activation requirements

Do not activate this migration in production before the consolidated approval,
tenant-isolation suite, regression suite, and rollback validation are complete.
For a staging tenant, a reviewed transaction must create or update its exact
`scheduling_automation_controls` row to `enabled=true`,
`execution_mode='shadow'`, and `kill_switch_engaged=false`, with non-empty
activation evidence. The runtime must also pass its default-off lifecycle flag.

Invitation, reminder, and follow-up delivery still require a separately reviewed
dispatcher plus provider credentials. Current production inventory has no active
Calendly tenant integration. Google credentials, if selected instead, require
Calendar scopes and tenant-specific calendar authorization. Telnyx credentials
are required only for a future approved SMS/voice dispatcher; migration 078
neither reads them nor sends messages.

## Operating sequence

1. Run the planner in shadow mode and inspect its decision.
2. Submit at most one recommended command through the RPC.
3. Require provider receipts before recording `invited`, reminder delivery, or
   follow-up completion.
4. Re-read the lifecycle control and immutable event before advancing.
5. Raise an exception for any ambiguous identity, missing receipt, stale revision,
   invalid transition, or provider mismatch. Fail closed.

## Kill switch and rollback

`scheduling_lifecycle_kill_switch_rpc` is always available to the service
boundary and can only move a tenant toward safety: disabled mode with the kill
switch engaged. It cannot enable a tenant or clear a kill switch. The rollback
removes both RPCs and forces every existing control to disabled with the kill
switch engaged. It deliberately retains all lifecycle tables, events, and
evidence. Kill-switch reasons are non-sensitive machine codes, never customer
text. It sends no cancellation and changes no provider booking.
