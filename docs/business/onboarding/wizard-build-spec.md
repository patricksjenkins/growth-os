> ⚠️ **PARTIALLY SUPERSEDED (2026-07-03 decision).** This doc predates the correction that
> onboarding is a WEB form at firstgenautomate.com/onboarding via magic link — there is NO
> setup wizard inside any app, and the customer has no branded app at Day 0. Ignore any
> in-app-wizard language below. Authoritative flow: `onboarding-wizard-flow.md` (v4).

# Onboarding Wizard — Dual-Platform Build Spec (v2, 2026-05-15)

> **⚠️ SUPERSEDED 2026-07-03 — read `onboarding-wizard-flow.md` (v4) first.**
> The mobile/app onboarding surface was dropped. Onboarding is a **WEB form
> only** (`firstgenautomate.com/onboarding`); there is no in-app wizard.
> Ignore the mobile-app build tasks, the "Open in app" universal-link setup,
> and the "both surfaces" framing below. The web build, the backend API
> contract, and the module-relevance rules still apply.

Engineering plan for the module-aware onboarding wizard on **both**
the FGA mobile app and the FGA web portal. Structured for two
parallel focused dev sessions (mobile + web) to ship Phase 1A in
~22 hours combined.

For wizard UX/copy/screens, see `onboarding-wizard-flow.md`.
For data fields, see `intake-changes.md`.
For where this fits in the 7-day onboarding window, see
`client-onboarding-runbook.md`.

---

## Goal

A customer who has just paid for FGA logs in via a magic link (from
their welcome email/SMS), picks either the mobile app or the web
portal, and completes a wizard that **only shows steps relevant to
the modules they bought**. End state: tenant has all the data needed
for the per-customer branded app build to trigger (`onboarding_stage
= 'in_app_intake_complete'`).

---

## Phase 1A Scope (Pre-Launch / Day-One Capable)

Both surfaces ship 8 of 14 wizard steps — enough to capture
everything the branded-app pipeline needs.

### Backend (shared by both surfaces, ~6h)

| Component | Hours |
|---|---|
| Module-relevance resolver (compute `applicable_steps` from `tenant_modules`) | 1.5 |
| `GET /api/tenant/onboarding-state` endpoint | 1.0 |
| `POST /api/tenant/onboarding-step` endpoint | 1.0 |
| `POST /api/tenant/onboarding-complete` endpoint | 0.5 |
| `POST /api/tenant/upload-asset` (multipart, Supabase Storage) | 1.0 |
| Stripe webhook handler updates (create Supabase user + magic link + send welcome) | 1.0 |

### Mobile (~8h)

| Component | Hours |
|---|---|
| `OnboardingWizardScreen` wrapper (step state, progress, back/next) | 2.0 |
| Step 1 — Welcome | 0.3 |
| Step 2 — Business basics | 1.0 |
| Step 3 — Path choice | 0.7 |
| Step 3a — Apple details (conditional) | 0.5 |
| Step 4 — Logo (camera + library) | 1.5 |
| Step 5 — Brand colors | 1.0 |
| Step 8 — Services + hours | 1.0 |
| Step 14 — Complete | 0.3 |
| `App.js` routing: detect onboarding state, route to wizard | 0.5 |
| Universal-link handler for magic link → app | 0.5 |
| End-to-end test on iPhone | 0.7 |

### Web (~6h)

| Component | Hours |
|---|---|
| Refit `OnboardingPortal.tsx`: replace login with magic-link landing | 1.0 |
| Wizard wrapper component (step state, progress, back/next) | 0.7 |
| Step 1, 2, 3, 3a, 4 (dropzone), 5, 8, 14 components | 2.5 |
| Magic-link callback handler at `/onboarding/start` | 0.7 |
| Cookie/session bridge between Vercel marketing site and Railway API | 0.7 |
| End-to-end test in desktop browser | 0.4 |

### Welcome Email + SMS (~2h)

| Component | Hours |
|---|---|
| Resend email template (HTML + plaintext, two links) | 0.7 |
| Twilio SMS template | 0.3 |
| Universal link config in `app.json` (associated domains) | 0.5 |
| Universal link verification with Apple | 0.5 |

**Phase 1A grand total: ~22 hours of work.**

---

## Phase 1B Scope (Week 1 Post-Launch, ~13h)

Conditional steps for the remaining modules. Both surfaces.

| Component | Hours |
|---|---|
| Mobile + Web: Step 6 (photo seed, native picker on iOS, dropzone on web) | 2.5 |
| Mobile + Web: Step 7 (voice samples) | 1.0 |
| Mobile + Web: Step 9 (GBP URL + claim helper) | 1.5 |
| Mobile + Web: Step 10 (FB+IG Buffer OAuth, deep link vs popup) | 3.0 |
| Mobile + Web: Step 11 (customer list — CSV + Gmail OAuth) | 2.5 |
| Mobile + Web: Step 12 (DFY website preferences) | 1.0 |
| Mobile + Web: Step 13 (AI Chat training inputs) | 1.0 |
| Soft re-prompt UX on home screen (both platforms) for skipped steps | 0.5 |

---

## File Manifest

### Mobile App (`/Users/patrickjenkins/Desktop/FGA/mobile-app/`)

**New files (Phase 1A):**
```
src/screens/OnboardingWizardScreen.js
src/screens/onboarding/Step01Welcome.js
src/screens/onboarding/Step02BusinessBasics.js
src/screens/onboarding/Step03PathChoice.js
src/screens/onboarding/Step03aAppleDetails.js
src/screens/onboarding/Step04Logo.js
src/screens/onboarding/Step05Colors.js
src/screens/onboarding/Step08Services.js
src/screens/onboarding/Step14Complete.js
src/services/onboarding.js
```

**New files (Phase 1B):**
```
src/screens/onboarding/Step06Photos.js
src/screens/onboarding/Step07Voice.js
src/screens/onboarding/Step09GBP.js
src/screens/onboarding/Step10Social.js
src/screens/onboarding/Step11Customers.js
src/screens/onboarding/Step12DFYWebsite.js
src/screens/onboarding/Step13AIChat.js
```

**Modified files:**
```
src/App.js                            # route to wizard if state != active
src/screens/HomeScreen.js             # soft banner for skipped steps (P1B)
app.json                              # add associatedDomains for universal links
```

### Web (`/Users/patrickjenkins/Desktop/FGA/marketing-site/`)

**Modified files (Phase 1A):**
```
src/pages/onboarding/OnboardingPortal.tsx   # repurposed as web wizard
src/pages/onboarding/MagicLinkLanding.tsx   # NEW — handles ?token=... callback
src/router.tsx (or App.tsx)                 # route /onboarding/start → MagicLinkLanding
```

**New files (Phase 1A):**
```
src/pages/onboarding/WizardWrapper.tsx
src/pages/onboarding/steps/Step01Welcome.tsx
src/pages/onboarding/steps/Step02BusinessBasics.tsx
src/pages/onboarding/steps/Step03PathChoice.tsx
src/pages/onboarding/steps/Step03aAppleDetails.tsx
src/pages/onboarding/steps/Step04Logo.tsx        # web dropzone instead of camera
src/pages/onboarding/steps/Step05Colors.tsx
src/pages/onboarding/steps/Step08Services.tsx
src/pages/onboarding/steps/Step14Complete.tsx
src/services/onboarding.ts
```

**New files (Phase 1B):** matching step components for 6, 7, 9, 10, 11, 12, 13.

### Backend (`/Users/patrickjenkins/growth-os/`)

**New / Modified files (Phase 1A):**
```
api/routes/tenant.js                      # add 4 endpoints
api/routes/auth.js                        # add /magic-callback for web flow
core/onboarding-step-resolver.js          # NEW — module-to-step mapping
integrations/stripe.js                    # webhook updates: create user, send welcome
core/welcome-email.js                     # NEW — Resend template + Twilio SMS
```

---

## Module-to-Step Resolver

Centralized logic in `core/onboarding-step-resolver.js`. Single source
of truth for which steps apply to which tenants.

```js
// Pseudo-code
const STEP_DEFINITIONS = [
  { key: 'welcome', alwaysShown: true },
  { key: 'business_basics', alwaysShown: true },
  { key: 'path_choice', alwaysShown: true },
  { key: 'apple_details', condition: (modules, deliveryPath) =>
      deliveryPath === 'owned' },
  { key: 'logo', alwaysShown: true },
  { key: 'colors', alwaysShown: true },
  { key: 'photos', condition: (modules) =>
      hasAny(modules, ['content_engine', 'approval_queue']) },
  { key: 'voice', condition: (modules) =>
      hasAny(modules, ['content_engine', 'approval_queue', 'follow_up', 'referral_partners']) },
  { key: 'services', alwaysShown: true },
  { key: 'gbp', condition: (modules) =>
      hasAny(modules, ['review_request']) },
  { key: 'social', condition: (modules) =>
      hasAny(modules, ['approval_queue', 'social_engagement']) },
  { key: 'customers', condition: (modules) =>
      hasAny(modules, ['referral_engine', 'follow_up', 'review_request']) },
  { key: 'dfy_website', condition: (modules) =>
      hasAny(modules, ['website']) },
  { key: 'ai_chat', condition: (modules) =>
      hasAny(modules, ['chat_agent']) },
  { key: 'complete', alwaysShown: true },
];

function resolveApplicableSteps(tenantId) {
  const modules = loadEnabledModules(tenantId);
  const deliveryPath = loadDeliveryPath(tenantId);  // from tenant_config
  return STEP_DEFINITIONS
    .filter(s => s.alwaysShown || s.condition(modules, deliveryPath))
    .map(s => s.key);
}
```

The mobile and web surfaces both call this through
`GET /api/tenant/onboarding-state` and render whatever they get back.
**Neither surface contains the module-relevance rules** — they're
backend-driven. Adding a new module means updating
`STEP_DEFINITIONS` in one place, not two.

---

## State Machine

```
tenants.status:
  'onboarding'  →  'onboarding_intake_complete'  →  'active'

tenant_config.onboarding_stage:
  null
  → 'in_app_intake_started'    (Step 1 reached on any surface)
  → 'in_app_intake_in_progress'  (Steps 2-13)
  → 'in_app_intake_complete'   (Step 14 confirmed)
  → 'founder_call_complete'    (Day 5 call done)
  → 'active'                   (Day 7 verification)
```

---

## Backend API — Schemas

Same as documented in `onboarding-wizard-flow.md`:

| Endpoint | Method | Used By |
|---|---|---|
| `/api/tenant/onboarding-state` | GET | Both surfaces |
| `/api/tenant/onboarding-step` | POST | Both surfaces |
| `/api/tenant/onboarding-complete` | POST | Both surfaces |
| `/api/tenant/upload-asset` | POST (multipart) | Both surfaces |
| `/api/auth/magic-callback` | GET | Web surface only (mobile uses Supabase SDK directly) |
| `/api/tenant/connect-buffer` | POST | Both surfaces (P1B) |
| `/api/tenant/connect-google` | POST | Both surfaces (P1B) |
| `/api/tenant/import-customers` | POST | Both surfaces (P1B) |

---

## Magic-Link Authentication

### Mobile

1. Customer taps "Open in app" link in welcome email
2. iOS universal link routes to FGA app (or App Store if not installed)
3. App receives the deep link with embedded token
4. App calls `supabase.auth.setSession(token)`
5. App fetches `tenant_id` from user record
6. App routes to `OnboardingWizardScreen`

### Web

1. Customer clicks "Open in browser" link in welcome email
2. Browser navigates to `firstgenautomate.com/onboarding/start?token=...`
3. `MagicLinkLanding.tsx` extracts the token from query params
4. Calls `POST /api/auth/magic-callback` on the Railway API
5. Backend validates the token, returns a session cookie scoped to
   `firstgenautomate.com`
6. Web redirects to `/onboarding` (now authenticated)
7. Wizard fetches state, renders current step

---

## Universal Link Setup (Mobile)

`app.json` additions:

```json
{
  "expo": {
    "ios": {
      "associatedDomains": [
        "applinks:firstgenautomate.com"
      ]
    }
  }
}
```

Apple-App-Site-Association file at
`https://firstgenautomate.com/.well-known/apple-app-site-association`:

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "6Y8873V85M.com.firstgenautomate.app",
        "paths": ["/onboarding/start*", "/onboarding/resume*"]
      }
    ]
  }
}
```

This file must be served as `application/json` (NOT `.json` extension)
from the Vercel-hosted marketing site. One-time setup.

---

## Web Magic-Link Cookie Bridge

The marketing site is on Vercel at `firstgenautomate.com`. The API
is on Railway at `growth-os-production-22b3.up.railway.app`. Cross-
origin cookie setup:

- API sets cookies with `SameSite=None; Secure; Domain=.firstgenautomate.com`
- Marketing site `vite.config.ts` proxies `/api/*` to the Railway API
- Or, the API exposes the magic-callback under a subdomain
  `api.firstgenautomate.com` (cleaner). Requires DNS + Railway custom
  domain setup.

Pick the cleaner subdomain approach for Phase 1A. ~30 min DNS work.

---

## Acceptance Criteria for Phase 1A Launch-Ready

- [ ] Seed a test tenant with module mix that exercises conditional
      steps: `node scripts/seed-tenant.js --slug test-wizard
      --modules lead_capture,content_engine,review_request`
- [ ] Send welcome email manually (or trigger via Stripe test webhook)
- [ ] Verify mobile path:
  - [ ] Tap "Open in app" link on iPhone with FGA TestFlight installed
  - [ ] App opens, authenticates, lands on Step 1
  - [ ] Module-conditional steps appear correctly (photo seed shown
        because content_engine; GBP shown because review_request)
  - [ ] Complete all visible steps, each saves to `tenant_config`
  - [ ] Step 14 completion sets `onboarding_intake_complete`
- [ ] Verify web path:
  - [ ] Click "Open in browser" link on laptop
  - [ ] firstgenautomate.com/onboarding/start authenticates and
        redirects to `/onboarding`
  - [ ] Same steps render with same module filtering
  - [ ] Complete all visible steps in browser, each saves
- [ ] Verify cross-surface:
  - [ ] Complete Steps 1-3 on mobile, close app
  - [ ] Open web, log in via magic link, lands on Step 4
  - [ ] Complete Steps 4-14 on web
  - [ ] All data persisted correctly
- [ ] Stripe webhook → welcome email → end-to-end completion takes
      under 20 minutes for a typical 8-step wizard

---

## What's NOT in This Plan

- Onboarding analytics (drop-off per step, time-to-complete) — Phase 3
- A/B testing wizard copy variants — Phase 3
- Re-engagement push notifications + email for incomplete onboarding — Phase 3
- Partial-form-state sync mid-step across surfaces (we only sync
  on step completion) — nice-to-have
- Spanish-language wizard — defer until customer demand exists
- Onboarding via SMS-only (text-thread back-and-forth) — defer; the
  link-to-surface flow covers the use case
