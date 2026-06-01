# AI Design Studio — Cost-Control & Implementation Spec

**Status:** Phase 1 prototype shipped (923A Coins). Phase 2 (live model) = this spec.
**Date:** 2026-06-01
**Owner:** Patrick / FGA platform

## What it is
A customer-facing tool that lets a prospect with **no artwork** describe their idea and get an **AI-generated visual concept** for a challenge coin (and later plaques/awards). The concept is a **starting point only** — FGA's/the tenant's design team turns the chosen concept into a real, production-ready proof.

**Honesty rule (do not break):** Never call the AI output "final artwork." Every concept routes through a human proof. Official seals / unit crests / branch insignia are finalized by the design team with proper authorization. This protects against overpromising and trademark issues.

## Phase 1 (DONE — prototype, $0 cost)
Live in the 923A Coins prototype at `/923acoins/ai-design`:
- Email gate before generating (lead capture)
- Guided prompt builder (branch/org, occasion, shape, center symbol, finish, front text)
- **Mocked** concept output — coin previews rendered client-side from CSS gradients + the user's inputs (no API, no cost)
- 1 concept per generate; "show more finishes" for 3 variations on request
- 3 free concepts per session, then routes to "Talk to a Designer"
- "Use This Concept" hands off to the custom order flow
- Nav entry (Shop dropdown, desktop + mobile)

## Phase 2 — live model cost controls (the important part)

### Per-image cost (verify before launch — pricing moves)
~**$0.04 / image** planning number (Gemini/Imagen ≈ $0.04; OpenAI gpt-image ≈ $0.04–0.08).
Use the platform's existing **Gemini** image integration (already the FGA image stack).

### Budget sized to plan margin
FGA owns the API keys and eats the cost, so the tool spend must be a **small slice of the plan price**, never able to exceed it.

| Setting | Value | Rationale |
|---|---|---|
| **Monthly hard cap (per tenant)** | **500 images/mo (~$20)** | ≈5% of the $399 Scale plan; protects margin |
| **Daily smoothing cap** | **~35/day** (≈ 500/15) | Can't burn the month in one day |
| **Free concepts per user** | **3 sets** | Then route to a human designer |
| **Images per "Generate"** | **1** | Variations only on explicit request (cuts cost ~75%) |
| **Rate limit** | 5/hour, 15/day per user **and** per IP | Kills scripted abuse |
| **Cooldown** | ~20s between generations | Stops rapid-fire |
| **Bot protection** | CAPTCHA before first generation | Blocks headless scripts |
| **Cache** | identical prompt → cached image | No duplicate API spend |

### The math (why these numbers)
- One abuser: 100 clicks × 1 image (variations gated) ≈ $4. With the 3-free email gate, far less.
- Worst realistic case is bounded by the **monthly cap you set** ($20), not by a daily number. Once hit → tool falls back to "Our designers will create your concept."
- Since every generation is **email-gated = a captured lead**, the spend that does happen is effectively lead-gen cost. A couple converted coin orders pays for a month.

### Circuit breaker (hard backstop)
When the tenant hits the monthly cap (or a global FGA-wide ceiling), the generator **stops calling the model** and swaps to a "Request a Designer / Start a Custom Order" panel — graceful, never an error, never an overage.

### Reuse existing platform plumbing
- Enforce via **`core/usage-caps.js`** — add a cap key (e.g. `ai_design_images`) with tenant-default 500/mo and per-tenant override in `tenant_config.usage_cap.ai_design_images`.
- Every generation: check cap → call model → log cost + (tenant_id, ip, email, prompt hash) → increment counter → throw `UsageCapExceededError` when over (UI shows the designer fallback).
- Monthly counter resets on the 1st via the existing `monthly-usage-reset` cron; daily counter self-heals.
- Alert thresholds (50% / 80% / 100%) to the platform daily digest.

### Open decisions
- Scale-only premium feature, or available on Growth too?
- Coins only at launch, or plaques/awards in v1?
- Free concept count (3 recommended) and whether starting a quote unlocks more.
