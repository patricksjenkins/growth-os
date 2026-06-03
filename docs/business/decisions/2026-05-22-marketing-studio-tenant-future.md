# Marketing Studio — Future Tenant Offering (decision pending)

**Date:** 2026-05-22
**Status:** Documented for future consideration. NOT shipped to tenants.

## Current state (as of decision date)

The Marketing Studio at `firstgenautomate.com/admin/marketing` is:
- **Platform-owner only** — gated by `role === 'platform_owner'` + admin email allowlist
- Hardcoded to FGA's own tenant (`tenant_id = 30566ed6-026a-45e1-9502-029e6219df31`)
- Hardcoded to FGA's brand logo overlay (composited by server-side ffmpeg)
- Hardcoded to FGA's corporate Buffer channels (via `FGA_BUFFER_API_KEY`)
- Hardcoded quota: 3 generations/rolling-week + 12/calendar-month

The mobile app (ship: 2026-05-22) also gets Marketing Studio access but **view + manage only** (no Generate). Same platform-owner gate; tenant users never see it on mobile or web.

## What "ship to tenants" would require

If/when FGA decides to offer AI-generated video promos as a feature in the Growth or Scale tier:

### Architecture changes

| Component | Current | Tenant version needs |
|---|---|---|
| `FGA_TENANT_ID` constants | Hardcoded to FGA | Must read `tenant_id` from request context |
| FGA logo URL | Hardcoded `FGA_LOGO_URL` env | Per-tenant brand logo (already stored at tenant level) |
| Buffer credentials | `FGA_BUFFER_API_KEY` env | `tenant_integrations.buffer` (already exists for content publishing) |
| Quota | Hardcoded 3/wk + 12/mo for FGA | Tier-specific caps in `tenant_config.usage_cap.*` |
| ffmpeg logo overlay | FGA wordmark, midnight bg | Per-tenant logo + brand color (already in tenant config) |
| Sora prompt template | FGA-specific copy + 4-scene FGA pitch | Tenant-specific marketing angle (the customer's pitch, not FGA's) |
| OpenAI billing | FGA's OpenAI account | FGA still pays (passes cost as part of tier) — usage caps enforce |

### Pricing model questions

- **Growth tier ($249/mo):** how many promos per month? Likely 1-2.
- **Scale tier ($399/mo):** higher cap, maybe 3-5/month.
- **Per-render cost to FGA:** $4-6 (sora-2-pro at 12s × 1024×1792). At Scale tier 5 renders = $20-30/mo COGS.
- Could also be an add-on module unlocked separately.

### UI work

- Tenant-facing version needs onboarding: "Pick a module-pitch angle" instead of "AI Voice Receptionist · Pressure Washing" (the latter is internal FGA-marketing language)
- Tenant version probably wants a simpler prompt — most owners can't describe a cinematic concept articulately. Better: pre-built scenario templates per niche.

### Module slot in the catalog

If shipped, this would be a **new module** in the 15-module catalog, OR replace something. Current 15 are full; would need to retire one or expand the Scale tier.

## Why this isn't shipping now

1. **Cost margin** — $20-30/mo COGS on a $249/mo tier (8-12% of revenue) is steep when added to existing $50+ COGS per tenant on Twilio/Anthropic/Buffer/hosting.
2. **Sora API access tiering** — Patrick's OpenAI account currently accepts only `seconds: 4|8|12` (not the documented 10|15|25). Multi-tenant rollout would need a higher-tier OpenAI account or volume-pricing arrangement.
3. **Brand-voice training per tenant** — current Sora prompt is hand-tuned for FGA's voice. Each tenant would need their own template/training before output quality matches.
4. **Sora's output unpredictability** — even with the ffmpeg logo overlay, the rest of the video is hallucinated by the model. Tenants might receive renders that don't match their brand expectations and demand re-renders, blowing the cost cap.
5. **Compliance / liability** — if Sora generates content that includes identifiable real people, copyrighted music, or trademark-conflicting imagery on a tenant's brand channel, that's tenant-fronted liability we haven't legally pressure-tested yet.

## Revisit triggers (when to reopen this decision)

- OpenAI grants higher-tier Sora API access on the FGA org account (longer durations, lower per-second cost)
- 10+ tenants ask for video content unprompted in support tickets / sales calls
- A competitor (Jobber, ServiceTitan, etc.) ships an AI video feature that creates pricing pressure
- COGS on Sora-2-pro drops by 50%+ (would change the margin math at Growth tier)

## Implementation cost estimate (when we do build it)

- **Backend refactor:** 2-3 days. Mostly removing FGA_TENANT_ID hardcodes, threading tenant context through Sora + Buffer + ffmpeg paths, per-tenant quota config, tenant-specific prompts.
- **Frontend tenant UI:** 1-2 days. New module page in the client portal + mobile parity.
- **Onboarding addition:** 1 day. Wizard step for "what's your pitch?" + brand-voice samples.
- **Pricing + billing:** 1 day. Stripe metadata, usage tracking, tier enforcement.

Total realistic: **5-7 days** of focused work to take this from FGA-only to tenant-shippable.

---

*Authored: 2026-05-22 during Marketing Studio launch session.*
*Next reviewer: revisit when revisit triggers above fire.*
