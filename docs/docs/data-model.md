> ⚠️ **ARCHIVED DESIGN DOC — DO NOT USE AS SOURCE OF TRUTH.**
> Written April 2026 under the retired working title "Growth OS", before the product shipped.
> The live system differs materially (15-module client catalog, Telnyx not Telnyx, in-house
> scheduler not n8n, web-form onboarding). For current facts use the code itself and
> `docs/business/` (see `docs/business/onboarding/onboarding-wizard-flow.md` v4).

# Growth OS — Data Model

**Version:** 1.0 — Phase 2 Blueprint
**Date:** 2026-04-09
**Status:** DESIGN — No code changes

---

## 1. Overview

All tables live in a single Supabase PostgreSQL database. Tenant isolation is enforced by:
- `tenant_id` column on every business table
- Row-Level Security (RLS) policies that filter by `current_setting('app.tenant_id')`
- API middleware that sets this session variable from the authenticated JWT

---

## 2. Platform Tables (No tenant_id)

These tables manage the platform itself, not tenant data.

### tenants

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | Auto-generated |
| `name` | TEXT NOT NULL | "A Kut Above Tree Services" |
| `slug` | TEXT UNIQUE NOT NULL | "a-kut-above" — used in URLs, config lookup |
| `vertical` | TEXT NOT NULL | "tree_service", "benefits_consulting" |
| `status` | TEXT DEFAULT 'active' | active, trial, suspended, cancelled |
| `owner_email` | TEXT | Primary owner contact |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Purpose:** Registry of all businesses on the platform.
**RLS:** Platform admins only. Tenants can read their own row.
**Migration notes:** New table. Seed one row per legacy system.

---

### tenant_users

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `user_id` | UUID FK → auth.users | Supabase Auth user |
| `role` | TEXT NOT NULL | owner, admin, member, crew |
| `email` | TEXT NOT NULL | |
| `full_name` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| UNIQUE | (tenant_id, user_id) | One role per tenant per user |

**Purpose:** Maps Supabase Auth users to tenants with roles.
**RLS:** Users can read their own tenant's users. Owners can manage.
**Migration notes:** AKA has `users` table with roles. WellMor has hardcoded creds. Both migrate here.

---

### tenant_config

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `key` | TEXT NOT NULL | Config key name |
| `value` | JSONB NOT NULL | Flexible value |
| UNIQUE | (tenant_id, key) | One value per key per tenant |

**Purpose:** All tenant-specific configuration. Replaces hardcoded values, env vars, and scattered constants.

**Key config keys:**

| Key | Example Value | Replaces |
|-----|---------------|----------|
| `business_name` | `"A Kut Above Tree Services"` | Hardcoded in 40+ files |
| `phone` | `"+16015551234"` | `BUSINESS_PHONE` env var |
| `email` | `"info@akutabove.com"` | `BUSINESS_EMAIL` env var |
| `brand_colors` | `{"primary":"#2E7D32","secondary":"#FFA726"}` | CSS + image-agent |
| `service_types` | `["tree_removal","trimming",...]` | Schema ENUMs |
| `service_areas` | `["Pascagoula","Moss Point",...]` | Agent code |
| `lead_sources` | `["google","referral",...]` | Schema ENUMs |
| `content_pillars` | `["Before/after","Storm damage",...]` | content-agent.js |
| `sms_templates` | `{"speed_to_lead":"Hi {name}..."}` | smsService templates |
| `outreach_templates` | `{"stage_0":"Subject...",..}` | drip agent |
| `ai_prompts` | `{"scoring":"Score this lead..."}` | Scattered in agents |
| `scoring_rules` | `{"tier_a":75,"tier_b":50}` | scoring-agent.js |
| `referral_bonus` | `100` | Agent code ($100) |
| `review_url` | `"https://g.page/..."` | `GOOGLE_REVIEW_URL` env var |
| `content_formats` | `[{format1...},{format2...}]` | format-templates.js |
| `logo_url` | `"https://...logo.png"` | assets/ folder |

**RLS:** Tenant can read/write own config. Platform admin can read all.
**Migration notes:** Populated from vertical preset on tenant creation. Overridable per tenant.

---

### tenant_modules

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `module` | TEXT NOT NULL | Module identifier |
| `enabled` | BOOLEAN DEFAULT true | |
| `config` | JSONB DEFAULT '{}' | Module-specific overrides |
| UNIQUE | (tenant_id, module) | |

**Purpose:** Feature flags. Controls which agents run, which routes are accessible, which UI sections appear.
**RLS:** Tenant can read own modules. Platform admin can manage.
**Migration notes:** Seeded from vertical preset. See module-catalog.md.

---

### tenant_integrations

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `service` | TEXT NOT NULL | "telnyx", "buffer", "smtp", "apollo", "instantly" |
| `credentials` | JSONB NOT NULL | API keys, tokens (encrypted at rest) |
| `config` | JSONB DEFAULT '{}' | Channel IDs, phone numbers, etc. |
| `status` | TEXT DEFAULT 'active' | active, expired, error |
| UNIQUE | (tenant_id, service) | |

**Purpose:** Per-tenant external service credentials and config.
**RLS:** Tenant owner/admin only.
**Migration notes:** AKA Telnyx creds, Buffer channels. WellMor Buffer channels. Currently in .env files.

**Open question:** Should AI keys (Anthropic, Google) be platform-level env vars or per-tenant? **Default:** Platform-level for now — simpler and tenants don't need their own AI accounts.

---

## 3. Business Tables (All have tenant_id + RLS)

### leads

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | RLS filtered |
| `name` | TEXT NOT NULL | |
| `phone` | TEXT | |
| `email` | TEXT | |
| `company_name` | TEXT | For B2B verticals |
| `service_type` | TEXT | From tenant_config.service_types |
| `lead_source` | TEXT | From tenant_config.lead_sources |
| `status` | TEXT DEFAULT 'new_lead' | Pipeline stage |
| `priority_tier` | TEXT | A, B, C (from scoring) |
| `lead_score` | INTEGER | 0-100 |
| `estimate_amount` | DECIMAL | |
| `final_revenue` | DECIMAL | |
| `address` | TEXT | |
| `city` | TEXT | |
| `notes` | TEXT | |
| `loss_reason` | TEXT | |
| `assigned_to` | UUID FK → tenant_users | |
| `date_of_inquiry` | TIMESTAMPTZ | |
| `date_of_estimate` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Purpose:** Core pipeline entity. Every business interaction starts with a lead.
**Relationships:** Has many contacts, job_photos, automation_logs.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:**
- AKA `leads` table → direct migration, add tenant_id
- WellMor `companies` table → merge into leads (company_name field), add tenant_id
- WellMor `clients` table → was duplicate of companies, merge into leads

**Status flow (configurable per vertical):**

Tree Service: `new_lead → estimate_given → won → completed → lost`
Benefits: `new_lead → qualified → meeting_scheduled → proposal_sent → won → lost`

---

### contacts

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `lead_id` | UUID FK → leads | Nullable — standalone contacts exist |
| `name` | TEXT NOT NULL | |
| `email` | TEXT | |
| `phone` | TEXT | |
| `title` | TEXT | "HR Director", "Realtor" |
| `company` | TEXT | |
| `contact_type` | TEXT | "customer", "referral_partner", "prospect" |
| `outreach_status` | TEXT | For drip contacts: active, paused, completed, bounced |
| `drip_stage` | INTEGER DEFAULT 0 | Current outreach stage |
| `last_contacted_at` | TIMESTAMPTZ | |
| `notes` | TEXT | |
| `metadata` | JSONB DEFAULT '{}' | Flexible — buyer_persona, department, etc. |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Purpose:** Individual people. Can be customers, referral partners, or outreach targets.
**Relationships:** Belongs to lead (optional). Has many messages, outreach_campaigns.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:**
- AKA `outreach_contacts` → contacts with contact_type='referral_partner'
- WellMor `contacts` → contacts with metadata for buyer_persona, department

---

### content_drafts

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `content_type` | TEXT | "carousel", "single_post", "article", "ad_copy" |
| `platform` | TEXT | "linkedin", "instagram", "facebook", "threads" |
| `status` | TEXT DEFAULT 'draft' | draft, approved, rejected, posted, scheduled |
| `headline` | TEXT | |
| `body` | TEXT | Post copy |
| `hashtags` | TEXT[] | |
| `image_urls` | TEXT[] | Array of image paths/URLs |
| `campaign_payload` | JSONB | Full carousel/campaign data |
| `format_template` | TEXT | Which format template was used |
| `topic` | TEXT | Content topic/pillar |
| `scheduled_for` | TIMESTAMPTZ | When to publish |
| `posted_at` | TIMESTAMPTZ | When actually published |
| `buffer_post_id` | TEXT | Buffer reference |
| `approved_by` | UUID FK → tenant_users | |
| `rejected_reason` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Purpose:** Content pipeline from generation to publication.
**Relationships:** Approved by tenant_user.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:**
- AKA `content_drafts` → rename to content_drafts, add tenant_id
- WellMor `content_queue` → merge into content_drafts, add tenant_id

---

### outreach_campaigns

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `contact_id` | UUID FK → contacts | |
| `campaign_type` | TEXT | "drip_email", "sms_sequence", "follow_up" |
| `status` | TEXT DEFAULT 'active' | active, paused, completed, failed |
| `current_step` | INTEGER DEFAULT 0 | |
| `total_steps` | INTEGER | |
| `next_send_at` | TIMESTAMPTZ | |
| `last_sent_at` | TIMESTAMPTZ | |
| `metadata` | JSONB DEFAULT '{}' | Campaign-specific data |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Purpose:** Tracks multi-step outreach sequences (email drips, SMS follow-ups).
**Relationships:** Belongs to contact. Has many messages.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:**
- AKA `outreach_contacts.drip_stage` → outreach_campaigns
- WellMor `outreach_campaigns` → direct migration

---

### messages

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `contact_id` | UUID FK → contacts | |
| `campaign_id` | UUID FK → outreach_campaigns | Nullable |
| `channel` | TEXT NOT NULL | "sms", "email", "push" |
| `direction` | TEXT NOT NULL | "outbound", "inbound" |
| `subject` | TEXT | Email subject |
| `body` | TEXT | Message content |
| `status` | TEXT DEFAULT 'sent' | sent, delivered, failed, bounced, opened, replied |
| `reply_classification` | TEXT | "interested", "not_interested", "ooo", "unsubscribe" |
| `external_id` | TEXT | Telnyx SID, email message-id |
| `sent_at` | TIMESTAMPTZ | |
| `opened_at` | TIMESTAMPTZ | |
| `clicked_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |

**Purpose:** All communications — SMS, email, push. Single source of truth.
**Relationships:** Belongs to contact, optionally to campaign.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:**
- AKA automation_logs (SMS records) → messages with channel='sms'
- AKA outreach emails → messages with channel='email'
- WellMor emails table → merge into messages

---

### jobs

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `lead_id` | UUID FK → leads | |
| `status` | TEXT DEFAULT 'scheduled' | scheduled, in_progress, completed, cancelled |
| `scheduled_date` | DATE | |
| `completed_date` | DATE | |
| `description` | TEXT | |
| `revenue` | DECIMAL | |
| `notes` | TEXT | |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Purpose:** Tracks actual work performed for a lead.
**Relationships:** Belongs to lead. Has many job_photos.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:** AKA tracks jobs implicitly via lead status. This makes it explicit.

---

### job_photos

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `job_id` | UUID FK → jobs | |
| `lead_id` | UUID FK → leads | Denormalized for easier queries |
| `photo_type` | TEXT | "before", "after", "extra" |
| `storage_path` | TEXT | Supabase Storage path |
| `public_url` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

**Purpose:** Before/after photos for completed work. Used by content engine.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:** AKA `job_photos` → direct migration, add tenant_id.

---

### meetings

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `contact_id` | UUID FK → contacts | |
| `lead_id` | UUID FK → leads | Nullable |
| `external_id` | TEXT | Calendly event ID |
| `scheduled_at` | TIMESTAMPTZ | |
| `duration_minutes` | INTEGER | |
| `meeting_type` | TEXT | "discovery", "estimate", "follow_up" |
| `status` | TEXT DEFAULT 'scheduled' | scheduled, completed, cancelled, no_show |
| `briefing` | JSONB | AI-generated meeting prep |
| `outcome` | TEXT | |
| `notes` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

**Purpose:** Calendar events with AI-generated briefings.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:** WellMor `meetings` + `meeting_briefings` → merged into single table.

---

### finance_entries

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `entry_type` | TEXT NOT NULL | "income", "expense" |
| `category` | TEXT | From tenant_config.finance_categories |
| `amount` | DECIMAL NOT NULL | |
| `description` | TEXT | |
| `date` | DATE NOT NULL | |
| `lead_id` | UUID FK → leads | For income tied to jobs |
| `recurring` | BOOLEAN DEFAULT false | |
| `metadata` | JSONB DEFAULT '{}' | |
| `created_at` | TIMESTAMPTZ | |

**Purpose:** Income and expense tracking. Simplified from AKA's separate tables.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:**
- AKA `income_entries` → finance_entries with entry_type='income'
- AKA `expense_entries` → finance_entries with entry_type='expense'

---

### crew_members

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `name` | TEXT NOT NULL | |
| `role` | TEXT | "climber", "groundsman", "foreman" |
| `daily_rate` | DECIMAL | |
| `phone` | TEXT | |
| `status` | TEXT DEFAULT 'active' | active, inactive |
| `created_at` | TIMESTAMPTZ | |

**Purpose:** Field crew management (primarily tree service vertical).
**Tenant isolation:** RLS on tenant_id.
**Migration notes:** AKA `crew_members` → direct migration.

---

### marketing_performance

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `channel` | TEXT | "google_ads", "facebook_ads", "linkedin_ads" |
| `date` | DATE | |
| `impressions` | INTEGER | |
| `clicks` | INTEGER | |
| `conversions` | INTEGER | |
| `spend` | DECIMAL | |
| `revenue` | DECIMAL | |
| `metadata` | JSONB DEFAULT '{}' | |
| `created_at` | TIMESTAMPTZ | |

**Purpose:** Ad performance tracking and ROI analysis.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:** WellMor `marketing_performance` → add tenant_id.

---

## 4. System Tables (tenant_id required)

### agent_activity_log

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `agent_name` | TEXT NOT NULL | "speed-to-lead", "prospecting", etc. |
| `action` | TEXT NOT NULL | "sms_sent", "email_sent", "lead_scored", etc. |
| `status` | TEXT | "success", "failed", "skipped" |
| `records_affected` | INTEGER DEFAULT 0 | |
| `duration_ms` | INTEGER | |
| `details` | JSONB DEFAULT '{}' | Agent-specific result data |
| `error` | TEXT | Error message if failed |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Purpose:** Audit trail for all agent activity. Used by digest agent and debugging.
**Tenant isolation:** RLS on tenant_id.
**Migration notes:** Both systems have this. Merge and standardize.

---

### agent_jobs

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `agent_name` | TEXT NOT NULL | |
| `status` | TEXT DEFAULT 'pending' | pending, processing, completed, failed |
| `payload` | JSONB DEFAULT '{}' | Input data for the agent |
| `result` | JSONB | Output data from the agent |
| `error` | TEXT | |
| `priority` | INTEGER DEFAULT 0 | Higher = run first |
| `scheduled_for` | TIMESTAMPTZ | For delayed execution |
| `started_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |

**Purpose:** Job queue. API writes jobs, Worker processes them.
**Tenant isolation:** RLS on tenant_id (worker uses service key to read all).
**Migration notes:** New table. Replaces n8n webhook-based job dispatch.

---

### idempotency_keys

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `tenant_id` | UUID FK → tenants | |
| `key` | TEXT NOT NULL | "sms:{contact_id}:speed_to_lead" |
| `action` | TEXT NOT NULL | "send_sms", "send_email", "publish_post" |
| `result` | JSONB | Cached result of the action |
| `expires_at` | TIMESTAMPTZ | Auto-cleanup after 30 days |
| `created_at` | TIMESTAMPTZ DEFAULT now() | |
| UNIQUE | (tenant_id, key) | |

**Purpose:** Prevents duplicate external actions (SMS, emails, posts).
**Migration notes:** New table. Fixes critical gap from Phase 1 audit.

**Usage pattern:**
```javascript
async function withIdempotency(tenantId, key, action, fn) {
  const existing = await db.from('idempotency_keys')
    .select('result')
    .eq('tenant_id', tenantId)
    .eq('key', key)
    .single();

  if (existing.data) return existing.data.result; // Already done

  const result = await fn();

  await db.from('idempotency_keys').insert({
    tenant_id: tenantId, key, action, result,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  });

  return result;
}
```

---

### system_config

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `key` | TEXT UNIQUE NOT NULL | Platform-wide config key |
| `value` | JSONB NOT NULL | |

**Purpose:** Platform-level config (not tenant-specific). Default AI models, platform limits, feature gates.
**RLS:** Platform admin only.

---

## 5. RLS Strategy

### Policy Pattern

Every business table gets the same RLS policy:

```sql
-- Enable RLS
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policy
CREATE POLICY tenant_isolation ON leads
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Service role bypass (for worker/admin operations)
CREATE POLICY service_bypass ON leads
  FOR ALL
  TO service_role
  USING (true);
```

### How tenant_id gets set

```javascript
// api/middleware/tenant.js
async function tenantMiddleware(req, res, next) {
  const tenantId = req.user.app_metadata?.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'No tenant' });

  // Set for RLS
  await supabase.rpc('set_tenant', { tid: tenantId });
  // Or: await supabase.query("SET LOCAL app.tenant_id = $1", [tenantId]);

  req.tenantId = tenantId;
  next();
}
```

### Worker context

The worker uses the Supabase service key (bypasses RLS) but explicitly includes `tenant_id` in all queries:

```javascript
// Worker always filters explicitly
const { data: leads } = await supabase
  .from('leads')
  .select('*')
  .eq('tenant_id', tenantId)
  .eq('status', 'new_lead');
```

---

## 6. Config Storage Approach

### Layered Config Resolution

```
Platform defaults (code) → Vertical preset (code) → tenant_config (DB) → module config (DB)
```

### Why JSONB for config values?

Config values vary widely:
- `business_name` = simple string
- `brand_colors` = object with primary/secondary
- `sms_templates` = object with multiple templates
- `content_formats` = array of complex format objects
- `scoring_rules` = object with thresholds

JSONB handles all of these in one column. The application layer validates with schemas.

### Config validation

```javascript
// config/schemas.js (Joi or Zod)
const configSchemas = {
  business_name: Joi.string().required(),
  phone: Joi.string().pattern(/^\+\d{10,15}$/),
  brand_colors: Joi.object({ primary: Joi.string(), secondary: Joi.string() }),
  sms_templates: Joi.object().pattern(Joi.string(), Joi.string()),
  // ...
};
```

---

## 7. Audit Logging Strategy

### What gets logged

| Event | Table | Details |
|-------|-------|---------|
| Agent runs | `agent_activity_log` | Agent name, action, duration, result |
| SMS/email sent | `messages` + `agent_activity_log` | Full message record + agent log entry |
| Content state changes | `content_drafts` | Status field tracks lifecycle |
| Lead status changes | `leads.updated_at` | Timestamp tracks last change |
| Config changes | Deferred | Not tracked in Phase 3 (add audit table later) |
| User actions | Deferred | Not tracked in Phase 3 (add audit table later) |

### Deferred Enhancement: Full audit table

```sql
-- Future: comprehensive audit trail
CREATE TABLE audit_log (
  id UUID PK,
  tenant_id UUID FK,
  user_id UUID FK,
  table_name TEXT,
  record_id UUID,
  action TEXT,          -- insert, update, delete
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMPTZ
);
```

This can be implemented as a Postgres trigger on sensitive tables. Deferred because it's not required for MVP.

---

## 8. Entity Relationship Diagram (Simplified)

```
tenants
  ├── tenant_users
  ├── tenant_config
  ├── tenant_modules
  ├── tenant_integrations
  │
  ├── leads
  │   ├── contacts
  │   ├── jobs
  │   │   └── job_photos
  │   └── meetings
  │
  ├── contacts
  │   ├── outreach_campaigns
  │   └── messages
  │
  ├── content_drafts
  ├── finance_entries
  ├── crew_members
  ├── marketing_performance
  │
  ├── agent_activity_log
  ├── agent_jobs
  └── idempotency_keys
```

---

## 9. Open Questions

| # | Question | Impact | Default |
|---|----------|--------|---------|
| 1 | Should `tenant_config` use key-value rows or a single JSONB column? | Query patterns | Key-value rows (easier to update individual settings) |
| 2 | How to handle tenant deletion? | Data retention | Soft delete (status='cancelled'), retain data 90 days |
| 3 | Should messages store full body or reference templates? | Storage vs auditability | Store full body (need audit trail of what was actually sent) |
| 4 | File storage: Supabase Storage per tenant or shared bucket with tenant prefix? | Isolation | Shared bucket with `{tenant_id}/` prefix |
| 5 | Should finance tables exist for all verticals or only tree_service? | Module scope | Gate behind `finance` module — only enabled for verticals that need it |
