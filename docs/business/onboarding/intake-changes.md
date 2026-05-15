# Intake Form Changes — DEPRECATED FOR CUSTOMER USE (v2, 2026-05-15)

**Status update 2026-05-15:** Onboarding moved entirely into the
FGA mobile app. The marketing-site `OnboardingPortal.tsx` web flow
is **no longer the customer path** — see `mobile-onboarding-flow.md`
for the new in-app 12-step wizard.

This document remains for two reasons:

1. **OnboardingPortal.tsx survives as an internal admin tool** — Patrick
   can use the same form to nudge a tenant's config from his laptop if
   needed (faster than typing on a phone).
2. **Reference for what the in-app wizard captures.** The fields below
   are the same fields the new in-app wizard collects — just delivered
   in a native app instead of a mobile web form.

---

## What Customers See on the Marketing Site Now

After Stripe checkout, the customer lands on a thank-you page that
ONLY says "check your email." Then they:

1. Get a welcome email with App Store link + Supabase magic-link login
2. Install the FGA app
3. Tap the magic link → opens the app authenticated
4. App routes to `OnboardingWizardScreen` (12 steps)
5. Completes intake in-app

No customer-facing web onboarding portal anymore.

## OnboardingPortal.tsx — Admin-Only Future

If Patrick needs to edit a tenant's onboarding data from his laptop
(e.g. customer struggling with the in-app wizard), he can log into
`/onboarding` on the marketing site under the tenant's email +
password and edit the same fields. This is an **internal escape
hatch**, not the primary path.

Practical actions to take in the OnboardingPortal.tsx file:

1. Add a banner: **"Internal admin mode — customers complete onboarding in the FGA app."**
2. Move the path-choice fields (delivery_path, legal_entity_name, duns_number) into the form so the admin can also edit them
3. Leave the rest of the existing form working as-is

These are non-urgent — the file works today and isn't on the
customer-facing path. Schedule for a focused UI session post-launch.

---

## Fields Captured Across Onboarding (Source of Truth)

All these fields end up in `tenant_config` regardless of whether they
came from the in-app wizard or the admin escape hatch:

| Field | Where Captured | Required? |
|---|---|---|
| `business_name` | Stripe checkout (email) + in-app Step 2 confirm | Yes |
| `owner_name` | In-app Step 2 | Yes |
| `phone` | In-app Step 2 | Yes |
| `business_address` | In-app Step 2 | Optional |
| `service_area` | In-app Step 2 | Yes |
| `industry` (vertical) | In-app Step 2 | Yes |
| `delivery_path` ∈ {managed, owned} | In-app Step 3 | Yes |
| `legal_entity_name` | In-app Step 3a (only if owned) | Owned path only |
| `duns_number` | In-app Step 3a (only if owned) | Optional |
| `logo_url` | In-app Step 4 (upload to Supabase Storage) | Skippable |
| `color_primary` | In-app Step 5 | Auto-suggested from logo |
| `color_secondary` | In-app Step 5 | Auto-suggested from logo |
| Photo seed (20+ images) | In-app Step 6 | Skippable (content gen degrades) |
| `brand_voice` (3 samples) | In-app Step 7 | Skippable |
| `key_services` | In-app Step 8 | Yes |
| `business_hours` | In-app Step 8 | Yes |
| `google_review_url` | In-app Step 9 | Skippable |
| `facebook_url` + Buffer OAuth | In-app Step 10 | Skippable |
| `instagram_url` + Buffer OAuth | In-app Step 10 | Skippable |
| Customer list | In-app Step 11 (CSV / Gmail) | Skippable |

The backend `api/routes/onboarding.js` `GENERAL_FIELDS` array already
accepts all of these. No backend change needed when the wizard ships.

---

## What's Removed From Marketing Site

The current marketing-site `OnboardingPortal.tsx` is NOT removed (it
becomes admin-only), but the **customer-facing link to it goes away**:

- Stripe checkout success page no longer redirects to `/onboarding`
- Welcome email no longer contains `/onboarding?client_id=...` link
- Welcome email contains: App Store deep link + magic auth link instead

These changes go into the Stripe webhook handler + the welcome email
template (Resend).

---

## Backend Endpoints — What's Already Built vs What's Needed

Already accepting the new fields (commit 805620b):
- `api/routes/onboarding.js` POST `/intake` — accepts all GENERAL_FIELDS including delivery_path, legal_entity_name, duns_number

Need to be built for the in-app wizard:
- `GET /api/tenant/onboarding-state` — app reads on launch to find current step
- `POST /api/tenant/onboarding-step` — app writes per completed step
- `POST /api/tenant/onboarding-complete` — final transition to `intake_complete`
- `POST /api/tenant/upload-asset` (multipart) — logo + photo seed
- `POST /api/tenant/connect-buffer` — Buffer OAuth callback
- `POST /api/tenant/connect-google` — GBP claim helper
- `POST /api/tenant/import-customers` — CSV parse + import

These are documented in `mobile-onboarding-flow.md` under "Backend
Endpoints Required."
