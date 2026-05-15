# In-App Onboarding Wizard — Build Spec (v1, 2026-05-15)

Engineering plan for the 12-step onboarding wizard inside the FGA
mobile app. This document is structured for a focused mobile-dev
session to pick up and ship Phase 1 in a single sitting.

For UX/copy/screens, see `mobile-onboarding-flow.md`.
For data fields, see `intake-changes.md`.
For where this fits in the 7-day onboarding window, see
`client-onboarding-runbook.md`.

---

## Goal

A customer who has just paid for FGA logs into the mobile app via a
magic link and completes their entire intake inside the app. No web
form, no email-based config, no waiting on Patrick. End state: tenant
has all the data needed for the per-customer branded app build to
trigger (`onboarding_stage = 'in_app_intake_complete'`).

---

## Phase 1 Scope (Pre-Launch / Day-One Capable)

Ship the **minimum-viable wizard** that captures the data needed for
Tracks B + C of the runbook to fire. Skippable steps are stubbed for
later.

### Phase 1 In-Scope

| Component | Hours |
|---|---|
| `OnboardingWizardScreen` (wrapper, step state, progress bar, back/next) | 2.0 |
| Step 1 — Welcome | 0.3 |
| Step 2 — Business basics | 1.0 |
| Step 3 — Path choice | 0.7 |
| Step 3a — Apple details (Path B only) | 0.5 |
| Step 4 — Logo upload (camera + library, Supabase Storage) | 1.5 |
| Step 5 — Brand colors (manual picker + auto-suggest from logo) | 1.0 |
| Step 8 — Services + hours | 1.0 |
| Step 12 — Complete + handoff to HomeScreen | 0.3 |
| Backend `GET /api/tenant/onboarding-state` | 0.5 |
| Backend `POST /api/tenant/onboarding-step` | 0.5 |
| Backend `POST /api/tenant/onboarding-complete` | 0.3 |
| Backend `POST /api/tenant/upload-asset` (multipart, Supabase Storage) | 0.7 |
| `App.js` routing: detect onboarding state on launch, route to wizard | 0.5 |
| Magic-link deep-link handler (universal link → tenant load) | 0.7 |
| End-to-end test with seed tenant | 1.0 |
| **Phase 1 total** | **~12.5 hours** |

Skipped from Phase 1 (added Phase 2 within Week 1 post-launch):
- Steps 6 (photo seed) — content gen degrades but doesn't break
- Step 7 (voice samples) — voice falls back to vertical preset
- Step 9 (GBP) — review module dormant until URL added later
- Step 10 (FB+IG OAuth) — content drafts queue but don't publish
- Step 11 (customer list) — referral module dormant until populated

Phase 1 wizard is **8 of 12 steps**, all the "required" ones. Soft
banner on HomeScreen prompts to complete the rest.

---

## Phase 2 Scope (Week 1 Post-Launch)

| Component | Hours |
|---|---|
| Step 6 — Photo seed (multi-select from camera roll, batch upload) | 1.5 |
| Step 7 — Voice samples (3 textareas, simple) | 0.5 |
| Step 9 — Google Business Profile URL + claim helper | 1.0 |
| Step 10 — Buffer OAuth deep-link (FB Page + IG Business) | 2.0 |
| Step 11 — CSV import + Gmail OAuth | 1.5 |
| Backend `POST /api/tenant/connect-buffer` | 0.5 |
| Backend `POST /api/tenant/connect-google` | 0.5 |
| Backend `POST /api/tenant/import-customers` | 0.5 |
| HomeScreen soft re-prompt UX | 0.5 |
| **Phase 2 total** | **~8.5 hours** |

---

## File Manifest

### New mobile-app files

```
mobile-app/src/
├── screens/
│   └── OnboardingWizardScreen.js        # wrapper
└── screens/onboarding/
    ├── Step01Welcome.js                  # P1
    ├── Step02BusinessBasics.js           # P1
    ├── Step03PathChoice.js               # P1
    ├── Step03aAppleDetails.js            # P1 (conditional)
    ├── Step04Logo.js                     # P1
    ├── Step05Colors.js                   # P1
    ├── Step06Photos.js                   # P2
    ├── Step07Voice.js                    # P2
    ├── Step08Services.js                 # P1
    ├── Step09GBP.js                      # P2
    ├── Step10Social.js                   # P2
    ├── Step11Customers.js                # P2
    └── Step12Complete.js                 # P1
```

### Modified mobile-app files

```
mobile-app/src/
├── App.js                                # routing on launch
├── screens/HomeScreen.js                 # soft banner if onboarding incomplete
└── services/
    └── onboarding.js                     # NEW — wraps the API endpoints
```

### Modified growth-os backend files

```
growth-os/api/routes/
└── tenant.js                             # add 7 new endpoints (P1: 4, P2: 3)
```

---

## State Machine

```
tenants.status:          'onboarding'  →  'onboarding_intake_complete'  →  'active'
tenant_config.onboarding_stage:
  null  (before customer logs in)
  → 'in_app_intake_started'  (Step 1 reached)
  → 'in_app_intake_in_progress'  (Steps 2-11)
  → 'in_app_intake_complete'  (Step 12 confirmed)
  → 'founder_call_complete'  (Day 5 call done)
  → 'active'  (Day 7 verification)
```

Stored as a `tenant_config` row with `key='onboarding_stage'`.

A parallel `tenant_config` row stores `onboarding_steps_completed` as
JSON: `['welcome', 'business_basics', 'path_choice', 'apple_details',
'logo', 'colors', 'services', 'complete']`. This drives the
resume-where-you-left-off logic.

---

## Step-by-Step Auto-Save Pattern

Every step component follows the same pattern:

```js
// services/onboarding.js
export async function saveStep(stepKey, data) {
  return fetch(`${API_URL}/api/tenant/onboarding-step`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${supabaseToken}`,
    },
    body: JSON.stringify({ step: stepKey, data }),
  });
}
```

```js
// screens/onboarding/Step02BusinessBasics.js
async function onContinue() {
  setSaving(true);
  await saveStep('business_basics', {
    business_name,
    owner_name,
    phone,
    address,
    service_area,
    industry,
  });
  setSaving(false);
  navigation.navigate('Step03PathChoice');
}
```

Backend `POST /api/tenant/onboarding-step` writes the data into
`tenant_config` (keyed values for each field) AND appends the step
key to `onboarding_steps_completed`.

---

## Magic-Link Login Flow

Welcome email contains a Supabase magic-link URL like:

```
https://growth-os-production-22b3.up.railway.app/api/auth/magic-callback
  ?token=<supabase_token>
  &redirect=fga://onboarding-start
```

When the customer taps the link:
1. Browser opens the URL
2. Backend validates the token via Supabase
3. Backend redirects to `fga://onboarding-start?session=<jwt>`
4. iOS universal-link handler in the FGA app intercepts
5. App calls `supabase.auth.setSession(jwt)`
6. App reads `tenant_id` from the user record
7. App fetches `GET /api/tenant/onboarding-state`
8. App routes to `OnboardingWizardScreen` (or `HomeScreen` if state is
   `'active'`)

Backend endpoint `GET /api/auth/magic-callback` is the only new piece
of plumbing. Most of this is already wired — the FGA app supports
Supabase auth + multi-tenant lookup today.

---

## Backend Endpoints — Schemas

### GET /api/tenant/onboarding-state

Request: standard tenant-scoped auth (Bearer token, tenant_id from session)

Response:
```json
{
  "status": "onboarding",
  "stage": "in_app_intake_in_progress",
  "steps_completed": ["welcome", "business_basics", "path_choice"],
  "current_step": "apple_details",
  "captured_data": {
    "business_name": "A Kut Above",
    "industry": "tree_service",
    "delivery_path": "owned"
  }
}
```

### POST /api/tenant/onboarding-step

Request:
```json
{
  "step": "business_basics",
  "data": {
    "business_name": "A Kut Above",
    "owner_name": "Jane Doe",
    "phone": "+15551234567",
    "address": "123 Main St, Atlanta, GA",
    "service_area": "Atlanta metro",
    "industry": "tree_service"
  }
}
```

Response:
```json
{
  "success": true,
  "next_step": "path_choice",
  "stage": "in_app_intake_in_progress"
}
```

Backend behavior:
1. Validate the step key is known
2. Upsert each `data.<key>` into `tenant_config` as its own row
3. Append `step` to `tenant_config.onboarding_steps_completed` array
4. Update `tenant_config.onboarding_stage` to `'in_app_intake_in_progress'`
5. Return next step name (driven by step ordering + path choice)

### POST /api/tenant/onboarding-complete

Request: empty body
Response:
```json
{ "success": true, "stage": "in_app_intake_complete" }
```

Backend behavior:
1. Verify all required steps complete
2. Set `tenant_config.onboarding_stage = 'in_app_intake_complete'`
3. Queue `agent_jobs` row: trigger the asset-gen pipeline
4. Queue welcome SMS: "Your intake is in — your branded app is being
   built. Estimated 3-5 days (Quick Start) or 5-7 days (Full
   Ownership)."

### POST /api/tenant/upload-asset (multipart)

Request: multipart with `file` and `asset_type` ∈ `{ logo, photo_seed }`

Backend behavior:
1. Validate MIME type + size (< 25 MB)
2. Upload to Supabase Storage under `tenants/<slug>/assets/<asset_type>/<filename>`
3. For `logo`: also update `tenant_config.logo_url`
4. For `photo_seed`: append to `tenant_config.photo_seed_urls` JSON array

Response: `{ success: true, url: 'https://...' }`

---

## App.js Routing Logic

Pseudocode:

```js
useEffect(() => {
  async function init() {
    const session = await supabase.auth.getSession();
    if (!session) {
      navigation.navigate('Login');
      return;
    }
    const state = await fetchOnboardingState();
    if (state.status === 'onboarding' && state.stage !== 'active') {
      // Resume at the right step
      navigation.navigate('OnboardingWizardScreen', {
        startStep: state.current_step,
        capturedData: state.captured_data,
      });
    } else {
      navigation.navigate('Home');
    }
  }
  init();
}, []);
```

---

## TestFlight Distribution During Build-Out

While the wizard is being built (Phase 1 ~12.5 hours), Patrick can
ship intermediate TestFlight builds via the `fga-testflight-deploy`
skill. Each build:

1. Bumps `app.json` buildNumber
2. Runs prebuild + pod install + fmt fix + archive + upload
3. Becomes available via the FGA TestFlight link

The build that ships the full Phase 1 wizard is the **launch build**
(version 1.0.10 or so depending on current state).

---

## Acceptance Criteria for Phase 1 Launch-Ready

- [ ] Seed tenant: `node scripts/seed-tenant.js --slug test-onboarding`
- [ ] Generate magic link manually via Supabase admin
- [ ] Open link on iPhone running latest FGA TestFlight build
- [ ] App opens, authenticates, lands on Step 1 (Welcome)
- [ ] Complete Steps 1, 2, 3, 3a (path B), 4, 5, 8, 12 in sequence
- [ ] Each step's data appears in `tenant_config` immediately
- [ ] Closing the app at Step 5 and reopening resumes at Step 5
- [ ] Step 12 completion sets `tenants.status` → `onboarding_intake_complete`
- [ ] HomeScreen loads on next launch instead of the wizard
- [ ] `agent_jobs` has a new row for the asset-gen pipeline trigger

---

## What's NOT in This Plan

- Onboarding analytics (drop-off per step, time-to-complete) — add Phase 3
- A/B testing different wizard copy — add Phase 3
- Re-engagement push notifications for incomplete onboarding — add Phase 3
- Spanish-language wizard — defer until customer demand exists
