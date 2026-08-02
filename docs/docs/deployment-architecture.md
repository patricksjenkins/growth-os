> ⚠️ **ARCHIVED DESIGN DOC — DO NOT USE AS SOURCE OF TRUTH.**
> Written April 2026 under the retired working title "Growth OS", before the product shipped.
> The live system differs materially (15-module client catalog, Telnyx not Telnyx, in-house
> scheduler not n8n, web-form onboarding). For current facts use the code itself and
> `docs/business/` (see `docs/business/onboarding/onboarding-wizard-flow.md` v4).

# Growth OS — Deployment Architecture

**Version:** 1.0 — Phase 2 Blueprint
**Date:** 2026-04-09
**Status:** DESIGN — No code changes

---

## 1. Overview

Growth OS deploys as two Railway services + one Supabase project + static frontends.

```
┌──────────────────────────────────────────────────────┐
│                    Railway Project                     │
│                                                        │
│  ┌─────────────────┐      ┌─────────────────┐        │
│  │   API Service    │      │  Worker Service  │        │
│  │   Express :3000  │      │  Cron + Jobs     │        │
│  │                  │      │  :3001            │        │
│  │  - REST routes   │      │  - Scheduler      │        │
│  │  - Auth/tenant   │      │  - Agent runner   │        │
│  │  - Webhooks      │      │  - Job processor  │        │
│  │  - Static files  │      │                   │        │
│  └────────┬─────────┘      └────────┬──────────┘       │
│           │                         │                   │
│           └────────────┬────────────┘                   │
│                        │                                │
└────────────────────────┼────────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │      Supabase       │
              │                     │
              │  PostgreSQL + RLS   │
              │  Auth (JWT)         │
              │  Storage (files)    │
              │  Realtime (future)  │
              └──────────┬──────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
   ┌──────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
   │   Portal    │ │  Mobile  │ │  External   │
   │  Vite SPA   │ │  Expo    │ │  Services   │
   │  (static)   │ │  (iOS)   │ │  Telnyx     │
   │             │ │          │ │  Buffer     │
   │             │ │          │ │  Claude     │
   └─────────────┘ └──────────┘ │  Gemini     │
                                └─────────────┘
```

---

## 2. API Service

### Railway Configuration

| Setting | Value |
|---------|-------|
| **Service name** | `growth-os-api` |
| **Root directory** | `/` (uses root package.json) |
| **Start command** | `node api/server.js` |
| **Port** | 3000 (Railway auto-detects) |
| **Health check** | `GET /health` |
| **Region** | US West (or nearest to tenants) |
| **Instance** | 1 (scale later if needed) |

### What it serves

- All REST API routes (`/api/leads`, `/api/content`, etc.)
- Webhook endpoints (`/webhooks/telnyx`, `/webhooks/calendly`)
- Static files (`/static/images/*` for generated content images)
- Health and status endpoints

### Request flow

```
Client → Railway URL → API Service
  → Auth middleware (verify JWT)
  → Tenant middleware (extract tenant_id, set RLS context)
  → Rate limit middleware (per-tenant)
  → Route handler
  → Supabase query (RLS-filtered)
  → Response
```

### When API needs agent work

API does NOT run agents directly. It creates a job:

```javascript
// API route handler
app.post('/api/content/generate', requireModule('content_engine'), async (req, res) => {
  const job = await db.from('agent_jobs').insert({
    tenant_id: req.tenantId,
    agent_name: 'content-generation',
    payload: { topic: req.body.topic, format: req.body.format },
    status: 'pending'
  });
  res.json({ job_id: job.id, status: 'queued' });
});
```

---

## 3. Worker Service

### Railway Configuration

| Setting | Value |
|---------|-------|
| **Service name** | `growth-os-worker` |
| **Root directory** | `/` |
| **Start command** | `node worker/index.js` |
| **Port** | 3001 (health check only) |
| **Health check** | `GET /health` |
| **Region** | Same as API |
| **Instance** | 1 |

### What it does

1. **Scheduler** — Runs cron jobs for all active tenants
2. **Job processor** — Polls `agent_jobs` table every 10 seconds
3. **Health endpoint** — Reports scheduler status and last run times

### Scheduler Design

```javascript
// worker/index.js
const express = require('express');
const { startScheduler } = require('./scheduler/cron');
const { startJobProcessor } = require('./jobs/processor');

const app = express();

// Health check only
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    scheduler: 'running',
    uptime: process.uptime(),
    lastPoll: lastPollTime
  });
});

app.listen(process.env.PORT || 3001);

// Start background processes
startScheduler();
startJobProcessor();
```

### Resolving the Duplicate Scheduler Problem

**Phase 1 finding:** Both systems had n8n AND internal cron running the same agents, causing double-execution.

**Growth OS solution:**
- n8n is completely eliminated
- Worker owns ALL scheduling via `worker/scheduler/cron.js`
- Each cron job iterates over active tenants
- Module check prevents running agents for tenants without that module
- `agent_jobs` table is the single source of truth for what's been queued/run

**No external scheduler** — no n8n, no Railway cron, no external webhook triggers for scheduled work. The worker process IS the scheduler.

### Resolving the Local-Only Execution Problem

**Phase 1 finding:** WellMor agents only ran on the Mac Mini via n8n. No cloud-native execution.

**Growth OS solution:**
- Worker runs on Railway (cloud)
- All agent code is in the repo, deployed with `railway up`
- No dependency on local machine
- Generated files (images) stored in Supabase Storage or served from API service
- No Cloudflare tunnel needed

---

## 4. Portal Deployment

### Options (in preference order)

1. **Railway static site** — Simplest. Same Railway project. `cd portal && npm run build` → serve `dist/`.
2. **Vercel** — Free tier, automatic deploys from Git. Slightly better CDN.
3. **Netlify** — Similar to Vercel.

### Configuration

| Setting | Value |
|---------|-------|
| **Build command** | `cd portal && npm install && npm run build` |
| **Output directory** | `portal/dist` |
| **Environment** | `VITE_API_URL=https://growth-os-api.railway.app` |
| **Auth** | Supabase Auth (same project) |

### Tenant-aware portal

Portal detects tenant from the logged-in user's JWT claims:

```javascript
// portal/src/hooks/useTenant.js
const { data: { user } } = await supabase.auth.getUser();
const tenantId = user.app_metadata.tenant_id;
const tenantSlug = user.app_metadata.tenant_slug;
```

UI adapts based on tenant config (brand colors, enabled modules, vertical-specific screens).

---

## 5. Mobile App

### Build & Distribution

| Setting | Value |
|---------|-------|
| **Framework** | Expo (React Native) |
| **Build service** | EAS Build |
| **Distribution** | TestFlight (iOS), Internal (Android) |
| **API URL** | Configured in `app.json` or runtime config |

### Tenant resolution

Mobile app gets tenant context at login. User belongs to one tenant (from `tenant_users`).

```javascript
// mobile/src/services/api.js
const session = await supabase.auth.getSession();
const tenantId = session.user.app_metadata.tenant_id;
// All API calls include tenant context via JWT
```

### Push notifications

Expo Push tokens are registered per user per tenant. Push notifications are sent via `integrations/expo-push.js` from the worker service.

---

## 6. Secrets Management

### Platform-level (Railway env vars)

These are shared across all tenants:

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Database connection |
| `SUPABASE_SERVICE_KEY` | Service role (bypasses RLS) |
| `SUPABASE_ANON_KEY` | Client role (respects RLS) |
| `ANTHROPIC_API_KEY` | Claude AI |
| `GOOGLE_API_KEY` | Gemini image generation |
| `SERPER_API_KEY` | Web search |
| `APOLLO_API_KEY` | Prospect enrichment |
| `HUNTER_API_KEY` | Email verification |

### Per-tenant (Supabase `tenant_integrations` table)

| Service | Credentials | Config |
|---------|-------------|--------|
| `telnyx` | account_sid, auth_token | phone_number |
| `buffer` | api_key | channels: { linkedin, instagram, ... } |
| `smtp` | host, port, user, pass | from_address |
| `instantly` | api_key | campaign settings |
| `calendly` | api_key | webhook_url |

### Security rules

1. **Never commit real keys** — `.env.example` has placeholders only
2. **Never log credentials** — Logger redacts any string matching key patterns
3. **Rotate keys on migration** — New Supabase project = new keys. Old keys revoked after migration.
4. **tenant_integrations** — Encrypted at rest by Supabase. Accessible only by service role.

---

## 7. Environment Separation

### Target-state

| Environment | Purpose | Supabase | Railway |
|-------------|---------|----------|---------|
| **Production** | Live tenants | growth-os (prod) | growth-os-api, growth-os-worker |
| **Staging** | Pre-deploy testing | growth-os-staging | growth-os-api-staging, growth-os-worker-staging |
| **Local** | Development | growth-os-dev (or local) | `node api/server.js` + `node worker/index.js` |

### Phase 3 implementation plan

Start with **production only**. Add staging when the platform has more than 2 tenants or when multiple developers contribute. For a one-person team with 2 known tenants, staging adds overhead without proportional value.

**Local development:**
```bash
# .env.local points to dev Supabase
cp .env.example .env.local
# Edit with dev keys

# Run API
node api/server.js

# Run Worker (separate terminal)
node worker/index.js

# Run Portal
cd portal && npm run dev

# Run Mobile
cd mobile && npx expo start
```

---

## 8. Background Jobs

### Job lifecycle

```
1. Job created (API or scheduler)
   → INSERT INTO agent_jobs (status: 'pending')

2. Worker picks up job
   → UPDATE agent_jobs SET status = 'processing', started_at = now()

3. Agent executes
   → Reads tenant config
   → Performs work (API calls, DB writes)
   → Logs to agent_activity_log

4. Job completes
   → UPDATE agent_jobs SET status = 'completed', completed_at = now(), result = {...}

5. Or job fails
   → UPDATE agent_jobs SET status = 'failed', error = '...'
```

### Retry strategy

Failed jobs are NOT auto-retried. Reasons:
- External API failures are often rate limits (retrying makes it worse)
- SMS/email failures may be permanent (bad number, bounced)
- Content generation failures may need prompt adjustment

Instead: Failed jobs are visible in the digest report. Owner can manually re-trigger via portal or API.

### Deferred enhancement

If auto-retry is needed later, add `retry_count` and `max_retries` columns to `agent_jobs`. Worker checks `retry_count < max_retries` and re-queues with exponential backoff.

---

## 9. Scheduling Ownership

### Single source of truth: `worker/scheduler/cron.js`

| Schedule | Agent | Module Gate |
|----------|-------|------------|
| `*/2 * * * *` (every 2 min) | speed-to-lead | `speed_to_lead` |
| `0 6 * * 1-5` (6am weekdays) | prospecting | `prospecting` |
| `0 7 * * 1-5` (7am weekdays) | enrichment | `prospecting` |
| `30 7 * * 1-5` (7:30am weekdays) | scoring | `lead_scoring` |
| `0 8-18 * * 1-5` (hourly, business hours) | follow-up | `follow_up` |
| `0 9 * * 1,4` (Mon/Thu 9am) | outreach-drip | `outreach_drip` |
| `0 9 * * 1-5` (9am weekdays) | publisher | `publishing` |
| `0 10 * * *` (10am daily) | review-request | `review_request` |
| `0 11 * * 1` (Mon 11am) | content-generation | `content_engine` |
| `0 14 * * *` (2pm daily) | referral-request | `referral_request` |
| `0 17 * * 1-5` (5pm weekdays) | digest | `digest` |

**Tenant-aware:** Each cron tick loops over all active tenants, checks if module is enabled, then enqueues a job.

**Timezone:** All schedules in tenant's local timezone (stored in `tenant_config.timezone`). Default: America/Chicago.

---

## 10. Queue / Job Processing Model

### Why Supabase table, not Redis/Bull

| Factor | Supabase Table | Redis + BullMQ |
|--------|----------------|----------------|
| Additional infrastructure | None | Redis instance ($5-15/mo) |
| Operational complexity | Zero | Redis monitoring, memory management |
| Durability | Yes (PostgreSQL) | Depends on Redis persistence config |
| Queryable | Full SQL | Limited |
| Max throughput | ~100 jobs/min | ~10,000 jobs/min |
| Latency | ~10s (poll interval) | ~10ms |
| Good enough for Growth OS? | Yes | Overkill |

**Growth OS processes ~50-100 agent jobs per day across all tenants.** A Supabase table with 10-second polling is more than sufficient.

### Concurrency

Worker processes one job at a time (single-threaded Node.js). This is intentional:
- Prevents rate limit issues with external APIs
- Avoids race conditions on shared resources
- Simplifies debugging
- Good enough for current volume

**Deferred enhancement:** If throughput becomes an issue, add a second worker instance or switch to parallel processing with a concurrency limit.

---

## 11. Webhook Security

### Telnyx

```javascript
// api/middleware/webhookVerify.js
const telnyx = require('telnyx');

function verifyTwilio(req, res, next) {
  const signature = req.headers['x-telnyx-signature'];
  const url = `${process.env.API_URL}${req.originalUrl}`;
  const authToken = req.tenantIntegrations?.telnyx?.credentials?.auth_token;

  if (!authToken || !telnyx.validateRequest(authToken, signature, url, req.body)) {
    return res.status(403).json({ error: 'Invalid Telnyx signature' });
  }
  next();
}
```

**Challenge:** Telnyx webhook hits API before we know which tenant it's for. Solution: Use Telnyx phone number to look up tenant.

```javascript
// api/webhooks/telnyx.js
app.post('/webhooks/telnyx/sms', async (req, res) => {
  const toNumber = req.body.To; // The tenant's Telnyx number
  const tenant = await findTenantByPhone(toNumber);
  if (!tenant) return res.status(404).end();
  req.tenantId = tenant.id;
  // Now verify signature with tenant's auth token
  // Then process the webhook
});
```

### Calendly

Calendly supports webhook signatures. Verify with tenant's Calendly webhook secret from `tenant_integrations`.

### Buffer

Buffer webhook confirmations are less critical (informational only). Verify by checking the Buffer post ID matches a known content_drafts record.

---

## 12. Logging & Monitoring

### Phase 3 (minimum viable)

| Layer | Approach |
|-------|----------|
| **Application logs** | `console.log` with structured format via `core/logger.js` |
| **Railway logs** | Railway captures stdout/stderr automatically. Searchable in dashboard. |
| **Agent activity** | `agent_activity_log` table — queryable, feeds digest |
| **Error tracking** | Log errors to `agent_activity_log` with status='failed' |
| **Health checks** | Railway pings `/health` on both services |
| **Uptime** | Railway provides uptime monitoring |

### Deferred enhancements

| Enhancement | When to add | Tool |
|------------|-------------|------|
| External log aggregation | 5+ tenants | Axiom, Logtail, or Datadog (free tiers) |
| Error alerting | Any production incident | Sentry (free tier) |
| APM / performance | Performance complaints | Datadog or New Relic |
| Custom metrics dashboard | When digest isn't enough | Grafana + Supabase queries |

### Logger design

```javascript
// core/logger.js
function log(agent, action, details = {}) {
  const timestamp = new Date().toISOString();
  const tenantSlug = details.tenant?.slug || 'platform';
  console.log(`[${timestamp}] [${tenantSlug}] [${agent}] ${action}`, JSON.stringify(details));
}
```

---

## 13. Open Questions

| # | Question | Impact | Default |
|---|----------|--------|---------|
| 1 | Should portal be on Railway or Vercel? | Build pipeline, CDN | Railway (keep everything in one place) |
| 2 | Do we need a staging environment for 2 tenants? | Deployment safety | No — test locally, deploy to prod |
| 3 | Should generated images be in Supabase Storage or served from API? | Storage cost, CDN | API serves from filesystem for now. Move to Storage later. |
| 4 | How to handle webhook routing for unknown tenants? | Missed webhooks | Phone number lookup for Telnyx. Tenant ID in Calendly webhook URL. |
| 5 | Auto-retry failed jobs? | Reliability vs complexity | No auto-retry in Phase 3. Manual re-trigger via portal. |
