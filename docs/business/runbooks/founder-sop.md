# Founder SOP — Day 1 and Day 5 of Client Onboarding

Patrick's personal-touch moments inside the otherwise-automated
7-day onboarding workflow. Detailed checklist + scripts to run
each call cleanly without ad-libbing.

For the broader 7-day automated timeline, see
`docs/business/onboarding/client-onboarding-runbook.md`.

---

## Day 1 — Apple Developer Enrollment Call (Path B / Owned only)

**Target trigger:** Customer picks "Full Ownership" at wizard Step 3. Once
calendarless scheduling is production-approved for that exact tenant, FGA
offers only Patrick-approved fixed-availability slots, owns the canonical
appointment record, and uses the verified Telnyx identity for coordination.
There is no external calendar or free/busy integration.

**Patrick's role:** Handle only policy exceptions or material relationship
moments. Routine invitation, booking, confirmation, reminder, reschedule,
cancellation, preparation, and follow-up state is owned by FGA. Until the new
workflow receives consolidated production approval, preserve the deployed
reply-to-email path rather than changing an active tenant's behavior.

### Pre-call prep (~3 minutes)

- [ ] Open the tenant's `tenant_config` in the admin Clients page.
      Confirm `delivery_path = 'owned'`, `legal_entity_name` is
      populated (LLC name as it'll appear in Apple's enrollment form),
      and `duns_number` is either filled or marked blank.
- [ ] Have FGA's company card ready in 1Password — you'll pay the
      $99 Apple fee on their behalf during the call.
- [ ] Open https://developer.apple.com/programs/enroll in a tab so
      you can screen-share to show the customer what's coming.

### During the call — 25-minute script

| Time | What to say + do |
|---|---|
| 0:00–0:02 | "Welcome, thanks for picking Full Ownership. We're going to set up your Apple Developer account in about 20 minutes. I'll talk you through every screen — you do the typing on your end, I'll do all the Apple-side prep on mine after." |
| 0:02–0:04 | Walk them to https://developer.apple.com/programs/enroll. Make sure they're logged into the Apple ID they want to associate with the business. (Personal Apple ID is fine for sole props.) |
| 0:04–0:18 | Step-by-step through the form. Read out their `legal_entity_name`, address, phone as captured. If they don't have a D-U-N-S number, click "Request a D-U-N-S Number" — adds 1-2 days to the verification timeline. |
| 0:18–0:21 | When the $99 payment screen appears: "I'm going to give you my card to use — this is included in your setup fee." Read your card number, expiry, CVV out loud. Have them enter + submit. |
| 0:21–0:23 | Confirm the "Enrollment submitted" screen appears. Take a screenshot (Apple sometimes loses these confirmations). |
| 0:23–0:25 | "You'll get an email from Apple in 24-48 hours when your enrollment's approved. When that lands, just reply to this email and I'll send you a 2-tap instruction to add me as Admin so I can ship your branded app." |

### Post-call (~2 minutes)

- [ ] Log the call in `tenant_config.notes`: date, duration, any
      gotchas.
- [ ] Add a reminder for yourself: "Watch for Apple approval email
      for {tenant} — typically 1-2 business days."

---

## Day 2 — Apple Approval Lands

**Trigger:** Customer forwards or replies "got the Apple approval"
email. (Or you can pre-empt by checking Apple's developer portal
directly if they shared their Apple ID.)

### Automated SMS goes out
The backend `onboarding-advance` worker (cron 3am ET daily) detects
the approved state and sends an SMS automatically asking the customer
to add Patrick as Admin. If not, send manually:

> Hi [Name] — Apple approved your developer account. Two quick taps:
> 1. Open https://appstoreconnect.apple.com/access/users
> 2. Tap "Add User," type `patricksj@hotmail.com`, role Admin, all apps. Hit invite.
>
> 2 minutes max. Then I have everything I need to ship your app.

### Then on Patrick's side (~5 minutes)

- [ ] Accept the Admin invitation Apple sends to `patricksj@hotmail.com`
- [ ] Confirm you can see the customer's account in App Store Connect
- [ ] Update tenant_config: `apple_admin_added_at = now()`

---

## Day 5 — Founder Onboarding Video Call (every customer)

**Target trigger:** The onboarding state machine opens the Day-5 appointment
requirement and FGA offers eligible fixed-availability slots. The booking
surface and Telnyx coordination remain disabled unless the exact tenant,
identity, availability policy, booking-surface, and activation gates all pass.

**Duration:** 30 minutes.

### Pre-call prep (~5 minutes)

- [ ] Pull up their branded app in TestFlight (Path A or B — both
      reach TestFlight by Day 4-5)
- [ ] Open the admin Clients page for them — confirm modules wired,
      first content draft generated, brand colors applied
- [ ] Test-fire the wizard's `onboarding-state` endpoint to see
      what stage they're at; usually 'in_app_intake_complete' by now
- [ ] If they had skipped optional wizard steps (photo seed, voice,
      etc.), make a mental note to revisit on the call

### Call agenda — 30 minutes

| Time | Topic | Notes |
|---|---|---|
| 0:00–0:05 | Personal welcome + "here's why we built this" — your origin story, the bet on small service businesses |
| 0:05–0:15 | Live walkthrough of their branded app on TestFlight: show home, content approval queue, lead pipeline, where to upload photos |
| 0:15–0:20 | Pull up first auto-generated content draft; talk through how the system uses their seed photos + voice samples. Have them approve one live. |
| 0:20–0:25 | Demonstrate one full flow end-to-end: simulate a lead come in (use your own phone to text their Twilio number); they see speed-to-lead text auto-fire; show the follow-up sequence |
| 0:25–0:30 | Set expectations: weekly digest email, in-app push for approvals, how to reach you. "Anything you didn't fill out in the wizard, the system will gently prompt you for from the home screen — there's no rush." |

### Post-call (~3 minutes)

- [ ] Mark `tenant_config.onboarding_stage = 'founder_call_complete'`
      (or use admin UI button when shipped)
- [ ] Patrick health-score: green by default; flag yellow only if
      something felt off during the call
- [ ] Add the customer to your "first 5 customers — capture friction
      notes" list for the launch-readiness audit

---

## When things go wrong

| Scenario | What to do |
|---|---|
| Customer can't get past Apple's enrollment form | Switch them to Path A (Managed) via `POST /api/admin/clients/:id/switch-path` body `{ "delivery_path": "managed" }`. Their branded app ships under FGA's developer account; we eat the 4.2.6 differentiation risk. |
| Customer forgot to add you as Admin within 5 days of Apple approval | Send a fresh nudge with the exact 2-tap link. If still no response, escalate the call to "I'll do a quick screenshare to walk you through it." |
| Customer wants to delay the Day-5 call past Day 10 | Fine. Continue auto-completing their setup; the call is for the personal touch + customer-success, not a blocker. Adjust the agenda when they do schedule it (skip "welcome", lean harder on "anything you've struggled with"). |
| Customer churns post-Day-5 | Send 1 save email + 1 save SMS within 24h. If no response, let `customer.subscription.deleted` webhook flip them to the cancellation auth-gate gracefully. |
