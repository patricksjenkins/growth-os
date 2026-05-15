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

## Module 8 (Branded Mobile App) — Two-Path Distribution Model

**Decided 2026-05-15:** Customers choose between two paths for how
their branded iOS app is published. Same product, same price, same
end-user experience — different ownership model and different first-
week effort. See `path-choice.md` for full trade-offs.

### Path A — Managed (FGA Developer Account)
- App published under FGA's Apple Developer account
- Bundle ID pattern: `com.firstgenautomate.<tenant_slug>`
- Customer never touches Apple
- Live in **3–5 days**
- Customer-facing name: "Quick Start"
- 4.2.6 risk: real but managed via `audit-426-compliance.js`
  enforcement of differentiated icon, name, screenshots, copy, URLs

### Path B — Owned (Customer's Developer Account)
- App published under customer's own Apple Developer account
- Bundle ID pattern: `com.<tenant_slug>.app`
- FGA enrolls as Admin and does all work after Day 1
- Live in **5–7 days** (adds Apple business-verification wait)
- Customer-facing name: "Full Ownership"
- $99/yr Apple fee paid by FGA from setup-fee margin
- Customer bears one 25-minute enrollment call on Day 1

### Path is captured Day 0 in `tenant_config.delivery_path`

Default: `managed` (Path A). The intake form on the marketing site
defaults to "Quick Start" with "Full Ownership" as the alternate
choice. Customer can switch within 30 days at no charge.

### Both paths produce identical outcomes

1. Customer has a real branded App Store app under their business name
2. App shows their tenant data, their content, their leads
3. FGA controls the binary and ships updates
4. Customer cancels subscription → app auth-gate flips backend-side →
   app shows "Subscription ended" screen on next launch

The "sticky moat" works for both paths: cancelling means their crew
can't open their real branded app anymore. Path A is slightly
stickier (FGA can also remove the binary from the App Store); Path B
preserves the customer's bundle in their own account but renders it
non-functional.

---

## The 7-Day Timeline (At a Glance)

### Path A (Managed / Quick Start) — 3–5 days to branded app

| Day | Track 0: Wizard | Track A: Apple | Track B: Branded App Build | Track C: Platform |
|---|---|---|---|---|
| 0 | Customer logs into FGA app via magic link, completes wizard | — | Asset gen triggers at Step 8 | Tenant provisioned |
| 1 | (intake complete) | — | Patch + build + TestFlight upload of branded app | Day-1 modules wired |
| 2 | (using FGA app) | — | Customer tests branded TestFlight build | Content seeds, Review wired |
| 3 | (using FGA app) | — | Branded app submitted to App Store | Remaining modules wired |
| 4 | (using FGA app) | — | Apple review of branded app | All modules verified |
| 5 | (using FGA app) | — | Branded app approved + live | **Founder onboarding call** |
| 6 | (using FGA app) | — | Customer installs branded app from App Store | First posts queue |
| 7 | (using branded app) | — | (live) | **Active** |

Path A's Track A is empty — no Apple Developer enrollment is needed
because FGA's account is already established. The customer uses the
shared FGA app from Day 0 while their branded app is being built.

### Path B (Owned / Full Ownership) — 5–7 days to branded app

| Day | Track 0: Wizard | Track A: Apple Developer | Track B: Branded App Build | Track C: Platform |
|---|---|---|---|---|
| 0 | Customer logs into FGA app, completes wizard. At Step 3 picks Full Ownership → schedules Day-1 call | Call scheduled | Asset gen triggers at Step 8 | Tenant provisioned |
| 1 | (intake complete) | **25-min enrollment call** | Build branded app | Day-1 modules wired |
| 2 | (using FGA app) | Apple business verification pending | Customer tests branded TestFlight | Content seeds, Review wired |
| 3 | (using FGA app) | Apple approves + customer adds Patrick as Admin | Branded app submitted | Remaining modules wired |
| 4 | (using FGA app) | (idle) | Apple App Store review | All modules verified |
| 5 | (using FGA app) | (idle) | Branded app approved + live | **Founder onboarding call** |
| 6 | (using FGA app) | (idle) | Customer installs branded app from App Store | First posts queue |
| 7 | (using branded app) | (idle) | (live) | **Active** |

All tracks run in parallel. The customer uses the shared FGA app
through the whole window. When their branded app ships on Day 5-6,
they install it from the App Store and have both apps available
(same backend, same data, same login). Most customers switch to the
branded one because it looks like theirs.

---

## Day 0 — Contract Signed, Setup Fee Paid

**Decided 2026-05-15:** Onboarding intake happens **entirely inside
the FGA mobile app**, not on the marketing site. The customer's first
interaction with the product IS the product itself.

### Triggers (all automated via Stripe webhook → backend)

1. Stripe webhook fires `checkout.session.completed` for the $1,000 setup fee
2. Backend creates row in `tenants` with `status = 'onboarding'`,
   pre-populated with the Stripe email
3. Backend creates Supabase auth user (random initial password — user
   logs in via magic link, not password)
4. Backend generates Supabase magic link with redirect to
   `fga://onboarding-start`
5. Backend sends welcome email via Resend
6. Backend queues `agent_jobs` row: `agent='onboarding-advance', day=0`

### Stripe Checkout Success Page

After Stripe redirects post-payment, the marketing site shows a thank-
you page that does ONE thing: tells them to check their email.

```
Welcome to FGA ✓
Your payment is confirmed.
Check your email — within a few minutes you'll get:
  1. A link to download the FGA app
  2. A one-tap login link
Takes about 15 minutes once you're in the app.
```

No web form. No web onboarding portal. Just "check your email."

### Welcome Email Contents

```
Subject: Your FGA system — log in and let's get you set up

Hi there,

Two steps and you're moving:

  1. Download the FGA app
     [App Store link to FGA shared app]

  2. Tap this link to log in
     [magic-link URL, valid 7 days]

That's it. The app will walk you through getting your business
set up — about 15 minutes. Pause and pick back up anytime.

Talk soon,
Patrick
First Gen Automate

P.S. The login link expires in 7 days. Reply to this email if
you need a fresh one.
```

### In-App Onboarding Wizard

When the customer downloads the FGA app and taps the magic link, the
app authenticates them, recognizes their tenant is in onboarding
state, and routes to the **12-step OnboardingWizardScreen**.

See `mobile-onboarding-flow.md` for the full 12-step wizard map. The
wizard captures everything that used to be in the web intake form,
plus the new fields:

- Business basics (name, vertical, address, hours, phone)
- **Delivery path choice** (Quick Start vs Full Ownership) — Step 3
- **Apple details** if Full Ownership chosen (legal entity, DUNS) — Step 3a
- Logo upload (camera or library)
- Brand colors (auto-suggested from logo)
- Photo seed (20+ from camera roll for content gen)
- Brand voice samples
- Services + hours
- Google Business Profile URL
- Facebook + Instagram OAuth connect
- Customer list import (CSV or Gmail)

Each step auto-saves on completion. Customer can close the app and
resume any time within the 7-day onboarding window.

### What FGA does on Day 0 (in parallel)

The path choice happens IN-APP at Step 3 of the wizard, not Day 0. So
Track A (Apple enrollment) waits until the customer reaches Step 3 of
the wizard and picks Path B. Most customers will finish the wizard in
Day 0 itself; some will spread it across 1-2 days.

| Track | Action | Owner | When |
|---|---|---|---|
| C | Tenant provisioning + vertical preset + Twilio number + Buffer placeholder | Automated | Immediately on Stripe webhook |
| C | Module config: enable Growth/Scale modules per contract | Automated | Immediately on Stripe webhook |
| — | Welcome email sent with App Store link + magic login link | Automated | Immediately on Stripe webhook |
| A | (Path B only) Apple enrollment email + Cal.com link for Day-1 call | Triggered by wizard Step 3 | When customer picks Full Ownership |
| B | Asset gen pipeline triggers: Gemini icon, Claude listing copy | Triggered by wizard Step 8 (services captured) | When customer has filled enough intake |

The asset gen pipeline now triggers AFTER Step 8 instead of
immediately at Stripe webhook — because we need the customer's
business name, vertical, services, and brand colors first, all
captured in-wizard.

---

## Day 1 — Apple Enrollment (Path B only), App Build Begins (Both Paths)

### Track A — Apple Developer Program (Path B only — skip for Path A)

**Path A customers:** no Track A on Day 1. Skip ahead to Track B.

**Path B customers:** Customer follows instructions email to enroll at
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

### Track B — App Build (FGA-side, both paths)

Once asset gen finishes (auto-triggered Day 0):

1. **Verify assets** — Claude runs `scripts/app-pipeline/audit-426-compliance.js
   --tenant <slug> --path <managed|owned>`. Confirms:
   - Icon hash differs from every other app under the same developer account
   - Listing copy mentions customer's business name, vertical, service area
   - Privacy + Support URLs exist and resolve to pages naming the business
   - **Path A** uses **stricter** thresholds (longer copy, harder hash check)
2. **Patch build config** — Claude runs `scripts/app-pipeline/patch-build-config.js
   --tenant <slug> --path <managed|owned>`. This updates `app.json`:
   - **Path A bundle ID:** `com.firstgenautomate.<slug>` (under FGA's account)
   - **Path B bundle ID:** `com.<slug>.app` (under customer's account)
   - App name, version `1.0.0`, build number `1`, per-tenant icon path
3. **Archive + upload to TestFlight** — follow the
   `fga-testflight-deploy` skill. The skill reads the bundle ID and
   team ID from the patched `app.json`, so the same skill works for
   both paths and for FGA's own builds.
4. **Invite customer to TestFlight** — generate a **public TestFlight
   link** and SMS it to them. They tap the link on their phone,
   TestFlight installs the branded app (one tap). For Path B this
   happens once their developer account is approved and FGA is Admin;
   for Path A this happens immediately after build upload.

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

### Path A (Managed) — Customer chose "Quick Start"

| Event | Amount | Notes |
|---|---|---|
| Customer signs ($1,000 setup) | +$1,000 | Stripe charges, FGA receives |
| FGA Apple Developer fee | -$0 | Already covered by FGA's single $99/yr (up to 200 apps) |
| Net first-year contribution | **+$1,000** | No per-customer Apple cost |

### Path B (Owned) — Customer chose "Full Ownership"

| Event | Amount | Notes |
|---|---|---|
| Customer signs ($1,000 setup) | +$1,000 | Stripe charges, FGA receives |
| FGA pays Apple $99 on customer's behalf | -$99 | Charged to FGA card during Day 1 enrollment call |
| Net first-year contribution | **+$901** | After Apple fee |
| Year 2+ renewal | -$99 / year | Auto-renews on FGA card, recorded as cost-of-goods per tenant |

Bookkeeping: Path B $99 Apple Developer fees are categorized as
"Per-Client Infrastructure Cost" alongside Twilio number rental,
Resend domain, etc. Path A has no per-customer Apple cost. Margin per
client tracking subtracts these from MRR — Path B customers have ~$99
lower margin in year one.

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
