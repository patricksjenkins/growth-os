# Webhook route isolation and strict verification

Webhook lifecycle labels do not make an exposed callback safe. Readiness treats
every active integration and every publicly reachable legacy route as required
until verification material is proven or the legacy route is isolated.

## Current provider intent

- Stripe: active; signing secret required.
- Telnyx: active; Ed25519 public key required.
- Resend: active; Svix signing secret required.
- Calendly: legacy and not part of the target scheduling architecture.
- Twilio: retired; Telnyx is the active communications provider.
- Vapi: legacy voice-assistant dependency behind the Telnyx path.

The three legacy route flags default to `true` to preserve existing tenant
behavior:

- `FGA_WEBHOOK_CALENDLY_ROUTE_ENABLED`
- `FGA_WEBHOOK_TWILIO_ROUTE_ENABLED`
- `FGA_WEBHOOK_VAPI_ROUTE_ENABLED`

When one is explicitly set to `false`, its handler is either unmounted or
returns `410 WEBHOOK_ROUTE_RETIRED` before tenant resolution or side effects.
Telnyx remains mounted.

## Safe isolation sequence

1. Inventory provider callbacks and tenant integration configuration without
   copying credential values or customer payloads.
2. Prove that no active tenant relies on the legacy route.
3. Set only that provider's route flag to `false` in staging.
4. Verify Telnyx voice, messages, Resend events, Stripe events, authentication,
   onboarding, and all three tenants' regression paths.
5. Enable strict webhook verification only when startup readiness reports no
   missing required provider configuration.
6. Repeat the regression and negative-signature suite.

## Rollback

Restore the isolated provider's route flag to `true` and restart. The route
implementation and historical code path remain intact; no schema or production
data rollback is required.
