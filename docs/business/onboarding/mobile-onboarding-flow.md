# In-App Onboarding Flow (v2, 2026-05-15)

**Decided 2026-05-15:** Onboarding happens **entirely inside the FGA
mobile app**, not on the marketing site. The customer's first
interaction with the product is the product itself.

The web side does ONE thing: takes the customer through Stripe
checkout, then redirects them to a "check your email" page. The email
has a magic-link login + an App Store link to download the FGA app.
Everything from there is in-app.

This document maps the screen-by-screen UX of the in-app wizard.

For the broader 7-day timeline, see `client-onboarding-runbook.md`.
For the delivery-path choice (Quick Start vs Full Ownership) that
gets made during the wizard, see `path-choice.md`.

---

## End-to-End Flow

```
[Marketing site Stripe checkout]
  → email captured by Stripe
  → setup fee paid

[Stripe webhook]
  → backend creates `tenants` row (status='onboarding')
  → backend creates Supabase auth user
  → backend sends welcome email with App Store link + magic link

[Customer's email]
  → 1. "Download the FGA app" (App Store link)
  → 2. "Tap to log in" (magic link, valid 7 days)

[Customer downloads FGA app from App Store]

[Customer taps magic link]
  → opens FGA app via universal link
  → authenticates Supabase session
  → tenant context loaded

[FGA app — first launch with valid session]
  → checks tenant.status + tenant_config.onboarding_stage
  → routes to OnboardingWizardScreen (not HomeScreen)

[OnboardingWizardScreen]
  → 12 steps, resumable, auto-saves to tenant_config per step
  → final step transitions tenant.status to 'onboarding_intake_complete'

[Day 1+]
  → FGA does the per-customer app build per the runbook
  → Customer continues using shared FGA app
  → When their branded app ships (Day 5-7), they install it
  → Same login works in branded app — shared backend
```

The shared FGA app and the customer's branded app are the same
codebase with different bundle IDs and brand styling. Login flows
through Supabase auth and the tenant_id comes from the user record —
so once the branded app exists, the customer can use either.

---

## Day 0 — Stripe → Email → App Install

### What happens on the marketing site

Customer completes Stripe checkout. Stripe Checkout already collects
email; that's all we need at this point. After successful payment,
Stripe redirects to a thank-you page:

```
┌────────────────────────────────────┐
│        Welcome to FGA ✓            │
│                                    │
│  Your payment is confirmed.        │
│                                    │
│  Check your email — within a few   │
│  minutes you'll get:               │
│                                    │
│  1. A link to download the FGA app │
│  2. A one-tap login link           │
│                                    │
│  Open the app, log in, and we'll   │
│  walk you through setup. Takes     │
│  about 15 minutes.                 │
│                                    │
│  Didn't get the email? Check spam  │
│  or reach out at                   │
│  support@firstgenautomate.com      │
└────────────────────────────────────┘
```

No form, no follow-up page. Just "check your email."

### What the backend does (Stripe webhook handler)

```js
// On `checkout.session.completed` for a setup-fee payment:
1. Parse email + payment_intent from the session
2. Create tenant row:
     status: 'onboarding'
     name: <empty — captured in app>
     owner_email: <stripe email>
     stripe_customer_id: <id>
3. Create Supabase auth user:
     email: <stripe email>
     password: <random — they use magic link>
4. Generate Supabase magic link with redirectTo='fga://onboarding-start'
5. Send welcome email via Resend with:
     - App Store link to FGA app
     - Magic link (valid 7 days)
     - Support contact info
6. Queue agent_jobs row: onboarding-advance, day=0
```

### Welcome email template

```
Subject: Your FGA system — log in and let's get you set up

Hi there,

Two steps and you're moving:

  1. Download the FGA app
     [App Store link]

  2. Tap this link to log in
     [magic-link URL]

That's it. The app will walk you through getting your business
set up — about 15 minutes. You can pause and pick back up anytime.

Talk soon,
Patrick
First Gen Automate

P.S. The login link expires in 7 days. If it expires before you
get to it, reply to this email and I'll send a fresh one.
```

---

## In-App Wizard — 12 Steps

The wizard lives at `OnboardingWizardScreen.js` in the mobile app.
First launch with a valid session + `tenant.status='onboarding'`
routes here instead of the home screen.

### Wizard Mechanics

- **Resumable** — close the app, come back tomorrow, pick up at the
  same step
- **Auto-save** — each step writes to `tenant_config` on completion;
  no "save and exit" needed
- **Linear with skip** — most steps are advanceable; some are
  skippable and resurface as soft prompts on the home screen later
- **Progress bar** at the top: "Step 4 of 12 — 33%"
- **Back button** allows returning to prior steps to edit

### Steps

```
Step 1 of 12 — Welcome
  ┌────────────────────────────────┐
  │  Welcome to FGA                │
  │                                │
  │  Let's get your business set   │
  │  up. About 15 minutes — you    │
  │  can pause anytime.            │
  │                                │
  │  [        Let's go →          ]│
  └────────────────────────────────┘

Step 2 of 12 — Your Business
  Business name *      [_________]
  Your name *          [_________]
  Mobile number *      [_________]
  Business address     [_________]
  Service area (cities) [________]
  What's your trade? * [HVAC ▾  ]
  [Continue →]

Step 3 of 12 — How Should We Publish Your App?
  ┌────────────────────────────────┐
  │ ● Quick Start (recommended)    │
  │                                │
  │   We publish your app under    │
  │   our Apple developer account. │
  │   Live in 3-5 days. Zero       │
  │   Apple paperwork on your end. │
  └────────────────────────────────┘

  ┌────────────────────────────────┐
  │ ○ Full Ownership               │
  │                                │
  │   Your app is published in     │
  │   your own Apple developer     │
  │   account. You own it forever, │
  │   even if you ever leave.      │
  │   Live in 5-7 days. One        │
  │   25-min call with us on       │
  │   Day 1.                       │
  └────────────────────────────────┘
  [Continue →]

Step 3a of 12 — Apple Details (only if Full Ownership)
  Legal business name *  [_________]
  (must match your LLC/DBA paperwork)
  D-U-N-S number (if you have one)
  [_________]
  (most small businesses don't — we'll
   request one during your enrollment call)
  [Continue →]

Step 4 of 12 — Upload Your Logo
  "Tap to upload, or take a photo
   of your truck wrap or business
   card — we'll clean it up."
  [📷 Take Photo]
  [📁 Choose from Library]
  [Skip — I don't have a logo yet]

Step 5 of 12 — Brand Colors
  (auto-suggested from logo, editable)
  Primary:  [█ navy]      [change]
  Accent:   [█ green]     [change]
  [Looks good →]

Step 6 of 12 — Seed Your Content
  "Pick 20+ photos from your camera
   roll. Job sites, before/after,
   crew shots — anything you'd be
   proud to show."
  [📷 Open Camera Roll]
  Progress: 12 of 20 selected
  [Continue →]

Step 7 of 12 — Your Voice
  "Three sentences in your voice.
   Don't overthink. The system
   matches your tone in everything
   it writes."
  [_____________________________]
  [_____________________________]
  [_____________________________]
  [Continue →]

Step 8 of 12 — Services + Hours
  "What do you offer?"
  (chips, pre-populated from vertical)
  [+ HVAC install] [+ HVAC repair]
  [+ Maintenance]  [+ add more]

  "When are you open?"
  Mon-Fri  [8am ▾] to [6pm ▾]
  Sat      [9am ▾] to [2pm ▾]
  Sun      [Closed ▾]
  [Continue →]

Step 9 of 12 — Google Business Profile
  ○ Yes — paste the URL [_______________]
  ○ Not yet — show me how to claim one
        (opens in-app guide)
  ○ Skip for now
  [Continue →]

Step 10 of 12 — Connect Facebook + Instagram
  [🔗 Connect Facebook Page]
   ✓ Connected as [Page Name]
  [🔗 Connect Instagram Business]
   ✓ Linked via Facebook
  [Skip — I don't have these yet]
  [Continue →]

Step 11 of 12 — Bring Your Customers
  "Got a customer list? Drop it in
   and we'll import them."
  [📄 Upload CSV]
  [✉️ Connect Gmail contacts] (Scale only)
  [Skip for now]
  [Continue →]

Step 12 of 12 — You're All Set
  "That's it. Your system is taking
   over from here. We'll text you
   when your branded app is ready
   to install."
  [Open My Dashboard →]
```

### Required vs Skippable

| Step | Required? | If skipped... |
|------|---|---|
| 1 Welcome | — | — |
| 2 Business basics | **Required** | Block — can't proceed |
| 3 Path choice | **Required** | Block — default to managed if skip |
| 3a Apple details | Required if owned | Block path B until provided |
| 4 Logo | Skippable | Use vertical icon, soft re-prompt later |
| 5 Colors | Skippable | Use FGA defaults |
| 6 Photo seed | Skippable (warn) | Content gen uses stock until seeded |
| 7 Voice | Skippable (warn) | Use vertical-preset voice |
| 8 Services + hours | **Required** | Block — needed for module templates |
| 9 GBP | Skippable | Review module dormant until URL provided |
| 10 FB+IG | Skippable | Content posts queue but don't publish |
| 11 Customer list | Skippable | Referral + review modules dormant |
| 12 Complete | — | — |

### State Machine

```
[Stripe paid]
  → tenants.status = 'onboarding'
  → tenant_config.onboarding_stage = null
       │
       ▼
[Customer logs into FGA app]
  → tenant_config.onboarding_stage = 'in_app_intake_started'
       │
       ▼ (advances per completed step)
  → tenant_config.onboarding_stage = 'in_app_intake_complete'
       │
       ▼
[Founder onboarding call on Day 5]
  → tenant_config.onboarding_stage = 'founder_call_complete'
       │
       ▼
[Day 7 verification passes]
  → tenants.status = 'active'
```

---

## Mobile App Build — What Needs to Ship

The existing FGA mobile app already supports multi-tenant login and
has the screen-router pattern. The onboarding wizard needs new
screens.

### New Files

| File | Purpose |
|---|---|
| `mobile-app/src/screens/OnboardingWizardScreen.js` | Wrapper screen, manages step state, progress bar, back/next |
| `mobile-app/src/screens/onboarding/Step01Welcome.js` | Welcome card |
| `mobile-app/src/screens/onboarding/Step02BusinessBasics.js` | Form |
| `mobile-app/src/screens/onboarding/Step03PathChoice.js` | Radio with rich descriptions |
| `mobile-app/src/screens/onboarding/Step03aAppleDetails.js` | Conditional Path B fields |
| `mobile-app/src/screens/onboarding/Step04Logo.js` | Image picker + camera |
| `mobile-app/src/screens/onboarding/Step05Colors.js` | Color picker, auto-suggest from logo |
| `mobile-app/src/screens/onboarding/Step06Photos.js` | Multi-select from camera roll |
| `mobile-app/src/screens/onboarding/Step07Voice.js` | Three short textareas |
| `mobile-app/src/screens/onboarding/Step08Services.js` | Chip-input + hours grid |
| `mobile-app/src/screens/onboarding/Step09GBP.js` | URL input + claim helper |
| `mobile-app/src/screens/onboarding/Step10Social.js` | Buffer OAuth deep links |
| `mobile-app/src/screens/onboarding/Step11Customers.js` | CSV upload + Gmail OAuth |
| `mobile-app/src/screens/onboarding/Step12Complete.js` | Final card with CTA |
| `mobile-app/src/services/onboarding.js` | Wrapper around the API endpoints |

### Existing Files to Modify

| File | Change |
|---|---|
| `mobile-app/src/App.js` | On launch with valid session, fetch onboarding-state. If `stage != 'active'`, route to `OnboardingWizardScreen`. If `stage == 'active'`, route to `HomeScreen` as today. |
| `mobile-app/src/screens/HomeScreen.js` | Add soft banner "Finish setup to unlock everything" when onboarding has skipped steps |

### Backend Endpoints Required

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/tenant/onboarding-state` | GET | App reads on launch: stage, completed steps, captured data |
| `/api/tenant/onboarding-step` | POST | App writes when a step completes |
| `/api/tenant/onboarding-complete` | POST | App signals wizard done |
| `/api/tenant/upload-asset` | POST (multipart) | Logo, photo seed |
| `/api/tenant/connect-buffer` | POST | Buffer OAuth callback (deep link) |
| `/api/tenant/connect-google` | POST | GBP claim flow (deep link) |
| `/api/tenant/import-customers` | POST | CSV parse + import |

### Engineering Estimate

| Component | Hours |
|---|---|
| `OnboardingWizardScreen` + step components (12 steps) | 8 |
| Step-by-step auto-save + resume logic | 2 |
| Photo seed multi-select picker | 1 |
| Buffer OAuth deep-link flow | 2 |
| Backend endpoints (6) | 3 |
| CSV import parsing | 1 |
| App.js routing logic update | 0.5 |
| End-to-end test with a fake tenant | 1.5 |
| **Total** | **~19 hours** |

Phase 1 minimum (ship for launch):
- Steps 1-5 + Step 12 (welcome, business basics, path choice, logo, colors, complete) = ~6 hours
- All required-step blocking logic + state machine = ~3 hours
- Backend endpoints onboarding-state + onboarding-step = ~2 hours
- Routing update in App.js = 0.5 hours
- **Phase 1 = ~12 hours** — gets a customer through to "branded app in motion" status

Phase 2 (week 1 post-launch):
- Steps 6-11 (photos, voice, services, GBP, social, customers)
- Buffer OAuth deep-link
- CSV import
- Soft re-prompt UX on home screen for skipped steps

---

## What Goes Away

The marketing-site web onboarding form (`OnboardingPortal.tsx`)
becomes **internal admin-only**. Patrick can use it to nudge tenant
config from his laptop, but customers never see it.

The Stripe checkout success page becomes the only customer-facing
web touchpoint after sale — and all it does is say "check your
email."

See `intake-changes.md` for the marked-as-deprecated status.

---

## Why This Is Better Than Web-First

1. **First impression IS the product.** The customer downloads the
   FGA app on Day 0 and never has to imagine what the system looks
   like. They're already inside it.

2. **Native moments where they matter.** Logo upload via camera, photo
   seed from camera roll, social account connection via OAuth deep
   links — all work better in-app than in a mobile web form.

3. **One surface to maintain.** No parallel "web intake" and "app
   continuation" code. One wizard, one API.

4. **Onboarding is daily use, just compressed.** By the time the
   customer hits Step 12, they've used the app's photo uploader,
   approved drafts (auto-generated from their seed photos by then),
   connected social — exactly the daily workflow.

5. **Resumability lives where it should.** Push notification "you're
   3 steps from done — finish setup" is a way better re-engagement
   primitive than a "click this link to continue" email.

6. **No password creation step.** Magic link from welcome email →
   one-tap into the app → done. The customer never has to think about
   a password (Supabase auth handles it under the hood).

---

## Open Questions

1. **App Store discovery** — when a brand-new customer searches "FGA"
   in the App Store on Day 0, do they find the shared FGA app fast
   enough? If not, the email-based App Store link must be a deep link
   that pre-installs. (Apple supports universal links + App Store
   deep links — implementation detail for the welcome email template.)

2. **What if magic link expires?** Customer clicks the welcome email
   on Day 12, link is dead. UX: app shows "Link expired — enter your
   email and we'll send a fresh one." Backend re-issues. ~1 hour to
   build this fallback.

3. **Branded app handoff** — when the customer's branded app finally
   ships, do we push them to switch? Or both apps work indefinitely?
   **Default: both work indefinitely.** Same backend, same data. The
   branded app is just nicer to look at on their home screen.
