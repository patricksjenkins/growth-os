# Automated App Generation Pipeline (v1, 2026-05-15)

The pipeline that turns "customer signed contract" into "branded app
in TestFlight" with as little manual work as possible. Each
per-customer app submission used to take ~4 hours of active work; the
pipeline brings that down to **~90 minutes**, almost all of which is
unavoidable Apple-UI clicking.

For where this fits in the broader onboarding workflow, see
`client-onboarding-runbook.md`. For the data captured during
onboarding (which feeds this pipeline), see `mobile-onboarding-flow.md`.

---

## Pipeline Stages

```
[Day 0 intake submitted]
        │
        ▼
┌─────────────────────────────────┐
│ 1. generate-app-assets.js       │  ← Claude + Gemini
│    icon, splash, screenshots,   │     generate visuals + copy
│    listing copy                 │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ 2. patch-build-config.js        │  ← rewrites app.json,
│    bundle ID, app name, colors, │     bundle ID, expo config
│    splash references            │
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ 3. audit-426-compliance.js      │  ← blocks if app is too
│    differentiation checks       │     similar to template
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ 4. [manual] build + TestFlight  │  ← follow
│    upload                       │     fga-testflight-deploy skill
└─────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────┐
│ 5. submit-app-store-listing.js  │  ← creates listing
│    metadata, screenshots,       │     via App Store Connect API
│    submit for review            │
└─────────────────────────────────┘
        │
        ▼
[Apple review — 1-3 days]
```

---

## Components

### 1. `generate-app-assets.js`

**Input:** tenant ID
**Output:** PNG files in `/tenants/<slug>/app-assets/`

What it generates:

| Asset | Source | Size |
|---|---|---|
| App icon (1024×1024) | Gemini prompt seeded with logo + brand colors + vertical | 1024×1024 PNG, no alpha |
| Splash screen | Gemini, same brand cues | 2732×2732 PNG (Expo splash spec) |
| App Store screenshots (8 sets) | Render of actual app UI with customer's real tenant data, captured by headless Expo | 1290×2796 (iPhone 6.7") + 1242×2208 (5.5") |
| Listing description (4000 chars) | Claude with customer intake context + vertical-specific value props | Markdown |
| Listing keywords (100 chars) | Claude | Comma-separated |
| Listing promotional text (170 chars) | Claude | Plain text |
| Listing subtitle (30 chars) | Claude | Plain text |

Implementation notes:

- Uses existing `worker/agents/image-generation.js` Gemini wrapper
- Uses existing Claude SDK
- Stores outputs in Supabase Storage under
  `app-assets/<tenant_slug>/<asset_type>.png`
- Records manifest in `tenant_config.app_assets` JSON

### 2. `patch-build-config.js`

**Input:** tenant ID
**Output:** Updated `mobile-app/app.json` + `mobile-app/ios/...`

What it patches:

| Field | Source |
|---|---|
| `expo.name` | Customer's business name |
| `expo.slug` | Customer's tenant slug |
| `expo.ios.bundleIdentifier` | `com.<tenant_slug>.app` |
| `expo.icon` | Path to generated icon |
| `expo.splash.image` | Path to generated splash |
| `expo.ios.buildNumber` | Reset to "1" for new app |
| `expo.version` | "1.0.0" |

Critical: this script writes to the mobile-app repo, not the growth-os
repo. Path is configurable via env var `MOBILE_APP_PATH` (defaults to
`/Users/patrickjenkins/Desktop/FGA/mobile-app`).

The script also writes a backup `app.json.fga-default` so Patrick can
restore the FGA-internal app.json when he needs to build the
FGA-tenant version of the app.

### 3. `audit-426-compliance.js`

**Input:** tenant ID, generated assets
**Output:** Pass/fail report with list of violations

Hard checks (BLOCK submission if any fail):

- [ ] App icon hash ≠ FGA icon hash and ≠ other tenant icon hashes
- [ ] App name ≠ "FGA", "First Gen Automate", or any other tenant name
- [ ] Bundle ID matches `com.<tenant_slug>.app` (not FGA pattern)
- [ ] Listing description mentions customer business name
- [ ] Listing description mentions customer's vertical
- [ ] Listing description mentions customer's service area
- [ ] Privacy policy URL resolves to 200 + contains customer business name
- [ ] Support URL resolves to 200 + contains customer business name
- [ ] Screenshots are not the default Expo/RN placeholder set

Soft checks (WARN but don't block):

- [ ] Listing description length > 500 chars
- [ ] Listing keywords use vertical-specific terms (HVAC, plumbing, etc.)
- [ ] App icon meets Apple's 1024x1024 + no-alpha + no-rounded-corners spec

Report is written to console + saved to
`/tenants/<slug>/app-assets/audit-report.json`.

### 4. Build + TestFlight (manual via skill)

Patrick follows the `fga-testflight-deploy` skill as-is. The skill
will need a small tweak: it currently hardcodes
`com.firstgenautomate.app` as the bundle ID. The skill should read
the bundle ID from the current `app.json` (which `patch-build-config.js`
has already updated to the customer-specific value).

**Skill update needed:** see `Skill Updates Required` section below.

### 5. `submit-app-store-listing.js`

**Input:** tenant ID, app build ID from App Store Connect
**Output:** App Store listing created + submitted for review

Uses the App Store Connect REST API (token-authed). Flow:

1. Look up app record by bundle ID via `GET /v1/apps?filter[bundleId]=<id>`
2. If app doesn't exist yet:
   - Create app via `POST /v1/apps` (requires customer's Apple team ID + the app's SKU)
   - Add FGA as managed developer
3. Upload listing metadata via `POST /v1/appInfoLocalizations`
4. Upload screenshots via `POST /v1/appScreenshotSets` (multipart)
5. Set privacy URL via `PATCH /v1/apps/<id>`
6. Set age rating + category
7. Submit for review via `POST /v1/appStoreVersionSubmissions`

Tokens: FGA generates a JWT signed with the customer's App Store
Connect API key (the customer creates the key once during Day 1
enrollment call and shares it with FGA via secure handoff). Keys are
stored encrypted in `tenant_secrets`.

**Alternative path if API is too complex initially:** Fastlane's
`deliver` tool. Same workflow, less code to write. Default Fastfile
template + customer-specific .env file per app.

---

## Skill Updates Required

The `fga-testflight-deploy` skill currently has hardcoded values that
need to become dynamic for per-customer builds:

| Hardcoded value | Should become |
|---|---|
| `com.firstgenautomate.app` (bundle ID) | Read from `app.json` |
| `FirstGenAutomate.xcodeproj` (project name) | Read from `app.json` slug-derived name |
| `FirstGenAutomate.xcworkspace` (workspace name) | Same |
| Team ID `6Y8873V85M` (FGA's account) | Read from `tenant_secrets.apple_team_id` for that customer |
| Provisioning profile name discovery | Same script, but filter on customer bundle ID |

The skill will work for FGA's own builds AND customer builds with
these changes. The skill's "step 5: verify DEVELOPMENT_TEAM" check
becomes: verify it matches the value in tenant_secrets.

---

## Estimated Build Time

| Component | Hours |
|---|---|
| `generate-app-assets.js` (orchestrates existing Gemini/Claude) | 2.5 |
| `patch-build-config.js` | 1.0 |
| `audit-426-compliance.js` | 1.5 |
| `submit-app-store-listing.js` (App Store Connect API) | 3.0 |
| Skill updates for dynamic values | 1.0 |
| End-to-end test with a fake tenant | 1.0 |
| **Total** | **10 hours** |

This is ~2 hours over my initial 8-hour estimate because the App
Store Connect API submission is more complex than I initially scoped.
Recommend building components 1-3 first (the high-leverage automation
that saves the most per-customer work) and deferring component 5 to
post-launch if needed.

---

## Order of Build

If time is constrained pre-launch:

1. **`generate-app-assets.js`** — biggest time saver per customer
2. **`patch-build-config.js`** — eliminates manual app.json/Xcode tweaks
3. **Skill updates** — makes the existing TestFlight skill customer-aware
4. **`audit-426-compliance.js`** — risk mitigation for first 5 customers
5. **`submit-app-store-listing.js`** — last to build, requires App
   Store Connect API key setup. Can be done manually via App Store
   Connect UI for first 2-3 customers while this is built.

---

## Phase 1 (Pre-Launch) — Minimum Viable Pipeline

Ship today (2026-05-15) to be ready for first paying customer:

- [x] Pipeline directory structure: `/scripts/app-pipeline/`
- [ ] `generate-app-assets.js` — Phase 1: app icon + listing copy
      only. Splash + screenshots Phase 2.
- [ ] `patch-build-config.js` — full feature parity
- [ ] `audit-426-compliance.js` — Phase 1: hard checks only.
      Soft checks added Phase 2.
- [ ] `fga-testflight-deploy` skill: dynamic bundle ID + team ID

Defer to Phase 2 (week 1 post-launch):

- App Store Connect API submission (`submit-app-store-listing.js`)
- Splash + screenshot generation in `generate-app-assets.js`
- Soft compliance checks in `audit-426-compliance.js`

First customer ships with Phase 1 + manual App Store Connect UI work
for the listing creation step. That's still a ~3-hour-per-customer
process instead of ~90 min, but it's launch-ready.
