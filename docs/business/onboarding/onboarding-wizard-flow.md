# Onboarding Wizard Flow (v4, 2026-07-03)

**Corrected 2026-07-03 (supersedes the 2026-05-15 "mobile app + web"
decision):** Onboarding intake is a **WEB form** at
`firstgenautomate.com/onboarding`, reached by a magic link in the
welcome email. There is **NO setup wizard inside any app**, and the
customer has **no branded app yet** during onboarding (we build it in
the first few days; they download it after go-live). It is resumable
across devices because state is server-side, but every surface is the
browser.

The wizard is also **module-aware** — by the time onboarding begins,
the customer has had a sales conversation and picked their modules.
The wizard only shows the steps relevant to those modules.

For the 7-day onboarding window context, see `client-onboarding-runbook.md`.
For the Apple Developer path choice (Quick Start vs Full Ownership)
that gets made during the wizard, see `path-choice.md`.

---

## Why Dual Surface

Some customers live on their phone. Others want a real keyboard. A
70-year-old taking on her son's tree-service marketing wants to type
on a laptop. A 25-year-old solo HVAC tech wants to do it from his
truck. **Meet the customer where they're comfortable.**

Backend is the source of truth for wizard state. Both surfaces are
thin renderers that:
1. Fetch `GET /api/tenant/onboarding-state` — returns the list of
   applicable steps, current step, and any data captured so far
2. Render the current step's UI (per platform)
3. Auto-save each step via `POST /api/tenant/onboarding-step`

A customer can start the wizard on their phone, switch to a laptop
mid-flow, and resume exactly where they left off. The backend doesn't
care which surface is rendering.

---

## Why Module-Aware

If a customer didn't buy the Review Requests module, asking them for
their Google Business Profile URL is noise. If they didn't pick
Social Engagement, the Facebook + Instagram OAuth step wastes their
time. Each step the customer doesn't actually need is friction that
risks abandonment.

The wizard reads `tenant_modules` at the start of onboarding and
filters out steps that don't apply.

### Module-to-Step Relevance Matrix

| Step | Always Shown? | Required Modules To Show (any of) |
|------|---|---|
| 1 Welcome | ✓ | — |
| 2 Business basics (name, vertical, address, hours, phone) | ✓ | — |
| 3 Path choice (Quick Start vs Full Ownership) | ✓ | Branded Mobile App (always in package) |
| 3a Apple details (legal entity, DUNS) | conditional | Branded Mobile App + Path B chosen |
| 4 Logo upload | ✓ | — (used by branded app + content + DFY site) |
| 5 Brand colors | ✓ | — (used by branded app + content + DFY site) |
| 6 Photo seed | conditional | Content Engine **OR** Content Approval & Scheduling |
| 7 Brand voice samples | conditional | Content Engine **OR** Content Approval **OR** Follow-Up Sequences **OR** Referral Partner Outreach |
| 8 Services + hours | ✓ | — (all templates need this) |
| 9 Google Business Profile URL | conditional | Review Requests |
| 10 Facebook + Instagram OAuth | conditional | Content Approval & Scheduling **OR** Social Engagement Agent |
| 11 Customer list import | conditional | Referral Engine **OR** Follow-Up Sequences **OR** Review Requests |
| 12 Done-For-You Website details | conditional | Done-For-You Website module |
| 13 AI Chat Agent training questions | conditional | AI Chat Agent module |
| 14 Complete | ✓ | — |

### Example: Growth-tier Apex Plumbing (7 modules)

Modules picked: Lead Capture, Speed-to-Lead, Missed Call, Follow-Up,
Content Engine, Content Approval, Review Requests.

Wizard shows: 1, 2, 3, 3a (if Path B), 4, 5, 6, 7, 8, 9, 10, 14
= **12 steps** (or 11 if Path A).

### Example: Minimal pick (no content / no reviews)

Modules picked: Lead Capture, Speed-to-Lead, Missed Call, Follow-Up,
Done-For-You Website, AI Chat Agent, Branded App.

Wizard shows: 1, 2, 3, 3a (if Path B), 4, 5, 7, 8, 11, 12, 13, 14
= **11-12 steps**.

(Step 6 photos skipped — no content modules. Step 9 GBP skipped — no
reviews. Step 10 social skipped — no content approval. Step 11
customers shown — Follow-Up Sequences uses it.)

### Example: Scale-tier full bundle

All 15 modules. Wizard shows every step 1-14 = **14 steps**.

---

## End-to-End Flow

```
[Marketing site Stripe checkout]
  → email captured by Stripe
  → setup fee paid

[Stripe webhook]
  → backend creates tenants row (status='onboarding')
  → backend creates tenant_modules rows for picked modules
  → backend creates Supabase auth user
  → backend generates Supabase magic link (redirect → web onboarding form)
  → backend sends welcome email + SMS with ONE web link

[Customer's inbox]
  → "Open your setup form" link → firstgenautomate.com/onboarding (logged in)

[Customer opens the web form]
  → opens browser, magic link authenticates, routes to
    /onboarding (OnboardingPortal.tsx)

[Wizard (web)]
  → fetches GET /api/tenant/onboarding-state to learn:
       - which steps apply (module-filtered)
       - which step to resume at
       - any data already captured
  → renders the appropriate step UI
  → auto-saves per step via POST /api/tenant/onboarding-step

[Wizard complete]
  → POST /api/tenant/onboarding-complete
  → tenant_config.onboarding_stage = 'in_app_intake_complete'
    (legacy value name — the intake is web, not in-app; renaming it is a
    separate DB migration)
  → triggers asset-gen pipeline (Track B in the runbook)
  → branded app build kicks off

[Days 1-7]
  → branded app build per the runbook
  → founder onboarding call Day 5
  → active status Day 7
```

---

## Welcome Email + SMS (Day 0)

Sent by the Stripe webhook handler immediately after payment confirmation.

### Email Template

```
Subject: Welcome to First Gen Automate

Hi {{owner_name}},

One short form and we're moving. It takes about 15 minutes, all in your
browser. This is where you tell us the basics about {{business_name}}.

  [ Open your setup form ]
    → https://www.firstgenautomate.com/onboarding/start (magic link)

Opens in your browser on any device. Pause and pick back up anytime,
it saves as you go.

Once you finish, we get to work: we build your setup, your done-for-you
website, and your own branded app. You'll get it to download in the
first few days, and that's where you'll run everything day to day.

Talk soon,
Patrick
First Gen Automate

P.S. Both links expire in 7 days. Reply to this email if you need a
fresh one.
```

### SMS Template

```
Welcome to FGA! Your setup link is ready.

Phone: [shortlink]
Browser: [shortlink]

Either works. Pause anytime — it saves as you go. -Patrick
```

The shortlinks resolve server-side to whichever destination the
customer taps. Both deliver the same magic-link auth.

---

## Wizard Step Details

Below: each step's purpose, the data it captures, and platform-
specific UX notes.

### Step 1 — Welcome (always shown)

**Captures:** nothing — orientation only.

**Mobile UX:** Full-screen welcome card with progress bar at top.
"Hi [Owner Name]. Let's get [Business Name] set up. About 15 minutes
— you can pause anytime." Single CTA: "Let's go →"

**Web UX:** Centered card on midnight background. Same copy. Single
CTA button.

### Step 2 — Business Basics (always shown)

**Captures:** `business_name`, `owner_name`, `phone`,
`business_address`, `service_area`, `industry` (vertical).

**Mobile UX:** Stacked text inputs, mobile-keyboard-aware,
auto-advance to next field on enter. Vertical picker is a native
picker wheel.

**Web UX:** Two-column form layout. Same fields. Vertical picker is
a styled dropdown.

### Step 3 — Path Choice (always shown)

**Captures:** `delivery_path` ∈ `{managed, owned}`.

**Mobile + Web UX:** Two-card radio. Cards have title + description +
"recommended" tag on Quick Start. See `path-choice.md` for copy.

### Step 3a — Apple Details (conditional: Path B only)

**Captures:** `legal_entity_name`, `duns_number` (optional).

**Mobile + Web UX:** Two text inputs. Helper copy explains DUNS is
optional and Apple will issue one for free during the Day 1 call.

### Step 4 — Logo (always shown)

**Captures:** `logo_url` (uploaded to Supabase Storage).

**Mobile UX:** Two CTAs: "Take a photo" (opens camera, can shoot
their truck wrap or business card) and "Choose from library" (native
photo picker). Sharp processes the upload server-side to extract a
clean logo.

**Web UX:** Drag-and-drop dropzone + "Choose file" button. Same
backend processing. (Web can't open native camera; if they want to
use the truck-wrap shortcut, they should use mobile.)

**Optional:** "Skip — I don't have a logo yet" — defaults to a vertical-
appropriate placeholder, soft re-prompt on home screen later.

### Step 5 — Brand Colors (always shown)

**Captures:** `color_primary`, `color_secondary`.

**Mobile + Web UX:** If a logo was uploaded, auto-suggest 2-3 color
pairs extracted from the logo (color quantization). Customer taps to
accept or open a color picker for manual override.

### Step 6 — Photo Seed (conditional: Content modules)

**Captures:** 20+ photos uploaded to Supabase Storage; URLs stored
in `tenant_config.photo_seed_urls`.

**Mobile UX:** Native multi-select from Photos. Shows checkmarks on
selected. "Pick 20+ photos." Progress counter at bottom: "12 of 20
selected." Continue enables at 20.

**Web UX:** Multi-file upload via dropzone. Same backend, same
progress counter. Web users can drag in entire folders.

### Step 7 — Brand Voice (conditional: Content / Follow-Up / Outreach modules)

**Captures:** `brand_voice` (3 short sentences).

**Mobile UX:** Three stacked textareas, each ~50 char hint placeholder.

**Web UX:** Same three textareas in a centered card.

### Step 8 — Services + Hours (always shown)

**Captures:** `key_services` (chip list), `business_hours` (7 days).

**Mobile + Web UX:** Chips for services (pre-populated from vertical
preset, editable). Hours grid: 7 rows, From-To time pickers per day
with "Closed" toggle.

### Step 9 — Google Business Profile (conditional: Review Requests)

**Captures:** `google_review_url`.

**Mobile + Web UX:** Single URL input. Optional. If customer doesn't
have GBP, in-app guide links to a "How to claim your Google Business
Profile" article. Skip allowed.

### Step 10 — Facebook + Instagram (conditional: Content Approval / Social Engagement)

**Captures:** Buffer OAuth tokens (encrypted in `tenant_secrets`).

**Mobile UX:** Two CTAs: "Connect Facebook Page" and "Connect
Instagram Business." Each opens an in-app browser to Buffer's OAuth
flow, returns via deep link.

**Web UX:** Same two CTAs. OAuth opens in a popup window, returns
via `window.opener.postMessage`. Standard web OAuth pattern.

### Step 11 — Customer List (conditional: Referral / Follow-Up / Review modules)

**Captures:** customer list imported to `contacts` table.

**Mobile UX:** Two options: "Upload CSV" (file picker), "Connect
Gmail contacts" (Scale only — OAuth flow).

**Web UX:** Same two options. CSV via dropzone.

### Step 12 — Done-For-You Website (conditional: DFY Website module)

**Captures:** Site preferences — domain ownership (yes/no), preferred
domain name if no, simple page structure (services, gallery, about,
contact).

**Mobile + Web UX:** Form fields. Customer can skip and FGA defaults
to a standard 4-page template.

### Step 13 — AI Chat Agent Training (conditional: AI Chat Agent module)

**Captures:** Pricing info, common FAQs the agent should know, lead-
capture goals.

**Mobile + Web UX:** Form with pricing inputs (per-service typical
price ranges), FAQ pairs, target outcomes.

### Step 14 — Complete (always shown)

**Captures:** Final transition trigger.

**Mobile UX:** Success card. "You're all set. We'll text you when
your branded app is ready to install." Button: "Open my dashboard →"
which takes them to HomeScreen of the FGA app.

**Web UX:** Same success card. Button: "Open my portal →" which
takes them to the home view of the web portal.

---

## State Machine

```
[Stripe paid]
  → tenants.status = 'onboarding'
  → tenant_modules rows created (from picked modules)
  → tenant_config.onboarding_stage = null

[Customer authenticates via magic link in the browser]
  → backend computes applicable steps based on tenant_modules
  → returns onboarding-state with the step list
  → tenant_config.onboarding_stage = 'in_app_intake_started'
       │
       ▼ (each step advances)
  → tenant_config.onboarding_steps_completed += step_key
       │
       ▼
  → tenant_config.onboarding_stage = 'in_app_intake_complete'
       │
       ▼
[Founder onboarding call Day 5]
  → tenant_config.onboarding_stage = 'founder_call_complete'
       │
       ▼
[Day 7 verification]
  → tenants.status = 'active'
```

---

## Backend API

Source of truth for the wizard state and module-relevance logic.

### GET /api/tenant/onboarding-state

```json
{
  "status": "onboarding",
  "stage": "in_app_intake_in_progress",
  "applicable_steps": [
    "welcome",
    "business_basics",
    "path_choice",
    "apple_details",
    "logo",
    "colors",
    "photos",
    "voice",
    "services",
    "gbp",
    "social",
    "complete"
  ],
  "steps_completed": ["welcome", "business_basics", "path_choice"],
  "current_step": "apple_details",
  "captured_data": {
    "business_name": "A Kut Above",
    "industry": "tree_service",
    "delivery_path": "owned"
  }
}
```

The `applicable_steps` array is computed server-side based on
`tenant_modules`. The wizard renders the steps in that order, skipping
any that aren't in the list.

### POST /api/tenant/onboarding-step

```json
{
  "step": "business_basics",
  "data": { "business_name": "...", "phone": "...", ... }
}
```

Backend appends to `steps_completed`, updates `tenant_config`, returns
next step.

### Other endpoints

Same as the original mobile-only spec — `onboarding-complete`,
`upload-asset`, `connect-buffer`, `connect-google`,
`import-customers`. All shared by both surfaces.

---

## Surface Parity Rules

To avoid one surface drifting from the other:

1. **Step list is server-driven.** Both surfaces render the same
   steps in the same order based on `applicable_steps`. Adding a new
   step means updating the server config, not both UIs.
2. **Field validation lives on the backend.** UI-side validation is a
   nice-to-have; the source-of-truth check happens on the API.
3. **Both surfaces must implement every step.** No "this step is
   mobile-only" exceptions. If a step requires the camera (photo
   seed), the web version falls back to file upload — but it must
   exist.
4. **State always resumable across surfaces.** Customer can hop from
   phone to laptop mid-wizard. Test this scenario at every major
   release.

---

## Engineering Estimate (Both Surfaces)

| Component | Hours |
|---|---|
| Backend: module-aware step resolver + state endpoints | 4 |
| Backend: file upload + OAuth callback endpoints | 3 |
| Mobile wizard (12-14 step components + wrapper screen) | 12 |
| Web wizard refit of existing OnboardingPortal.tsx | 8 |
| Welcome email + SMS template + Stripe webhook handler | 2 |
| Universal-link / deep-link / web magic-link plumbing | 3 |
| End-to-end test (both surfaces, multiple module combos) | 3 |
| **Total Phase 1** | **~35 hours** |

This is heavier than the mobile-only plan (~19h) because we're
shipping two surfaces. Phase split to fit pre-launch:

### Phase 1A (pre-launch, ~22 hours)
- Backend module-aware state endpoints (4h)
- Backend upload endpoint (1.5h)
- Mobile wizard: Steps 1, 2, 3, 3a, 4, 5, 8, 14 (8 of 14 steps, 8h)
- Web wizard refit of same 8 steps (6h)
- Welcome email + SMS + universal-link (2h)
- End-to-end test, mobile + web (0.5h)

Phase 1A ships a working wizard on both surfaces that captures the
data needed to trigger the branded-app build. Skipped: photo seed,
voice samples, GBP, social, customers, DFY details, AI Chat Agent
training. These either default sensibly or block the relevant
module from going live until added later.

### Phase 1B (week 1 post-launch, ~13 hours)
- Mobile + web steps for photos, voice, GBP, social, customers, DFY,
  AI Chat training
- OAuth callback endpoints (Buffer, Google)
- CSV import + Gmail import endpoints
- HomeScreen soft re-prompt UX (both platforms)

---

## What Goes Away

Nothing. The existing OnboardingPortal.tsx is the starting point for
the web surface — not deprecated. Patrick's vision of "completing
onboarding from the website" is exactly what it becomes.

The change vs the original portal:
- Drop the "log in with email + password" UI (replaced by magic link)
- Add module-aware step rendering
- Match the mobile wizard step-for-step
- Pull state from the new `onboarding-state` API instead of from form
  state

See `intake-changes.md` for the surgical edit list.

---

## Open Questions

1. **Web magic link** lands at `firstgenautomate.com/onboarding/start?token=...`.
   Backend exchanges token for Supabase session via cookie. Verify
   the cookie domain config works on the marketing site (Vercel) and
   the API origin (Railway).

2. **Cross-device resume** — if a customer starts the form in their
   phone browser and later opens it on a laptop, the web wizard should
   show the same current step and any captured data. **Partial-entry
   capture is a nice-to-have, not required for Phase 1.** Phase 1 just
   resumes at the last *completed* step. (There is no app surface;
   "cross-device" means browser-to-browser.)
