# Stripe LIVE Activation — Finish Runbook

**Created:** 2026-05-23 (Mercury account approved, unblocked Stripe Live)
**Estimated time to complete:** ~30 minutes once Stripe lifts the Payment Link pause

This is the exact sequence for finishing Stripe LIVE activation. Status of each step is tracked in `~/Desktop/FGA/dashboards/launch-checklist.html`.

## What's already done in this session

- ✅ Mercury account active (unblocked the "Add Bank" step)
- ✅ Stripe Tax enabled in monitor-only mode (category: "Software as a Service — business use")
- ✅ Automatic weekly payouts selected
- ✅ Sandbox → live data migration completed (brand, payment links, products, billing settings carried over)
- ✅ `pricing.ts` updated with the Scale tier's live URL noted in a comment (Growth tier URL pending)

## What's left — execute in this order

### 1. Finish "Add Bank" step

In the Stripe activation flow you started on 2026-05-22, click into the still-pending "Add your bank" step. Use the **routing number** + **account number** from Mercury (Settings → Account details).

Stripe will run two micro-deposits to verify ownership over the next 1-2 business days. You can proceed with the rest of the steps below in parallel — only payouts wait on the verification.

### 2. Verify 3 products carried over with full metadata

Stripe Dashboard → Products. Confirm:

| Product | Price | Recurring | Required metadata |
|---|---|---|---|
| **Setup Fee** | $199 USD | one-time | `plan: setup` |
| **Growth** | $249 USD | monthly | `plan: growth`, `tier: growth`, `posts_cap: 15`, `sms_cap: 500`, `modules: <growth-module-list>` |
| **Scale** | $399 USD | monthly | `plan: scale`, `tier: scale`, `posts_cap: 30`, `sms_cap: 1000`, `modules: <scale-module-list>` |

If metadata didn't carry over from sandbox, click each product → edit → add the fields manually.

### 3. Verify Payment Links (after Stripe unpauses them)

The two Payment Links copied from sandbox are currently paused pending Stripe's new-account verification. When Stripe lifts the pause (minutes to hours typically):

- Click each Payment Link
- Confirm `success_url = https://www.firstgenautomate.com/checkout-success?session_id={CHECKOUT_SESSION_ID}`
- Confirm `metadata.tier = growth` on the $448 link and `metadata.tier = scale` on the $598 link
- Confirm 14-day trial on the recurring portion
- **Toggle each from Paused → Active**
- **Copy both `https://buy.stripe.com/...` URLs** and paste them in chat — I'll do the `pricing.ts` swap (step 6) immediately.

### 4. Create the live webhook endpoint

Stripe Dashboard → Developers → Webhooks → **Add endpoint**.

- **URL:** `https://growth-os-production-22b3.up.railway.app/webhooks/stripe`
- **Events to subscribe (5):**
  - `invoice.paid`
  - `invoice.payment_failed`
  - `customer.subscription.deleted`
  - `customer.subscription.updated`
  - `checkout.session.completed`
- **API version:** leave default (latest)
- Click **Add endpoint**

On the next screen click **Reveal signing secret** and copy the `whsec_...` string. That's the value you'll need in step 5.

### 5. Update Railway env vars

Railway → growth-os service → Variables. Set or update:

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_...` (Stripe Dashboard → Developers → API keys → "Reveal live key") |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (the signing secret from step 4) |
| `STRIPE_PUBLISHABLE_KEY` | `pk_live_...` (publishable, also from the API keys page) |

Click **Deploy**. Railway will redeploy with the new env vars (~1-2 min).

### 6. Swap `pricing.ts` test URLs to live

Send me both live `buy.stripe.com/...` URLs from step 3. I'll patch `marketing-site/src/data/pricing.ts` line 35 (Growth) and line 68 (Scale), commit + push, and Vercel will pick up the deploy automatically.

### 7. End-to-end test with a real card

- Open `https://www.firstgenautomate.com/pricing` in a clean browser window
- Click "Start with Growth" (or Scale, your call)
- Use a **real card** (your personal card is fine — you can refund yourself)
- Complete checkout — should land on `/checkout-success`
- Within 30 seconds, the welcome-wizard email should arrive at the email you used
- Verify in Stripe Dashboard → Payments that the payment shows `paid` with `metadata.tier = growth/scale`
- In Stripe Dashboard, click the payment → **Refund** → full refund to clean up

Once the welcome email arrives and the metadata is correct, Stripe LIVE is fully wired. Mark the checklist item done.

## Failure modes to watch for

| Symptom | Likely cause | Fix |
|---|---|---|
| Welcome email never arrives | Webhook signature mismatch | Re-copy `STRIPE_WEBHOOK_SECRET` from Stripe; redeploy Railway |
| 500 on checkout-success | Stripe API key mismatch (test vs live) | Verify `STRIPE_SECRET_KEY` is `sk_live_...` not `sk_test_...` |
| Tenant created but missing tier | Payment Link metadata not set | Re-check step 3 metadata fields |
| Payment shows but no tenant | `checkout.session.completed` not subscribed | Re-check step 4 events list |
| Stripe says "Live mode incomplete" | "Add Bank" verification still pending | Wait for Mercury micro-deposits to verify (1-2 business days). Other live functionality works fine in the meantime. |

## After full activation

- Move this file to `/docs/business/runbooks/_completed/` for archive (don't delete — useful for future references like setting up a second LLC or migrating providers)
- Update `~/Desktop/FGA/dashboards/launch-checklist.html` Stripe item from `s: 'blocking'` to `s: 'done'`, set `e: 'shipped'`, set `d: true`
