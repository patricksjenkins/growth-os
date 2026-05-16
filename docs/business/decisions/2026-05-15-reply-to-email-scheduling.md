# Reply-to-email scheduling instead of Cal.com

**Date:** 2026-05-15
**Status:** decided
**Decided by:** Patrick + Claude

## Context

The onboarding wizard's Path B (Owned Apple developer account) flow
calls for a 25-minute Day-1 enrollment call between the customer and
Patrick. The Day-5 founder onboarding call applies to every customer
regardless of path. Original spec assumed Cal.com would be the
booking surface.

Patrick works a Microsoft day job and can't connect Cal.com to his
Microsoft work calendar. Without that connection, Cal.com would
either:
- Show empty availability (no real free/busy data), or
- Risk double-booking work meetings

A separate Cal.com with manually-defined "evenings + weekends"
availability is possible but adds maintenance overhead.

## Options considered

1. **Cal.com with manual availability windows** — set fixed
   evening/weekend slots, customers self-book. Low ongoing
   friction, but Patrick has to remember to update availability
   around vacation, late meetings, etc.
2. **Reply-to-email scheduling** — welcome + Apple-enrollment
   emails ask the customer to reply with 2-3 times that work.
   Patrick replies with a Teams/Zoom invite from his phone.
3. **Microsoft Bookings** — uses his existing Microsoft account
   but lives inside Microsoft's tools and may expose work calendar.

## Decision

**Reply-to-email scheduling.** No third-party scheduler integration.
Customers send 2-3 times, Patrick sends back a calendar invite.

## Consequences

- `core/apple-enrollment-email.js` no longer reads `FOUNDER_CAL_LINK`
  env var. Removed.
- `templates/emails/apple-enrollment.html` replaced the "Book the
  25-min call →" button with a Step 1 panel asking for reply with
  2-3 times.
- `templates/emails/welcome-wizard.html` P.S. updated to invite
  Day-5 call scheduling via reply.
- `docs/business/onboarding/client-onboarding-runbook.md` Track A
  + Day-5 sections updated to reflect email-based scheduling.
- `launch-checklist.html` Cal.com items flipped to "scheduling
  approach decided" (done).
- Implemented in commit `4885d46`.

## Revisit when

- Customer volume crosses ~5 onboardings/week (back-and-forth
  email volume becomes meaningful overhead)
- Patrick leaves Microsoft (Cal.com→Outlook connection becomes
  viable)
- A customer complains the reply-to-schedule flow is too slow
