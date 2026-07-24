# Calendarless no-touch scheduling replaces reply coordination

**Date:** 2026-07-24

**Status:** implementation in progress; production activation gated

**Authority:** Patrick Jenkins

## Decision

The 2026-05-15 reply-to-email scheduling decision is superseded. Patrick’s day
job makes manual appointment coordination non-viable.

FGA will use a no-touch scheduling workflow with:

- tenant-specific availability and notice/buffer rules;
- an FGA-owned self-service booking surface and canonical appointment ledger;
- authoritative booking, cancellation, reschedule, preparation, reminder,
  follow-up, and exception states;
- fixed availability explicitly approved by Patrick, with no calendar
  connection, free/busy read, or calendar write;
- Telnyx, not Twilio, for approved scheduling coordination, confirmation,
  reminder, reschedule, cancellation, and follow-up messages;
- exception escalation when a request falls outside policy or identity,
  delivery, booking, or timing evidence cannot be proven.

## Current implementation boundary

The canonical appointment schema and lifecycle evidence are implemented behind
disabled flags and exact tenant cohorts. The target design does not require or
permit access to Patrick's work calendar.

The legacy Calendly webhook and projection code remains isolated and unchanged
only to preserve historical compatibility. It is not an activation dependency
and must not be presented as the FGA scheduling implementation. No new Google
Calendar, Calendly, Cal.com, Microsoft calendar, or free/busy integration will
be built for this workflow.

The production invitation/reminder sender remains disabled. No customer
message, booking invitation, or production setting was changed.

## Precise activation requirements

Before no-touch invitations may be enabled for a tenant:

1. An active `scheduling_policies` record with timezone, minimum notice,
   buffers, booking horizon, reminder policy, and explicit fixed-availability
   windows.
2. `provider='fga_fixed_availability'`; external calendar providers fail closed.
3. An enabled FGA booking surface bound to the exact tenant and appointment.
4. Patrick's recorded approval of the fixed-availability policy.
5. A verified tenant outbound identity and Telnyx messaging configuration.
6. Exact tenant inclusion in the scheduling cohort.
7. Passing tenant-negative, slot-collision, idempotency, cancellation, deep-link, and
   rollback tests.
8. Consolidated production approval.
