# Claude Playbook — Onboarding a New Customer

**Audience: Future Claude Code sessions.** Read this BEFORE running any onboarding task.

This is the command-first companion to `docs/business/onboarding/client-onboarding-runbook.md`. The runbook is the process narrative for Patrick. This file is the runnable commands + verification queries you (Claude) execute on his behalf.

If Patrick says "onboard X", "activate Y", "the new client's stuck", or "verify tenant Z is set up right", start here.

Cross-references:
- Process narrative + Day 0-7 timeline: `docs/business/onboarding/client-onboarding-runbook.md`
- Tenant isolation contract + JWT requirements: see "Tenant Isolation" section of that runbook
- Gotchas + multi-tenant traps: `~/.claude/projects/.../memory/tenant_isolation_gotchas.md`
- Full isolation audit dashboard: `~/Desktop/FGA/audit/tenant-isolation.html`

---

## 1. Decision tree — start here

Read what Patrick asked, then route:

| He said something like… | Go to |
|---|---|
| "Activate AKA / WellMor / a real client", "manually onboard" | **§3 — Admin-manual onboarding** |
| "Customer paid through Stripe", "finish their onboarding", "Stripe webhook" | **§4 — Stripe-paid onboarding** |
| "It's stuck", "welcome email never arrived", "wizard won't load", "JWT missing", "auth user broken" | **§5 — Recovery scenarios** |
| "Verify tenant X is set up right", "is this customer correctly isolated" | **§6 — Verification checklist** |
| Anything else mentioning onboarding | Ask a clarifying question before touching code |

---

## 2. Always-check context (do this BEFORE any command)

1. **Confirm which tenant.** Get the slug. If Patrick says a business name, find the slug:

   ```sql
   SELECT id, slug, name, owner_email, status, is_demo FROM tenants
   WHERE name ILIKE '%<business name>%' OR owner_email ILIKE '%<email>%';
   ```

2. **Confirm it's not the demo.** Apex Plumbing (`demo-apex-plumbing`) is the only demo. Never onboard "into" the demo. If unsure ask.

3. **Confirm you're not about to touch AKA's data with non-AKA scripts.** AKA has its own seed pipeline at `tenants/a-kut-above/`. Never run `scripts/seed-demo-*` against AKA.

---

## 3. Admin-manual onboarding (Path A)

Used when Patrick activates a real client he closed off-channel (friends-and-family, AKA, WellMor, hand-shake deals). No Stripe charge.

### 3a. Pre-flight checklist

- [ ] Tenant doesn't already exist:
   ```sql
   SELECT id, slug, status FROM tenants WHERE owner_email ILIKE '<email>';
   ```
   If a row exists, this is recovery (§5), not new onboarding.

- [ ] Owner email is real and the customer has access to it (Patrick confirms).
- [ ] Tier is decided: `growth` / `scale` / `complimentary` (Patrick says).
- [ ] Modules are decided (defaults: 7 Growth modules or all 14 Scale modules). Patrick can override.
- [ ] Path is decided: `managed` (FGA's Apple dev account) or `owned` (customer's own). Default `managed`.

### 3b. Provision via API

```bash
curl -X POST https://growth-os-production-22b3.up.railway.app/api/admin/onboard-tenant \
  -H "Authorization: Bearer <PATRICK_JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "<owner_email>",
    "owner_name": "<owner full name>",
    "business_name": "<business name>",
    "phone": "<optional E.164>",
    "tier": "growth",
    "vertical": "home_services",
    "products": ["lead_capture","speed_to_lead","missed_call","follow_up","content_engine","content_approval","review_request"],
    "is_complimentary": false,
    "notes": "<admin notes>",
    "send_welcome": true
  }'
```

**Send `products`, not `modules`.** A product is one line item Patrick sells; a
module key is one string a cron entry compares against, and they are not
one-to-one. "Content Approval & Scheduling" is a single product that needs TWO
keys (`approval_queue` AND `publishing`) — send only the first and the client
generates content that is never published, which is the state 923A is in.
`core/module-registry.js` holds the mapping and the server rejects anything it
does not recognise. The valid product ids are printed by:

```bash
node -e "console.log(require('./core/module-registry').PRODUCTS.map(p=>p.id).join('\n'))"
```

This runbook previously listed raw module keys, four of which were wrong
(`missed_call_textback`, `follow_up_sequences`, `content_approval`,
`review_requests` — the real keys are `missed_call`, `follow_up`,
`approval_queue`, `review_request`). Anyone following it literally enabled four
modules that no gate in the system matches.

DON'T fetch a JWT yourself — ask Patrick to grab his current bearer token from devtools or run this from the admin portal's Settings → "Onboard new client" form (which calls the same endpoint with auth already attached).

### 3c. Verify the provisioning landed

Run all four in order. If any fail, go to §5.

```sql
-- A. Tenant row exists with is_demo=false and a non-demo slug
SELECT id, slug, name, status, is_demo FROM tenants WHERE owner_email = '<email>';
-- Expected: 1 row. is_demo=false. slug does NOT start with 'demo-'. status='onboarding'.

-- B. Modules enabled
SELECT module, enabled FROM tenant_modules WHERE tenant_id = '<id-from-A>';
-- Expected: rows for each module from the curl. enabled=true.

-- C. Auth user created with the right metadata
SELECT id, email, raw_app_meta_data, raw_user_meta_data FROM auth.users WHERE email = '<email>';
-- CRITICAL: raw_app_meta_data must contain tenant_id and role='client_owner'.
-- raw_user_meta_data should have business_name and owner_name.
-- If app_metadata.tenant_id is missing -> §5a (fix auth user).

-- D. Tenant config persisted
SELECT key, value FROM tenant_config WHERE tenant_id = '<id-from-A>';
-- Expected rows: tier, owner_name, business_name, owner_email, is_complimentary,
-- provisioned_via='admin_manual', provisioned_by_admin, provisioned_at.
```

### 3d. Watch the Day-1 asset pipeline

The `app-asset-pipeline` agent enqueues automatically after wizard Step 8 (services captured). To check:

```sql
SELECT agent_name, status, created_at, completed_at, last_error
FROM agent_jobs
WHERE tenant_id = '<id>' AND agent_name IN ('app-asset-pipeline','enrichment','prospecting')
ORDER BY created_at DESC LIMIT 20;
```

If status='failed', look at `last_error`. Common: missing brand color (wizard not finished), missing Twilio (provisioning not done).

### 3e. Day 7 verification — see §6.

---

## 4. Stripe-paid onboarding (Path B — paying customer)

Customer comes through `/pricing` → Stripe Checkout. Webhook fires `checkout.session.completed` → backend creates everything automatically.

### 4a. What should happen end-to-end

1. Customer pays. Stripe POSTs to `/webhooks/stripe`.
2. `integrations/stripe.js → handleWebhook()` runs, finds `session.metadata.tenant_id`. (If absent, the webhook bails — see §4c.)
3. Calls `core/welcome-wizard.js → sendWelcomeWizard()`.
4. Wizard ensures auth user exists with `app_metadata.tenant_id` + `role='client_owner'`.
5. Wizard sends magic-link welcome email.

### 4b. Pre-flight check (before customer goes through Stripe)

Ensure the Stripe Checkout creation endpoint was given a `tenant_id` in metadata. If you don't see one, the webhook will silently bail.

```bash
# Pull recent Stripe checkout sessions and confirm they have tenant_id metadata
# (Patrick has Stripe dashboard access; ask him to verify if you can't directly).
```

### 4c. Verify post-webhook

Same four queries from §3c. The provisioning shape is identical to admin-manual — only the trigger differs.

Additionally check:

```sql
-- Webhook event logged
SELECT * FROM activity_log
WHERE tenant_id = '<id>' AND metadata->>'stripe_event' = 'checkout.session.completed'
ORDER BY created_at DESC LIMIT 5;
```

If no row, the webhook didn't fire OR failed silently. Recovery: §5b.

---

## 5. Recovery scenarios

### 5a. Auth user missing `app_metadata.tenant_id`

Symptom: customer logs in via magic link, gets 403 "No tenant_id in user metadata" OR sees no data anywhere.

Fix (run from `growth-os/` with `SUPABASE_SERVICE_KEY` in env):

```js
// node -e "..."
const { getServiceClient } = require('./db/client');
const db = getServiceClient();
const userId = '<auth user UUID from auth.users>';
const tenantId = '<tenant UUID from tenants>';
const ownerName = '<owner full name>';
const businessName = '<business name>';
db.auth.admin.updateUserById(userId, {
  app_metadata: { tenant_id: tenantId, role: 'client_owner' },
  user_metadata: { owner_name: ownerName, business_name: businessName },
}).then(r => console.log(r));
```

Have customer log out and log back in. JWT refreshes on next session.

### 5b. Stripe webhook didn't run / no tenant created

Symptom: customer paid, no tenant row exists.

Fix: manually run the equivalent of `sendWelcomeWizard` via the admin manual endpoint (§3b) with the customer's real data. Set `is_complimentary=false` and `tier` to whatever they paid for. Mark a note in tenant_config that this was a Stripe recovery.

Then refund + re-charge OR keep their original Stripe subscription:

```sql
-- Link the Stripe subscription to the new tenant (so future webhook events match)
UPDATE tenant_config SET value = '<stripe_subscription_id>' WHERE tenant_id = '<id>' AND key = 'stripe_subscription_id';
-- Or insert if missing
INSERT INTO tenant_config (tenant_id, key, value) VALUES ('<id>', 'stripe_subscription_id', '<sub_id>') ON CONFLICT (tenant_id, key) DO NOTHING;
```

### 5c. Welcome email never arrived

Symptom: tenant + auth user exist, customer says no email.

Diagnose:

```sql
-- Did the email get queued?
SELECT id, to_address, subject, status, last_error, attempted_at
FROM scheduled_emails
WHERE tenant_id = '<id>'
ORDER BY created_at DESC LIMIT 5;
```

If `status='failed'`: read `last_error`. Common: Resend API rate limit, invalid email format, suppression list.

If no row: re-send via admin endpoint:

```bash
curl -X POST https://growth-os-production-22b3.up.railway.app/api/admin/clients/<tenant_id>/resend-welcome \
  -H "Authorization: Bearer <PATRICK_JWT>"
```

### 5d. Wizard won't load on first login

Symptom: customer logs in, sees blank screen OR "tenant not found".

Diagnose:
1. Check auth user has `app_metadata.tenant_id` (§5a if missing).
2. Check tenant row has `status='onboarding'` (not 'cancelled' or 'inactive').
3. Check JWT in browser devtools — paste into jwt.io. Confirm `app_metadata.tenant_id` is present.

### 5e. Asset pipeline failed (icon, listing copy, Twilio number)

Symptom: customer reached wizard Step 8, but Day-1 asset gen never completed. App build is blocked.

Refire:

```bash
curl -X POST https://growth-os-production-22b3.up.railway.app/api/admin/clients/<tenant_id>/refire-pipeline \
  -H "Authorization: Bearer <PATRICK_JWT>"
```

This re-enqueues `app-asset-pipeline`. Check `agent_jobs` for completion (§3d query).

### 5f. Customer chose wrong path (managed → owned, or vice versa)

Within 30 days of signup:

```bash
curl -X POST https://growth-os-production-22b3.up.railway.app/api/admin/clients/<tenant_id>/switch-path \
  -H "Authorization: Bearer <PATRICK_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"new_path": "owned"}'
```

After 30 days the endpoint refuses; escalate to Patrick for manual override.

---

## 6. Verification checklist (use for §3e Day-7 verify OR §4c sanity)

Run all six. If ANY fail, do not flip the tenant to `status='active'`.

### 6a. Banner color check (visual — ask Patrick or check via web)

Open the customer's portal in an incognito window. Top banner must read **REAL CLIENT** in yellow, with the correct business name. NOT green DEMO, NOT red FGA PLATFORM ADMIN.

If wrong banner:
- Green DEMO → tenant slug starts with `demo-` OR `is_demo=true`. Fix the tenants row.
- Red FGA PLATFORM ADMIN → auth user has `app_metadata.role='platform_owner'`. Fix via §5a but with `role='client_owner'`.

### 6b. JWT claims via Supabase

```sql
SELECT raw_app_meta_data->>'tenant_id' AS jwt_tenant_id,
       raw_app_meta_data->>'role' AS jwt_role,
       raw_user_meta_data->>'business_name' AS jwt_biz
FROM auth.users WHERE email = '<owner_email>';
```

- `jwt_tenant_id` MUST equal the tenant's `id`. NOT null. NOT empty string.
- `jwt_role` MUST be `client_owner`. NOT `platform_owner`.
- `jwt_biz` should be the business name. Empty = banner says "Unknown Tenant".

### 6c. RLS isolation spot-check

```sql
-- As the actual user (not service-role), the user should see ONLY their tenant.
-- Set the JWT context manually and try a tenant-scoped query.
SET request.jwt.claim.role = 'authenticated';
SET request.jwt.claim.sub = '<auth_user_uuid>';
SET request.jwt.claim.app_metadata = '{"tenant_id": "<their_tenant_id>", "role": "client_owner"}';
SELECT count(*), tenant_id FROM finance_entries GROUP BY tenant_id;
RESET ALL;
```

Expected: zero rows OR all rows have `tenant_id = <their_tenant_id>`. Any other tenant_id in the result = RLS broken; do NOT activate. Escalate to Patrick.

### 6d. Modules enabled match contract

```sql
SELECT module, enabled FROM tenant_modules WHERE tenant_id = '<id>' AND enabled = true;
```

Cross-check against the contracted module list. Missing modules cause feature gaps the customer will notice on Day 2-7.

### 6e. Twilio number registered (if SMS modules enabled)

```sql
SELECT key, value FROM tenant_config WHERE tenant_id = '<id>' AND key LIKE 'twilio_%';
```

Expected: `twilio_phone_number` set. If missing AND tenant has speed_to_lead/missed_call_textback enabled → §5e (refire-pipeline).

### 6f. Buffer connection (if content modules enabled)

```sql
SELECT key, value FROM tenant_config WHERE tenant_id = '<id>' AND key LIKE 'buffer_%';
```

Expected: `buffer_profile_id_facebook` or similar set. If missing → customer needs to complete wizard Step 10.

---

## 7. After successful verification — flip to active

ONLY after §6 all pass:

```sql
UPDATE tenants SET status = 'active', activated_at = NOW() WHERE id = '<id>';
```

Then notify Patrick the customer is fully activated. Suggest he do the founder-call check-in (see runbook §"Day 5") if not already done.

---

## 8. What you (Claude) must NEVER do during onboarding

- **Never** call `supabase.auth.admin.updateUserById` with `role='platform_owner'`. That's reserved for Patrick.
- **Never** set `is_demo=true` on a real client tenant. Even temporarily.
- **Never** delete a tenant row. Use `status='cancelled'` for offboarding; rows + history stay for compliance.
- **Never** run `scripts/seed-demo-*` against a real-client tenant_id. Demo seeds are for `demo-apex-plumbing` only.
- **Never** use service-role from the customer's browser. Service role stays server-side.
- **Never** flip tenant to `status='active'` before §6 passes. The active flag triggers billing and customer-facing features.
- **Never** edit `app_metadata.tenant_id` on Patrick's own auth user. That's the FGA platform admin account.

---

## 9. Communication shape with Patrick during onboarding

- Confirm the tenant slug + business name BEFORE running anything.
- Ship one phase, verify with him, then proceed. Don't batch.
- Use the verification queries (§6) as proof of correctness — paste the actual query output, not just "looks good".
- If anything fails, stop and ask. Don't try to fix and continue silently.
- Reference the full audit at `~/Desktop/FGA/audit/tenant-isolation.html` if isolation needs deep discussion.

---

*Last updated 2026-05-26 after the tenant-isolation refactor + facebook-prospecting agent ship. Keep this file in sync with `client-onboarding-runbook.md` whenever the provisioning flow changes.*
