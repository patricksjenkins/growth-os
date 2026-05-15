# App Generation Pipeline

Per-customer branded iOS app generation, used during the 7-day
onboarding window. Reduces per-customer manual work from ~4 hours to
~90 minutes.

See `/docs/business/onboarding/app-pipeline.md` for full design.

## Phase 1 (shipped 2026-05-15)

| Script | What it does |
|---|---|
| `generate-app-assets.js` | Generates app icon (Gemini) + App Store listing copy (Claude) |
| `patch-build-config.js` | Patches mobile-app/app.json with per-tenant bundle ID, name, icon, version |
| `audit-426-compliance.js` | Checks differentiation before submission to reduce Apple 4.2.6 rejection risk |

## Typical per-customer flow

```bash
# 1. Generate assets (icon + listing copy)
node scripts/app-pipeline/generate-app-assets.js --tenant <slug>

# 2. Patch the mobile app build config
node scripts/app-pipeline/patch-build-config.js --tenant <slug>

# 3. Run compliance audit before submission
node scripts/app-pipeline/audit-426-compliance.js --tenant <slug>

# 4. If audit passes, build + upload to TestFlight using the
#    fga-testflight-deploy skill — but the bundle ID will be the new
#    per-tenant value, NOT com.firstgenautomate.app.

# 5. After Apple Developer enrollment + FGA admin access, create the
#    App Store Connect listing manually for now using the generated
#    listing copy files in tenants/<slug>/app-assets/

# 6. Submit for review.

# 7. After the customer's app ships, restore the FGA-internal app.json
#    for FGA's own builds:
node scripts/app-pipeline/patch-build-config.js --restore-default
```

## Phase 2 (deferred to post-launch)

- `submit-app-store-listing.js` — automate steps 5-6 above via App Store Connect API
- Splash + App Store screenshots in `generate-app-assets.js`
- Soft compliance checks in `audit-426-compliance.js`

## Configuration

Default mobile-app path: `/Users/patrickjenkins/Desktop/FGA/mobile-app`

Override with env var:
```bash
MOBILE_APP_PATH=/path/to/mobile-app node scripts/app-pipeline/patch-build-config.js --tenant <slug>
```

## Required env vars

- `GOOGLE_API_KEY` — for Gemini icon generation
- `ANTHROPIC_API_KEY` — for Claude listing copy
- Supabase credentials — same as the rest of growth-os
