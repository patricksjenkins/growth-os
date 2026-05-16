# URLs migrate to www subdomain (apex 307s break Universal Links)

**Date:** 2026-05-15
**Status:** decided
**Decided by:** Claude (auto-detected during AASA verification)

## Context

While verifying the Apple App Site Association (AASA) file on
production for iOS Universal Links, found that `firstgenautomate.com`
(apex) issues a 307 redirect to `www.firstgenautomate.com`. The
redirect is configured at the Vercel project level (not in vercel.json).

Apple's spec is explicit: iOS does NOT follow redirects when fetching
the AASA file. Universal Links registration silently fails if the
AASA fetch returns a 3xx.

Verified via curl:
- `firstgenautomate.com/.well-known/apple-app-site-association` →
  HTTP 307 (redirect)
- `www.firstgenautomate.com/.well-known/apple-app-site-association` →
  HTTP 200, `Content-Type: application/json`, correct body

## Options considered

1. **Use www.firstgenautomate.com everywhere** — change welcome email
   URLs + mobile app.json associatedDomains to www. Simple, no Vercel
   reconfig. Apex still 307s but customer never sees apex.
2. **Reconfigure Vercel apex→www redirect to NOT redirect the
   /.well-known/* path** — keep canonical URLs at apex, only
   redirect everything else. Requires Vercel project setting change
   I can't do without dashboard access.
3. **Remove the apex→www redirect entirely** — make both domains
   serve the same content. Requires Vercel reconfig + Patrick to
   pick one canonical domain.

## Decision

**Option 1** for immediate fix. List BOTH www. and apex in mobile
app.json `associatedDomains` (Apple supports multiple). All
customer-facing URLs use www.

## Consequences

- `core/welcome-wizard.js` `WEB_ORIGIN` default → `https://www.firstgenautomate.com`
- `templates/emails/welcome-wizard.html` + `apple-enrollment.html`
  footer links → www
- `mobile-app/app.json` `associatedDomains` → both `applinks:www.firstgenautomate.com`
  AND `applinks:firstgenautomate.com` (apex remains for future-proofing)
- `mobile-app/app.json` `buildNumber` 40 → 41 for next TestFlight push
- Implemented in commits `b5873ec` (growth-os) + `c4b728b` (mobile-app)

## Revisit when

- Patrick changes Vercel project settings to either remove the
  apex→www redirect or carve out `/.well-known/*` from it
- Apple changes their AASA-fetch behavior (unlikely)
- We add `applinks:` entries that depend on URL-path uniqueness
