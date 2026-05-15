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

## Two delivery paths

The `--path` flag controls which Apple Developer account hosts the
customer's app. See `docs/business/onboarding/path-choice.md` for the
full breakdown.

| Path | Apple Account | Bundle ID Pattern | When |
|---|---|---|---|
| `managed` (default) | FGA | `com.firstgenautomate.<slug>` | Customer chose "Quick Start" |
| `owned` | Customer | `com.<slug>.app` | Customer chose "Full Ownership" |

All three scripts accept `--path managed|owned`. If you omit it, they
read `tenant_config.delivery_path` from the database and fall back to
`managed` if neither is set.

## Typical per-customer flow

```bash
# 1. Generate assets (icon + listing copy)
node scripts/app-pipeline/generate-app-assets.js --tenant <slug>

# 2. Patch the mobile app build config (specify path, or let it read
#    from tenant_config.delivery_path)
node scripts/app-pipeline/patch-build-config.js --tenant <slug> --path managed
# OR:
node scripts/app-pipeline/patch-build-config.js --tenant <slug> --path owned

# 3. Run compliance audit before submission — same path flag
node scripts/app-pipeline/audit-426-compliance.js --tenant <slug> --path managed

# 4. If audit passes, build + upload to TestFlight using the
#    fga-testflight-deploy skill. The skill reads bundle ID from
#    app.json so it works for both paths.

# 5. After enrollment (Path B only) + listing creation, submit for
#    review via App Store Connect. (Phase 2 will automate this.)

# 6. After the customer's app ships, restore the FGA-internal app.json
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
