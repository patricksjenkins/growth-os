# No-touch scheduling replaces reply coordination

**Date:** 2026-07-24

**Status:** implementation in progress; production activation gated

**Authority:** Patrick Jenkins

## Decision

The 2026-05-15 reply-to-email scheduling decision is superseded. Patrick’s day
job makes manual appointment coordination non-viable.

FGA will use a no-touch scheduling workflow with:

- tenant-specific availability and notice/buffer rules;
- a self-service booking surface;
- authoritative booking, cancellation, reschedule, preparation, reminder,
  follow-up, and exception states;
- the existing Calendly code path as the first supported booking/webhook
  adapter, while keeping it disabled until a real tenant integration exists;
- Telnyx, not Twilio, for any approved SMS reminder or follow-up;
- a calendar free/busy authorization or explicitly approved fixed availability
  before invitations can be activated.

## Current implementation boundary

The canonical appointment schema and provider receipt projection are
implemented behind disabled flags and exact tenant cohorts. Verified Calendly
webhooks can be projected without storing invitee names, emails, answers, or
raw provider payloads in the canonical event evidence.

The aggregate-only production baseline on 2026-07-24 found no active Calendly
tenant integration and no canonical scheduling policy. Google OAuth client
configuration exists, but the current authorization flows request mail scopes,
not Calendar scopes. Therefore no live calendar provider or free/busy
authorization is assumed.

The production invitation/reminder sender remains disabled. No customer
message, booking invitation, calendar write, or production setting was changed.

## Precise activation requirements

Before no-touch invitations may be enabled for a tenant:

1. An active `scheduling_policies` record with timezone, minimum notice,
   buffers, booking horizon, reminder policy, and non-empty availability rules.
2. A tenant-specific Calendly booking URL and active integration record, or a
   separately implemented and verified Google Calendar provider adapter.
3. Strict Calendly webhook verification with the tenant’s signing secret.
4. Calendar authorization proving free/busy access, or an explicitly approved
   fixed-availability policy that cannot expose day-job calendar details.
5. A verified tenant outbound identity and Telnyx messaging configuration if
   SMS is enabled.
6. Exact tenant inclusion in the scheduling cohort.
7. Passing tenant-negative, idempotency, cancellation, deep-link, and
   rollback tests.
8. Consolidated production approval.
