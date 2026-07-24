> ⚠️ **PARTIALLY SUPERSEDED (2026-07-03 decision).** This doc predates the correction that
> onboarding is a WEB form at firstgenautomate.com/onboarding via magic link — there is NO
> setup wizard inside any app, and the customer has no branded app at Day 0. Ignore any
> in-app-wizard language below. Authoritative flow: `onboarding-wizard-flow.md` (v4).

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

**Corrected 2026-07-03 (supersedes the 2026-05-15 "in-app intake"
decision):** Onboarding intake is a **WEB form** at
`firstgenautomate.com/onboarding`, reached by a magic link in the
welcome email. There is **NO setup wizard inside any app**, and the
customer has **no branded app yet at Day 0** — we build it in the first
few days and they download it after go-live. Do not write "install the
app / open in the app / finish the wizard in the app" onboarding copy.
("Open the app / approve from the app" is correct only for POST-go-live
day-to-day use.)

### Triggers (all automated via Stripe webhook → backend)

1. Stripe webhook fires `checkout.session.completed` for the $1,000 setup fee
2. Backend creates row in `tenants` with `status = 'onboarding'`,
   pre-populated with the Stripe email
3. Backend creates Supabase auth user (random initial password — user
   logs in via magic link, not password)
4. Backend generates Supabase magic link with redirect to
   `https://www.firstgenautomate.com/onboarding/start` (web form)
5. Backend sends welcome email via Resend
6. Backend queues `agent_jobs` row: `agent='onboarding-advance', day=0`

### Stripe Checkout Success Page

After Stripe redirects post-payment, the marketing site shows a thank-
you page that does ONE thing: tells them to check their email.

```
Welcome to FGA ✓
Your payment is confirmed.
Check your email — within a few minutes you'll get a one-tap link to
your setup form. It opens in your browser and takes about 15 minutes.
```

Just "check your email." The setup form is on the web.

### Welcome Email Contents (web form)

Rendered from `templates/emails/welcome-wizard.html`, sent by
`core/welcome-wizard.js`. ONE magic link to the web form — no app path
(there is no in-app wizard, and no branded app exists yet at Day 0).

```
Subject: Welcome to First Gen Automate

Hi {{owner_name}},

One short form and we're moving. It takes about 15 minutes, all in your
browser. This is where you tell us the basics about {{business_name}}.

  [ Open your setup form ]   → magic link to /onboarding/start

Opens in your browser on any device. Pause and pick back up anytime,
it saves as you go.

Once you finish, we get to work: we build your setup, your done-for-you
website, and your own branded app. You'll get it to download in the
first few days, and that's where you'll run everything day to day.

Talk soon,
Patrick
First Gen Automate

P.S. This link expires in 7 days. Reply if you need a fresh one.
```

A welcome SMS may go out at the same time with the same web setup-form
link — phone-first customers often check texts before email.

### Onboarding Wizard — Web Only

The wizard is a web form at `firstgenautomate.com/onboarding`. There is
no in-app wizard. It is resumable across devices (start on your phone's
browser, finish on a laptop, no data lost) because state is server-side.

The wizard is also **module-aware** — it only shows the steps
relevant to the modules the customer bought during the sales call.
A customer with no content modules doesn't get the photo-seed step.
A customer without Review Requests doesn't get the Google Business
Profile step.

See `onboarding-wizard-flow.md` for the full step-by-step UX and the
module-to-step relevance matrix. Steps captured can include:

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
| C | Supabase auth user created via `core/welcome-wizard.js → ensureAuthUser()` with `app_metadata.tenant_id` + `role: 'client_owner'` (required for RLS — see "Tenant Isolation" section below) | Automated | Immediately on Stripe webhook |
| C | Module config: enable Growth/Scale modules per contract | Automated | Immediately on Stripe webhook |
| — | Welcome email sent with App Store link + magic login link | Automated | Immediately on Stripe webhook |
| A | (Path B only) Apple enrollment email — customer replies with 2-3 time options to schedule the Day-1 call | Triggered by wizard Step 3 | When customer picks Full Ownership |
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
**in-app onboarding wizard** (see `onboarding-wizard-flow.md` for the
detailed UX flow).

### Track C — Onboarding Form Captures

Through the web onboarding form, customer provides on Day 2-3:

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
| Content Approval & Scheduling | Buffer OAuth — customer connects FB Page + IG Business from the web onboarding form |
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

This is the premium touchpoint. 30 minutes. The target workflow offers
Patrick-approved fixed-availability slots through the FGA booking surface,
records the appointment in the canonical FGA ledger, and coordinates
confirmation, reminders, rescheduling, cancellation, preparation, and
follow-up through the tenant's verified Telnyx identity. It does not read or
write an external calendar. Requests outside policy become owner exceptions;
Patrick does not coordinate routine appointment times.

Until the calendarless workflow receives consolidated production approval,
the deployed reply-to-email path remains unchanged for backward compatibility.
Do not enable the new invitation or messaging path for an active tenant merely
because the code exists.

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
- [ ] **Tenant isolation verified** (see "Tenant Isolation Verification" section below). On a fresh login the banner reads <span style="color:#ca8a04">REAL CLIENT · &lt;business name&gt;</span>, NOT yellow REAL CLIENT with the wrong name, NOT red FGA PLATFORM ADMIN, NOT green DEMO.

---

## Tenant Isolation — How New-Client Provisioning Stays Safe

This section locks in the contract between onboarding and the cross-tenant isolation system shipped 2026-05-26. Anyone editing `core/welcome-wizard.js`, `api/routes/admin.js → onboard-tenant`, or the Stripe `checkout.session.completed` handler needs to keep these guarantees intact.

### What every new client's auth user MUST have

When a new tenant is provisioned (admin manual OR Stripe-paid), the Supabase auth user gets created with these fields. **All four are non-negotiable** — if any is missing, the new client's first login will fail at RLS:

| Field | Value | Why it matters |
|---|---|---|
| `app_metadata.tenant_id` | The new tenant's UUID | Every RLS policy on every tenant-scoped table reads this claim. NULL = the database refuses all queries the user makes. |
| `app_metadata.role` | `'client_owner'` | Server-side gating distinguishes platform_owner (Patrick) from client_owner (paying customers) from worker (crew on a client's account). The frontend banner colors key on this. |
| `user_metadata.business_name` | The customer's business name | Powers the tenant-identity banner. Without it the banner says "Unknown Tenant" which makes the operator stop trusting the UI. |
| `user_metadata.owner_name` | The owner's full name | Used in greeting copy across the portal. Non-critical for isolation but required by templates. |

These are set automatically by `core/welcome-wizard.js → ensureAuthUser()`. Both the admin manual path (`POST /api/admin/onboard-tenant`) and the Stripe paid path (`checkout.session.completed` handler in `integrations/stripe.js`) call this helper. **Do not bypass it.**

### What the `tenants` row MUST have

| Column | Value | Why |
|---|---|---|
| `id` | UUID | Used as `tenant_id` everywhere |
| `slug` | unique slug (NOT starting with `demo-`) | Anything starting with `demo-` triggers the green DEMO banner. Real clients must NOT use this prefix. |
| `is_demo` | `false` | Belt-and-suspenders with the slug check |
| `status` | `'onboarding'` then `'active'` after Day-7 verification | Routes can gate on this |
| `owner_email` | matches the auth user's email | The wizard de-dupes by `owner_email` to prevent accidental duplicate provisioning |

### Day-7 isolation verification (concrete steps)

Before flipping the tenant to `status='active'`:

1. **Log into the new client's portal** (use the magic link from the welcome email in an incognito window — don't log in as the admin).
2. **Check the banner at the top of every page** — it must read <span style="color:#ca8a04">REAL CLIENT · &lt;business name&gt;</span> in yellow. If you see:
   - **Green DEMO** → the slug is wrong (starts with `demo-`) or `is_demo=true` was set by mistake. Fix the `tenants` row, then re-login.
   - **Red FGA PLATFORM ADMIN** → the auth user was created with `role: 'platform_owner'`. Fix `app_metadata.role` via Supabase admin → re-login.
   - **Yellow REAL CLIENT but wrong name** → `user_metadata.business_name` is wrong or missing. Fix via Supabase admin → re-login.
3. **Add a test customer** from the Customers tab. Refresh. The new customer should appear. If the button "succeeds" but the row doesn't appear → `is_demo` got set true on the tenant (demoWriteGuard is mocking writes). Fix `tenants.is_demo = false` → retry.
4. **Open Reports → Income**. Add an income entry for $1. Refresh. Should appear. If it doesn't, JWT is malformed.
5. **Log in as Patrick (admin) in a separate browser**. Open Reports for FGA's own tenant. Confirm the test customer + income entry from the new client are NOT visible. They shouldn't be — admin sees only FGA's tenant unless explicitly viewing a tenant via `/api/admin/clients/:id`. If you see cross-tenant data, treat as a P0: file an issue, do not flip the tenant to active.

### How to fix a misconfigured auth user (rare)

If the welcome wizard ran but somehow `app_metadata.tenant_id` is missing, run this in a Node REPL with `SUPABASE_SERVICE_KEY` loaded:

```js
const { getServiceClient } = require('./db/client');
const db = getServiceClient();
const userId = '<paste the auth user UUID>';
const tenantId = '<paste the tenant UUID>';
await db.auth.admin.updateUserById(userId, {
  app_metadata: { tenant_id: tenantId, role: 'client_owner' },
});
```

Then have the customer log out and log back in (the JWT refreshes on next login).

### What NEVER changes during onboarding

- **Service-role key (`SUPABASE_SERVICE_KEY`)** stays on the server, never in the customer's app/browser. Workers and admin endpoints use it; customer-facing endpoints do not.
- **`/api/admin/*`** routes are NEVER accessible to a client_owner JWT. Server-side `adminMiddleware` rejects with 403.
- **`/api/tenant/*`** and `/api/finance/*` routes use `getUserClient(req)` (the per-request user-JWT client). RLS policies enforce that the JWT's tenant_id matches every row queried or written. A client_owner JWT pointing at Tenant A can never see Tenant B's data even if a future bug forgets to filter.

### Reference: full isolation architecture

The complete tenant isolation audit, with the 4-layer defense model, route inventory, and RLS state matrix, lives at `~/Desktop/FGA/audit/tenant-isolation.html`. Read it once before onboarding the first paying customer.

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

## Forward Reference — Web Onboarding Wizard

The onboarding intake happens through a module-aware wizard that runs
as a **web form** at `firstgenautomate.com/onboarding` (no in-app
wizard). For the full UX flow, the module-to-step relevance matrix, the
state machine, and the backend API contract — see:

**`/docs/business/onboarding/onboarding-wizard-flow.md`**

For the engineering plan covering both platforms (mobile wizard
screens, web wizard refit of OnboardingPortal.tsx, shared backend
endpoints), see:

**`/docs/business/onboarding/wizard-build-spec.md`**

---

## Forward Reference — Automated App Pipeline

The asset generation, build config patching, App Store Connect
listing creation, and 4.2.6 compliance audit are all driven by
scripts in `/scripts/app-pipeline/`. For the build/deploy procedure
on Patrick's Mac, see the `fga-testflight-deploy` skill. For pipeline
internals, see:

**`/docs/business/onboarding/app-pipeline.md`** (TODO — build in
progress 2026-05-15)
