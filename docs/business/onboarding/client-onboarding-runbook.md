# FGA Client Onboarding Runbook (v1, 2026-05-15)

The exact step-by-step procedure for taking a new FGA client from
"contract signed" to "live in 7 days." This document is the source of
truth — future Claude sessions and future hires read this and execute.

---

## Pricing & Cost Allocation

| Item | Amount |
|---|---|
| Client setup fee (one-time) | **$1,000** |
| Apple Developer Program (annual, per client) | **$99** (paid by FGA, deducted from setup fee margin) |
| Net contribution from setup fee | **$901** first year, **$1,000** thereafter (FGA renews annually) |

The $99 Apple fee comes out of FGA's setup-fee margin. Customer does
not see it as a line item.

## Module 8 (Branded Mobile App) — Distribution Model

**Decided 2026-05-15:** Each client gets a real App Store app submitted
under that **client's own Apple Developer account**, with FGA enrolled
as the managed developer/team member on that account. This path:

1. Sidesteps App Store Review Guideline 4.2.6 ("commercialized template
   service") because each app is submitted by the legitimate content
   provider (the customer).
2. FGA controls all builds, deploys, and updates via team-developer
   access on the customer's account.
3. Customer cancels FGA subscription → app auth-gate flips at the
   backend → app shows "Subscription ended" screen on next launch.
   App stays in the customer's developer account (which they own), but
   the running app loses its tenant data and functionality.

This is the "sticky moat" — losing the FGA subscription means their
crew can't open the real branded app on their home screen anymore.

---

## The 7-Day Timeline (At a Glance)

| Day | Track A: Apple Developer | Track B: App Build | Track C: Platform Modules |
|---|---|---|---|
| 0 | Enrollment kicked off | Asset generation pipeline runs | Tenant provisioned |
| 1 | Enrollment pending | Build branded app, TestFlight | Lead Capture / CRM / Speed-to-Lead config |
| 2 | Enrollment usually approved | Customer tests TestFlight build | Content Engine seeds, Review module wired |
| 3 | (idle) | App Store Connect listing created, submitted for review | Follow-Up / Referral / Prospecting wired |
| 4 | (idle) | Apple App Store review in progress | All Day-1 modules verified working |
| 5 | (idle) | App approved + live in App Store | **Founder onboarding video call** |
| 6 | (idle) | Customer downloads from real App Store | First content posts queue up |
| 7 | (idle) | (live) | **All modules live, customer in "Active" state** |

All three tracks run in parallel. Track A (Apple) is the long-pole
dependency but is mostly idle waiting — no FGA work blocks on it.

---

## Day 0 — Contract Signed, Setup Fee Paid

### Triggers (all automated via Stripe webhook → backend)

1. Stripe webhook fires `checkout.session.completed` for the $1,000 setup fee
2. Backend creates row in `tenants` with `status = 'onboarding'`
3. Backend creates `agent_jobs` row: `agent='onboarding-advance', day=0`
4. Backend sends welcome email with one-page mobile-friendly intake
   URL (the **web-mobile intake** — see `mobile-onboarding-flow.md`
   for the in-app continuation path)

### Welcome email contents

- "You're in. Here's what happens next."
- 7-day timeline visual (this same table)
- Mobile-friendly intake link (5-min essentials only)
- What to expect on Day 5 (founder video call — calendar link)

### Customer fills the **5-minute essentials intake**

Captured on the marketing site at `/onboarding?client_id=<uuid>`. The
form is mobile-optimized (it's expected most submissions come from
phones). Fields:

- Business name (legal name as filed for LLC/sole prop)
- Owner full name + role
- Email + mobile number
- Service area (city/zip)
- Vertical (HVAC/Plumbing/Electrical/Roofing/Tree Service/Cleaning/Other)
- "Do you have a Google Business Profile?" (Y/N/unsure)
- "Do you have a Facebook Page + Instagram Business account?" (Y/N/unsure)
- Apple Developer enrollment readiness: legal entity name, signing
  authority's full name, business phone, **D-U-N-S number if available**
  (most small businesses don't have one; Apple will issue one for free
  during enrollment but it adds 1-2 days)

The rest of the intake — brand colors, logo upload, photo seed,
voice samples, customer list, etc. — happens **in their TestFlight
branded app** starting Day 2 (see `mobile-onboarding-flow.md`).

### What FGA does on Day 0 (in parallel)

| Track | Action | Owner |
|---|---|---|
| A | Send Apple Developer Program enrollment instructions to customer (separate email) | Backend automation |
| A | Schedule follow-up call to walk customer through enrollment portal | Founder calendar block |
| B | Asset gen pipeline triggers: Claude generates app icon, splash, store screenshots, listing copy from intake data | Automated (see `app-pipeline.md`) |
| C | Tenant provisioning: apply vertical preset, configure Twilio number, configure Buffer placeholder | Automated |
| C | Module config: enable Growth/Scale modules per contract | Automated |

---

## Day 1 — Apple Enrollment Pending, App Build Begins

### Track A — Apple Developer Program (customer-facing)

Customer follows instructions email to enroll at
[developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll).

**What customer provides:**
- Legal business name (must match LLC/EIN paperwork exactly)
- D-U-N-S number (or request one during enrollment — adds 1-2 days)
- Apple ID for the business (recommend `apps@<theirdomain>` if they have a domain, else personal Apple ID is fine for sole props)
- $99 payment method — **FGA pays this with FGA's card during the call** to keep timeline tight (the $99 is deducted from setup fee margin per pricing table above)

**What FGA does during the call (~20 min):**
- Walk customer through the enrollment form (screen-share)
- Confirm legal name matches their EIN/LLC paperwork
- Enter D-U-N-S or request one
- Pay the $99 with FGA's card (customer reimbursement is already baked into setup fee)
- After enrollment goes pending: customer adds FGA's Apple ID
  (`patricksj@hotmail.com`) as an **Admin** under their team via
  Users and Access in App Store Connect

**Approval timeline:** Apple typically approves business enrollments
in 24–48 hours. D-U-N-S requested same-day adds 1–2 days. Set
expectation: "Track A is the long pole — we're working in parallel."

### Track B — App Build (FGA-side)

Once asset gen finishes (auto-triggered Day 0):

1. **Verify assets** — Claude runs `scripts/app-pipeline/audit-426-compliance.js`
   (see `app-pipeline.md`). Confirms:
   - Icon is genuinely different from FGA + other tenants
   - Screenshots show tenant-specific data (not template lorem ipsum)
   - Listing copy mentions customer's actual business name, services, location
   - Privacy URL exists and resolves
2. **Patch build config** — Claude runs
   `scripts/app-pipeline/patch-build-config.js` with tenant ID. This
   updates `app.json`, bundle ID, app name, color tokens.
3. **Archive + upload to TestFlight** — follow the
   `fga-testflight-deploy` skill exactly. Bundle ID is now
   `com.<theircompany>.app`, not `com.firstgenautomate.app`.
4. **Invite customer to TestFlight** — they get an email with the
   TestFlight code, install on their phone.

### Track C — Platform Modules (Day-1 enables)

All Day-1 modules go live by end of Day 1:

| Module | Setup |
|---|---|
| Lead Capture & CRM | Auto-provisioned with tenant |
| Speed-to-Lead | Twilio number live, SMS templates loaded from vertical preset |
| Missed Call Text-Back | Call forwarding instructions sent to customer (forward existing # to new Twilio #) |
| Follow-Up Sequences | Templates loaded from vertical preset |
| Lead Scoring | Rules loaded from vertical preset |
| Referral Engine | Customer list import (if provided in intake) |
| Referral Partner Outreach | Partner list import (if provided) |
| Content Engine | Brand colors / logo placeholder until in-app upload completes |
| AI Chat Agent | Widget script ready to embed on DFY site |

---

## Day 2 — Customer Tests TestFlight, In-App Onboarding Begins

### Track B — Customer in TestFlight

Customer opens their branded app for the first time. App auto-detects
this is first launch + onboarding is incomplete → routes to
**in-app onboarding wizard** (see `mobile-onboarding-flow.md` for the
detailed UX flow).

### Track C — In-App Onboarding Captures

Through the in-app wizard, customer provides on Day 2-3:

- Logo upload (take a photo of their truck or business card if they
  don't have a logo file — Gemini cleans it up)
- Brand color picker (or auto-extract from logo)
- Photo seed: select 20+ photos from camera roll for initial content gen
- Brand voice samples: 3 short sentences in their voice
- Google Business Profile claim status + URL (if claimed)
- Facebook Page + Instagram handle (or "I don't have these yet")
- Customer list import (paste CSV or sync from existing tool)

Each step auto-saves to `tenant_config`. Backend agents pick up new
data and run accordingly.

### Track A — Apple Enrollment Often Approves Today

Backend monitors enrollment status via App Store Connect API (or
manual founder check) — flips tenant flag `apple_developer_approved =
true` when ready.

---

## Day 3 — App Store Listing Submitted, Modules Wired

### Track B — Submit to App Store

Once Apple Developer enrollment is approved + FGA is added as Admin:

1. **Create App Store Connect listing** — Claude runs
   `scripts/app-pipeline/submit-app-store-listing.js` which uses the
   App Store Connect API to create the app record with all metadata,
   screenshots, age rating, category, privacy URL, and support URL.
2. **Submit for review** — same script triggers submission via API
   (or Patrick does it manually via App Store Connect UI as fallback).

**Listing must clear pre-flight 4.2.6 audit before submission.**

### Track C — Remaining Modules

| Module | Setup |
|---|---|
| Content Approval & Scheduling | Buffer OAuth — customer connects FB Page + IG Business via in-app deep link |
| Review Requests | Google Business Profile URL captured Day 2 — review templates load |
| Social Engagement Agent (Scale only) | Meta Graph API connection — requires FGA's approved Meta app (verify before launch) |
| Prospecting Engine | Resend domain verification — customer adds DNS TXT records (instructions sent via app + email) |
| Done-For-You Website | Build starts using intake data. Subdomain (`<theirname>.firstgenautomate.com`) live by end of day. Custom domain DNS handover separate. |

---

## Day 4 — Apple Review in Progress

### Track B — Waiting on Apple

Apple App Store review is in progress. Average wait is 24–48 hours
from submission.

**If Apple rejects:**
- Most common rejections: missing privacy URL details, screenshots
  showing placeholder data, missing demo account credentials
- Claude immediately diagnoses rejection reason, fixes, resubmits
- Resubmission re-enters review queue (typically faster than first
  submission — 12–24 hours)
- 7-day SLA still achievable if rejection comes back Day 4 with
  resubmit + approval Day 5

### Track C — Verification Pass

By end of Day 4:
- All enabled modules have live data flowing
- Speed-to-Lead tested with a manual test SMS
- Follow-Up sequence triggered with a test lead
- Content Engine has generated at least 1 draft in customer's voice
- Review Request template populates with real GBP URL
- Buffer cross-post works (test post drafted, not sent)

**Pre-launch checklist:** see Day 7 section below.

---

## Day 5 — Founder Onboarding Video Call

This is the premium touchpoint. 30 minutes, scheduled via Cal.com link
sent in Day 0 welcome email.

### Agenda (30 min)

| Time | Topic |
|---|---|
| 0:00–0:05 | Personal welcome, "here's why we built this" |
| 0:05–0:15 | Live walkthrough of their branded app (TestFlight build or App Store if approved) |
| 0:15–0:20 | Show first auto-generated content draft, customer approves |
| 0:20–0:25 | Demonstrate one full flow end-to-end (e.g. test lead → speed-to-lead text → follow-up) |
| 0:25–0:30 | Set expectations: weekly digest email, in-app notifications for approvals, how to reach support |

### Post-call automated actions

- Tenant status flipped: `onboarding` → `onboarding_call_complete`
- Founder marks "call done" in management app
- Account health score initialized to "Green"

---

## Day 6 — App Live (Hopefully), Content Posts

### Track B — App approved by Apple

Best case: Apple approved Day 4-5, app live in App Store by Day 6.

Customer's App Store Connect listing is now **public**. Customer is
encouraged to download from real App Store (their TestFlight build
still works for ongoing testing).

### Track C — First Real Content Posts

- First approved content posts go live via Buffer
- First scheduled review request sends to a recent customer
- Prospecting engine has discovered first batch of local prospects
  (visible in their pipeline tab)

---

## Day 7 — Active

Tenant flipped to `status = 'active'`. Account management system takes
over from onboarding. Customer receives:

- "You're live — here's what's running for you" email
- 2-week check-in scheduled (automated)
- 30-day check-in scheduled (automated)

### Day-7 Live Verification Checklist

Before the tenant is flipped to `active`, verify:

- [ ] Branded app is live in App Store (or TestFlight if Apple delayed)
- [ ] Twilio number is registered and sending SMS
- [ ] At least 1 piece of content has been approved + posted
- [ ] First lead has gone through speed-to-lead flow (use customer's
      own phone as a test lead if no real leads yet)
- [ ] Buffer is connected to their FB Page + IG Business
- [ ] Google Business Profile URL is captured + review template active
- [ ] DFY website is live on subdomain (custom domain DNS may still pend)
- [ ] AI Chat Agent widget is rendering on their site (if DFY site live)
- [ ] All Scale-tier modules verified working (if Scale tier)
- [ ] Founder onboarding call completed
- [ ] Stripe subscription is on auto-renewal

---

## Cancellation Flow (Subscription Ends)

Triggered by Stripe webhook `customer.subscription.deleted`:

1. Backend updates `tenants.status = 'cancelled'` and
   `tenants.subscription_ended_at = now()`
2. App's auth endpoint immediately rejects the customer's tenant
3. Next time the customer opens their branded app, they see the
   **subscription-ended screen** (already implemented in `App.js`):
   "Your FGA subscription has ended. Contact support@firstgenautomate.com
   to reactivate."
4. App is NOT removed from App Store (it belongs to the customer's
   Apple Developer account)
5. Tenant data is retained for **90 days** in case of reactivation
6. After 90 days: tenant data is archived/deleted per privacy policy
7. After cancellation: FGA continues to renew the $99 Apple Developer
   fee for **12 months** in case customer reactivates. After 12 months,
   FGA notifies customer their Apple Developer account renewal is up
   to them.

---

## Section 4.2.6 Compliance — Pre-Submission Audit

Every app submission runs `scripts/app-pipeline/audit-426-compliance.js`
which verifies the app would not be flagged as a "commercialized
template." Required differentiation:

| Differentiator | Required value |
|---|---|
| App icon | Customer-specific (NOT FGA logo, NOT generic mark) |
| App name in store | Customer's business name (NOT "FGA App" or similar) |
| Screenshots | Show real customer tenant data (NOT placeholder content) |
| Listing copy | Mentions customer's actual services + location |
| Privacy URL | Resolves to a privacy policy that names the customer's business |
| Support URL | Resolves to a customer-specific support page (can be hosted on FGA infra) |
| Bundle ID | `com.<customerdomain>.app` pattern (NOT a FGA-prefixed clone) |
| Developer account | Customer's own Apple Developer account (NOT FGA's account) |

Submission BLOCKS if any check fails. Manual override requires founder
approval + documented justification.

---

## Apple Developer Fee Accounting

| Event | Amount | Notes |
|---|---|---|
| Customer signs ($1,000 setup) | +$1,000 | Stripe charges, FGA receives |
| FGA pays Apple ($99 on customer's behalf) | -$99 | Charged to FGA card during Day 1 enrollment call |
| Net first-year contribution | +$901 | After Apple fee |
| Year 2+ renewal | -$99 / year | Auto-renews on FGA card, recorded as cost-of-goods per tenant |

Bookkeeping: $99 Apple Developer fees are categorized as "Per-Client
Infrastructure Cost" alongside Twilio number rental, Resend domain,
etc. Margin per client tracking subtracts these from MRR.

---

## Forward Reference — Mobile-Native Onboarding

The above timeline assumes some intake happens via web (Day 0
5-minute essentials) and the rest in-app (Day 2-3 wizard). For the
detailed UX flow of the in-app wizard — including screen-by-screen
designs, what data is captured where, and how the app handles
"onboarding incomplete" state — see:

**`/docs/business/onboarding/mobile-onboarding-flow.md`**

---

## Forward Reference — Automated App Pipeline

The asset generation, build config patching, App Store Connect
listing creation, and 4.2.6 compliance audit are all driven by
scripts in `/scripts/app-pipeline/`. For the build/deploy procedure
on Patrick's Mac, see the `fga-testflight-deploy` skill. For pipeline
internals, see:

**`/docs/business/onboarding/app-pipeline.md`** (TODO — build in
progress 2026-05-15)
