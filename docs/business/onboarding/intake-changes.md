# OnboardingPortal.tsx — Web Surface of the Wizard (v3, 2026-05-15)

> **⚠️ SUPERSEDED 2026-07-03 — read `onboarding-wizard-flow.md` (v4) first.**
> Onboarding is now a **WEB form only**. There is no in-app wizard and no
> mobile onboarding surface. Ignore every "Open in app / Continue on phone /
> universal link / mobile app surface" section below — those describe the
> dropped dual-platform build. The web wizard details still stand.

**Decided 2026-05-15 (mobile surface since dropped):** The marketing-site
`OnboardingPortal.tsx` is **the onboarding wizard**. Customers complete
the entire onboarding intake in the browser:
- ~~The FGA mobile app (`OnboardingWizardScreen.js`)~~ (dropped, web only)
- The web portal at `firstgenautomate.com/onboarding`
  (`OnboardingPortal.tsx`)

Both surfaces hit the same backend, render the same module-filtered
steps, and produce identical data. Customer picks whichever they
prefer.

For the full wizard design (flow, steps, state machine, module-
relevance matrix), see `onboarding-wizard-flow.md`.
For the engineering build plan covering both surfaces, see
`wizard-build-spec.md`.

This document covers ONLY the **web-specific refit** of the existing
`OnboardingPortal.tsx`.

---

## What Changes in OnboardingPortal.tsx

The existing 990-line file is the starting point. It already has:
- Login form
- Multi-step layout
- Field components (`InputField`, etc.)
- Stripe-aware styling
- Module-specific intake fields via `MODULE_INTAKE_FIELDS`

What needs to change for it to be the web wizard:

### 1. Replace login with magic-link landing (~1 hour)

Today: form asks for email + password.

After: A new route `/onboarding/start?token=<magic-token>` handles
authentication via the magic link from the welcome email. The page
calls `POST /api/auth/magic-callback`, receives a session cookie,
and redirects to `/onboarding` (now authenticated).

If the customer hits `/onboarding` directly without a token, show a
"check your email for your login link" prompt with a "resend link"
button.

### 2. Drive step list from server (~1 hour)

Today: hardcoded step sequence in the file.

After: On mount, fetch `GET /api/tenant/onboarding-state`. Use the
`applicable_steps` array from the response as the source of truth
for which steps to render and in what order.

If the customer didn't buy Review Requests, the GBP step doesn't
render. If they didn't buy Content Engine, the photo seed step
doesn't render. The wizard adapts.

### 3. Match the mobile step structure step-for-step (~2.5 hours)

Build 8 step components in `src/pages/onboarding/steps/` matching the
mobile wizard's Phase 1A steps:

- `Step01Welcome.tsx`
- `Step02BusinessBasics.tsx`
- `Step03PathChoice.tsx` (radio with rich card descriptions)
- `Step03aAppleDetails.tsx` (conditional — only renders if path === 'owned')
- `Step04Logo.tsx` (web dropzone, no camera)
- `Step05Colors.tsx` (color picker with logo-extracted suggestions)
- `Step08Services.tsx` (chip input + hours grid)
- `Step14Complete.tsx`

Phase 1B adds the remaining steps (photos, voice, GBP, social,
customers, DFY, AI chat).

### 4. Auto-save per step (~30 min)

Each step component calls `POST /api/tenant/onboarding-step` on
"Continue" with the step key and data payload. Existing form submit
handler becomes a per-step save instead of one big submit.

### 5. Wrap with WizardWrapper (~30 min)

New `WizardWrapper.tsx` provides:
- Progress bar showing step N of M (where M = `applicable_steps.length`)
- Back/Next button management
- Step-state persistence across page reloads
- "Open in app instead" button — opens universal link to mobile app

---

## What Stays The Same

- Page chrome (header, footer, midnight theme, SEO meta)
- `InputField` and other form primitives — reuse as-is
- The "logged-in client info banner" pattern (top of page showing
  business name)
- Styles — keep the existing midnight/signal-green palette

The wizard is essentially the existing form re-skinned as a multi-
step flow with server-driven step list and per-step save.

---

## URL Routes

| Route | Purpose |
|---|---|
| `/onboarding/start?token=<jwt>` | Magic-link landing, exchanges token for session, redirects to `/onboarding` |
| `/onboarding` | The wizard itself (authenticated only) |
| `/onboarding/resume` | Same as `/onboarding`, used in universal-link paths |
| `/onboarding/portal` (existing) | Legacy URL — redirect to `/onboarding` |

---

## Backend Endpoints — Web Surface Only

Most endpoints are shared with the mobile surface (see
`wizard-build-spec.md`). One web-specific endpoint:

### GET /api/auth/magic-callback

Web entry point for magic-link auth. Mobile uses the Supabase SDK
directly, but the web needs a server-side exchange to get the auth
cookie set on `firstgenautomate.com`.

Request: `GET /api/auth/magic-callback?token=<supabase-magic-token>`

Response: `Set-Cookie: session=<jwt>; Domain=.firstgenautomate.com;
Secure; HttpOnly; SameSite=Lax` + `302` redirect to `/onboarding`.

---

## Data Fields Captured (Source of Truth)

Same as mobile surface. All flow through to `tenant_config`:

| Field | Step | Required? |
|---|---|---|
| `business_name` | 2 | Yes |
| `owner_name` | 2 | Yes |
| `phone` | 2 | Yes |
| `business_address` | 2 | Optional |
| `service_area` | 2 | Yes |
| `industry` (vertical) | 2 | Yes |
| `delivery_path` ∈ {managed, owned} | 3 | Yes |
| `legal_entity_name` | 3a | Path B only |
| `duns_number` | 3a | Optional |
| `logo_url` | 4 | Skippable |
| `color_primary` | 5 | Auto-suggested from logo |
| `color_secondary` | 5 | Auto-suggested from logo |
| Photo seed URLs | 6 (P1B) | Skippable |
| `brand_voice` | 7 (P1B) | Skippable |
| `key_services` | 8 | Yes |
| `business_hours` | 8 | Yes |
| `google_review_url` | 9 (P1B) | Skippable |
| Buffer OAuth tokens | 10 (P1B) | Skippable |
| Customer list | 11 (P1B) | Skippable |
| DFY website prefs | 12 (P1B) | Conditional |
| AI Chat training | 13 (P1B) | Conditional |

Backend `api/routes/onboarding.js` `GENERAL_FIELDS` already accepts
all of these (commit 805620b).

---

## "Open in App Instead" Button

Every wizard step on the web surface should have a small CTA in the
header: **"Continue on phone →"**. Clicking opens the universal link
to the FGA app on the customer's phone (if they're on desktop, it
opens the App Store page). The wizard state is preserved server-
side, so they pick up where they left off.

Same on mobile: every step has **"Continue on computer →"** which
shows a small modal with the web link + "We'll text it to you" button
that sends the customer an SMS with the resume URL.

This is the **"meet me where I'm comfortable"** promise made real.

---

## Test Matrix for Phase 1A

| Scenario | Expected |
|---|---|
| New customer pays, opens email on phone, taps "Open in app" | FGA app installs (or opens), authenticates, lands on Step 1 |
| New customer pays, opens email on laptop, clicks "Open in browser" | Browser navigates to `/onboarding/start?token=...`, authenticates, redirects to `/onboarding` on Step 1 |
| Customer completes Steps 1-3 on mobile, closes app, opens browser later | Web wizard opens at Step 4 (next step after last completed) |
| Customer completes Steps 1-3 on web, opens mobile app | Mobile wizard opens at Step 4 |
| Customer with Growth tier (7 modules) sees only the steps applicable to those modules | Module-conditional steps render correctly per matrix in `onboarding-wizard-flow.md` |
| Customer with Path B chosen sees Step 3a Apple Details | Step renders only when delivery_path === 'owned' |
| Customer with Path A chosen does NOT see Step 3a | Step is skipped, wizard moves to Step 4 |
| Magic link expires (>7 days) | Customer sees "link expired" with re-send option |
| Customer hits `/onboarding` directly without auth | Customer sees "check your email" page |
